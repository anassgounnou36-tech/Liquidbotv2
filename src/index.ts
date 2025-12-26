import { ethers } from 'ethers';
import { loadConfig, getConfig, watchConfig, validateConfig, onConfigChange } from './config/env';
import logger from './logging/logger';
import { borrowerRegistry } from './state/registry';
import { BorrowerState } from './state/borrower';
import { priceAggregator } from './prices';
import { AaveEventListener } from './aave/events';
import { calculateBorrowerHF } from './hf/calc';
import { simulateLiquidation, getOracleHealthFactor } from './execution/sim';
import { buildLiquidationTx, signTransaction } from './execution/tx';
import { broadcastTransaction, waitForTransaction } from './execution/broadcast';

// Global state
let provider: ethers.JsonRpcProvider;
let signer: ethers.Wallet | null = null;
let aaveEventListener: AaveEventListener;
let blockLoopInterval: NodeJS.Timeout | null = null;
let activeLiquidations = 0;

// Initialize bot
async function initialize(): Promise<void> {
  logger.info('=== Aave v3 Liquidation Bot Starting ===');
  
  // Load configuration
  loadConfig();
  validateConfig();
  
  const config = getConfig();
  
  // Log configuration
  logger.info('Configuration loaded', {
    chain: config.chainId,
    dryRun: config.dryRun,
    enableExecution: config.enableExecution,
    relayMode: config.relayMode,
    hfWatch: config.hfWatch,
    hfCritical: config.hfCritical,
    hfLiquidatable: config.hfLiquidatable
  });
  
  // Initialize provider
  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  
  // Test provider connection
  try {
    const network = await provider.getNetwork();
    logger.info('Connected to network', {
      chainId: network.chainId.toString(),
      name: network.name
    });
    
    if (Number(network.chainId) !== config.chainId) {
      throw new Error(`Chain ID mismatch: expected ${config.chainId}, got ${network.chainId}`);
    }
  } catch (error) {
    logger.error('Failed to connect to provider', { error });
    throw error;
  }
  
  // Initialize signer if private key provided
  if (config.signerPk && !config.dryRun && config.enableExecution) {
    try {
      signer = new ethers.Wallet(config.signerPk, provider);
      logger.info('Signer initialized', { address: signer.address });
    } catch (error) {
      logger.error('Failed to initialize signer', { error });
      throw error;
    }
  } else {
    logger.info('Running without signer (dry run mode)');
  }
  
  // Initialize price aggregator
  priceAggregator.initialize();
  
  // Listen for price updates
  priceAggregator.on('priceUpdate', (priceData) => {
    handlePriceUpdate(priceData.asset);
  });
  
  // Initialize Aave event listener
  aaveEventListener = new AaveEventListener(provider);
  
  // Listen for borrower updates from events
  aaveEventListener.on('borrowerUpdated', (address: string) => {
    handleBorrowerUpdate(address);
  });
  
  await aaveEventListener.startListening();
  
  // Watch .env for hot-reload
  watchConfig();
  
  // Register config change handler
  onConfigChange(() => {
    logger.info('Configuration changed, updating thresholds');
    // HF thresholds and other params are automatically updated
  });
  
  logger.info('=== Bot Initialized Successfully ===');
}

// Start block loop
function startBlockLoop(): void {
  const config = getConfig();
  
  logger.info('Starting block loop', {
    interval: config.blockPollInterval
  });
  
  blockLoopInterval = setInterval(async () => {
    try {
      await processBlock();
    } catch (error) {
      logger.error('Error in block loop', { error });
    }
  }, config.blockPollInterval);
}

// Process each block (light operations only)
async function processBlock(): Promise<void> {
  try {
    const blockNumber = await provider.getBlockNumber();
    const feeData = await provider.getFeeData();
    
    logger.debug('Processing block', {
      blockNumber,
      baseFee: feeData.maxFeePerGas?.toString()
    });
    
    // Get WATCH and CRITICAL borrowers only
    const watchBorrowers = borrowerRegistry.getBorrowersByStates([
      BorrowerState.WATCH,
      BorrowerState.CRITICAL
    ]);
    
    // Recompute HF for WATCH and CRITICAL borrowers using cached prices only
    const prices = priceAggregator.getAllPrices();
    
    for (const borrower of watchBorrowers) {
      if (prices.size === 0) continue;
      
      const newHF = calculateBorrowerHF(borrower, prices);
      
      // Update HF and potentially transition state
      borrowerRegistry.updateBorrowerHF(borrower.address, newHF);
      
      // Note: prepareLiquidation is NO LONGER called here (moved to event-driven handlers)
      
      // If transitioned to LIQUIDATABLE, execute
      if (borrower.state === BorrowerState.LIQUIDATABLE) {
        await executeLiquidation(borrower.address);
      }
    }
    
    // Log stats periodically (every 100 blocks)
    if (blockNumber % 100 === 0) {
      const stats = borrowerRegistry.getStats();
      const priceStatus = priceAggregator.getStatus();
      const stalenessInfo = priceAggregator.getStalenessInfo();
      
      logger.info('Bot statistics', {
        blockNumber,
        borrowers: stats,
        priceFeeds: priceStatus,
        priceStaleness: stalenessInfo,
        activeLiquidations
      });
    }
  } catch (error) {
    logger.error('Error processing block', { error });
  }
}

// Handle price update (event-driven)
function handlePriceUpdate(asset: string): void {
  const prices = priceAggregator.getAllPrices();
  
  // Find all borrowers affected by this asset
  const allBorrowers = borrowerRegistry.getAllBorrowers();
  
  for (const borrower of allBorrowers) {
    // Check if borrower has this asset
    const hasAsset = borrower.collateralBalances.some(b => b.asset === asset) ||
                    borrower.debtBalances.some(b => b.asset === asset);
    
    if (!hasAsset) continue;
    
    // Recompute HF
    const newHF = calculateBorrowerHF(borrower, prices);
    
    // Update HF and potentially transition state
    borrowerRegistry.updateBorrowerHF(borrower.address, newHF);
    
    // Handle state-specific actions
    if (borrower.state === BorrowerState.CRITICAL && !borrower.cachedTx) {
      prepareLiquidation(borrower.address).catch(error => {
        logger.error('Error preparing liquidation on price update', { error });
      });
    }
  }
}

// Handle borrower update from Aave events
function handleBorrowerUpdate(address: string): void {
  const borrower = borrowerRegistry.getBorrower(address);
  if (!borrower) return;
  
  const prices = priceAggregator.getAllPrices();
  if (prices.size === 0) return;
  
  // Recompute HF
  const newHF = calculateBorrowerHF(borrower, prices);
  
  // Update HF and potentially transition state
  borrowerRegistry.updateBorrowerHF(borrower.address, newHF);
  
  // Handle state-specific actions
  if (borrower.state === BorrowerState.CRITICAL && !borrower.cachedTx) {
    prepareLiquidation(borrower.address).catch(error => {
      logger.error('Error preparing liquidation on borrower update', { error });
    });
  }
}

// Prepare liquidation (CRITICAL state)
async function prepareLiquidation(borrowerAddress: string): Promise<void> {
  const config = getConfig();
  const borrower = borrowerRegistry.getBorrower(borrowerAddress);
  
  if (!borrower || borrower.state !== BorrowerState.CRITICAL) {
    return;
  }
  
  // Try to acquire lock for this borrower
  if (!borrowerRegistry.tryAcquireLock(borrowerAddress)) {
    logger.debug('Borrower already being processed, skipping preparation', {
      borrower: borrowerAddress
    });
    return;
  }
  
  try {
    // Check price staleness before preparation
    if (priceAggregator.isPriceStale(config.priceStaleMs)) {
      const stalenessInfo = priceAggregator.getStalenessInfo();
      logger.warn('Price data is stale, aborting preparation', {
        borrower: borrowerAddress,
        stalenessInfo
      });
      return;
    }
    
    // Check if feeds are connected
    if (!priceAggregator.areFeedsConnected()) {
      logger.warn('Price feeds disconnected, aborting preparation', {
        borrower: borrowerAddress
      });
      return;
    }
    
    logger.info('Preparing liquidation', {
      borrower: borrowerAddress,
      predictedHF: borrower.predictedHF.toFixed(4)
    });
    
    // Simulate liquidation
    const simResult = await simulateLiquidation(provider, borrower, signer?.address || '');
    
    if (!simResult || !simResult.success) {
      logger.warn('Liquidation simulation failed', {
        borrower: borrowerAddress,
        reason: simResult?.error
      });
      return;
    }
    
    // Log simulation result explicitly
    logger.info('Liquidation simulation succeeded', {
      borrower: borrowerAddress,
      profit: simResult.profitUsd.toFixed(2),
      gas: simResult.gasUsd.toFixed(2),
      oracleHF: simResult.oracleHF.toFixed(4)
    });
    
    // Update oracle HF
    borrower.oracleHF = simResult.oracleHF;
    
    // Build and cache transaction (only if we have a signer)
    if (signer) {
      const cachedTx = await buildLiquidationTx(provider, signer, borrowerAddress, simResult);
      
      if (cachedTx) {
        borrower.cachedTx = cachedTx;
        
        logger.info('Liquidation transaction prepared', {
          borrower: borrowerAddress,
          expectedProfit: cachedTx.expectedProfitUsd.toFixed(2),
          estimatedGas: cachedTx.estimatedGasUsd.toFixed(2)
        });
      }
    } else {
      logger.info('Liquidation simulated successfully (no signer available)', {
        borrower: borrowerAddress,
        expectedProfit: simResult.profitUsd.toFixed(2),
        estimatedGas: simResult.gasUsd.toFixed(2)
      });
    }
  } catch (error) {
    logger.error('Error preparing liquidation', {
      borrower: borrowerAddress,
      error
    });
  } finally {
    // Always release lock
    borrowerRegistry.releaseLock(borrowerAddress);
  }
}

// Execute liquidation (LIQUIDATABLE state)
async function executeLiquidation(borrowerAddress: string): Promise<void> {
  const config = getConfig();
  const borrower = borrowerRegistry.getBorrower(borrowerAddress);
  
  if (!borrower || borrower.state !== BorrowerState.LIQUIDATABLE) {
    return;
  }
  
  // Try to acquire lock for this borrower
  if (!borrowerRegistry.tryAcquireLock(borrowerAddress)) {
    logger.debug('Borrower already being processed, skipping execution', {
      borrower: borrowerAddress
    });
    return;
  }
  
  try {
    // Check price staleness before execution
    if (priceAggregator.isPriceStale(config.priceStaleMs)) {
      const stalenessInfo = priceAggregator.getStalenessInfo();
      logger.warn('Price data is stale, aborting execution', {
        borrower: borrowerAddress,
        stalenessInfo
      });
      return;
    }
    
    // Check if feeds are connected
    if (!priceAggregator.areFeedsConnected()) {
      logger.warn('Price feeds disconnected, aborting execution', {
        borrower: borrowerAddress
      });
      return;
    }
    
    // Check concurrent tx limit
    if (activeLiquidations >= config.maxConcurrentTx) {
      logger.debug('Max concurrent liquidations reached', {
        active: activeLiquidations,
        max: config.maxConcurrentTx
      });
      return;
    }
    
    // Verify oracle HF (final confirmation)
    const oracleHF = await getOracleHealthFactor(provider, borrowerAddress);
    borrower.oracleHF = oracleHF;
    
    if (oracleHF > config.hfLiquidatable) {
      logger.warn('Oracle HF above liquidatable threshold, skipping', {
        borrower: borrowerAddress,
        oracleHF: oracleHF.toFixed(4)
      });
      return;
    }
    
    // Check if we have cached tx
    if (!borrower.cachedTx) {
      logger.warn('No cached transaction for liquidatable borrower', {
        borrower: borrowerAddress
      });
      await prepareLiquidation(borrowerAddress);
      return;
    }
    
    // Verify profitability and gas
    if (borrower.cachedTx.expectedProfitUsd < config.minProfitUsd) {
      logger.warn('Profit below minimum, skipping', {
        borrower: borrowerAddress,
        profit: borrower.cachedTx.expectedProfitUsd.toFixed(2),
        minProfit: config.minProfitUsd
      });
      return;
    }
    
    if (borrower.cachedTx.estimatedGasUsd > config.maxGasUsd) {
      logger.warn('Gas above maximum, skipping', {
        borrower: borrowerAddress,
        gas: borrower.cachedTx.estimatedGasUsd.toFixed(2),
        maxGas: config.maxGasUsd
      });
      return;
    }
    
    // Check if execution is enabled
    if (!config.enableExecution || config.dryRun) {
      logger.info('DRY RUN: Would execute liquidation', {
        borrower: borrowerAddress,
        expectedProfit: borrower.cachedTx.expectedProfitUsd.toFixed(2),
        oracleHF: oracleHF.toFixed(4)
      });
      return;
    }
    
    if (!signer) {
      logger.error('Cannot execute: signer not available');
      return;
    }
    
    logger.info('Executing liquidation', {
      borrower: borrowerAddress,
      expectedProfit: borrower.cachedTx.expectedProfitUsd.toFixed(2),
      oracleHF: oracleHF.toFixed(4)
    });
    
    activeLiquidations++;
    
    // Sign transaction
    const signedTx = await signTransaction(signer, borrower.cachedTx);
    
    // Broadcast transaction
    const tx = await broadcastTransaction(provider, signedTx);
    
    if (tx) {
      logger.info('Liquidation transaction sent', {
        borrower: borrowerAddress,
        txHash: tx.hash
      });
      
      // Wait for confirmation
      const receipt = await waitForTransaction(provider, tx.hash);
      
      if (receipt && receipt.status === 1) {
        logger.info('Liquidation successful', {
          borrower: borrowerAddress,
          txHash: tx.hash,
          gasUsed: receipt.gasUsed.toString()
        });
      } else {
        logger.error('Liquidation failed', {
          borrower: borrowerAddress,
          txHash: tx.hash
        });
      }
    }
  } catch (error) {
    logger.error('Error executing liquidation', {
      borrower: borrowerAddress,
      error
    });
  } finally {
    activeLiquidations--;
    // Always release lock
    borrowerRegistry.releaseLock(borrowerAddress);
  }
}

// Shutdown handler
async function shutdown(): Promise<void> {
  logger.info('Shutting down bot...');
  
  // Stop block loop
  if (blockLoopInterval) {
    clearInterval(blockLoopInterval);
  }
  
  // Stop event listeners
  if (aaveEventListener) {
    aaveEventListener.stopListening();
  }
  
  // Disconnect price feeds
  priceAggregator.disconnect();
  
  logger.info('Bot shut down successfully');
  process.exit(0);
}

// Main entry point
async function main(): Promise<void> {
  try {
    // Handle signals
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
    // Initialize
    await initialize();
    
    // Start block loop
    startBlockLoop();
    
    logger.info('=== Bot Running ===');
  } catch (error) {
    logger.error('Fatal error', { error });
    process.exit(1);
  }
}

// Start the bot
main();

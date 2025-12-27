import { ethers } from 'ethers';
import { loadConfig, getConfig, watchConfig, validateConfig, onConfigChange } from './config/env';
import logger from './logging/logger';
import { borrowerRegistry } from './state/registry';
import { BorrowerState } from './state/borrower';
import { priceAggregator } from './prices';
import { AaveEventListener } from './aave/events';
import { calculateBorrowerHF } from './hf/calc';
import { simulateLiquidation, getOracleHealthFactor, getTotalDebtUSD } from './execution/sim';
import { buildLiquidationTx, signTransaction } from './execution/tx';
import { broadcastTransaction, waitForTransaction } from './execution/broadcast';
import { simulateFlashLiquidation, executeFlashLiquidation } from './execution/flash';
import { sendTelegram } from './notify/telegram';
import { getAaveAddresses, AAVE_POOL_ABI, ERC20_ABI } from './aave/addresses';
import { getTokenAddress } from './tokens';

// Global state
let provider: ethers.JsonRpcProvider;
let signer: ethers.Wallet | null = null;
let aaveEventListener: AaveEventListener;
let blockLoopInterval: NodeJS.Timeout | null = null;
let activeLiquidations = 0;
let seedScanCompleted = false; // Track if seed scan has run

// Startup seed scan: scan historical Borrow events once
async function seedBorrowersOnce(): Promise<void> {
  if (seedScanCompleted) {
    logger.warn('Seed scan already completed, skipping');
    return;
  }
  
  const config = getConfig();
  const addresses = getAaveAddresses();
  
  logger.info('=== Starting Seed Scan ===', {
    lookbackBlocks: config.seedLookbackBlocks,
    maxCandidates: config.maxCandidates,
    minDebtUsd: config.minDebtUsd
  });
  
  try {
    const currentBlock = await provider.getBlockNumber();
    const startBlock = Math.max(0, currentBlock - config.seedLookbackBlocks);
    const totalBlocks = currentBlock - startBlock;
    
    // Batch size for queryFilter (to avoid provider limits)
    const BATCH_SIZE = 2000;
    
    const poolContract = new ethers.Contract(
      addresses.pool,
      AAVE_POOL_ABI,
      provider
    );
    
    // Track unique borrowers
    const uniqueBorrowers = new Set<string>();
    let blocksScanned = 0;
    let lastProgressPct = 0;
    
    // Query in batches
    for (let fromBlock = startBlock; fromBlock <= currentBlock; fromBlock += BATCH_SIZE) {
      const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, currentBlock);
      
      try {
        // Query Borrow events
        const filter = poolContract.filters.Borrow();
        const events = await poolContract.queryFilter(filter, fromBlock, toBlock);
        
        // Extract borrower addresses
        for (const event of events) {
          // TypeScript check for EventLog
          if ('args' in event && event.args && event.args.onBehalfOf) {
            uniqueBorrowers.add(event.args.onBehalfOf.toLowerCase());
          }
        }
        
        blocksScanned += (toBlock - fromBlock + 1);
        
        // Progress reporting at 20%, 40%, 60%, 80%, 100%
        const progressPct = Math.floor((blocksScanned / totalBlocks) * 100);
        if (progressPct >= lastProgressPct + 20 || blocksScanned === totalBlocks) {
          logger.info(`[seed] ${progressPct}% complete | borrowers_found=${uniqueBorrowers.size} | blocks_scanned=${blocksScanned}/${totalBlocks}`);
          lastProgressPct = progressPct;
        }
        
        // Early stop: if we've found MAX_CANDIDATES, stop immediately
        if (uniqueBorrowers.size >= config.maxCandidates) {
          logger.info(`[seed] stopped early — max candidates reached (${config.maxCandidates}) | blocks_scanned=${blocksScanned}/${totalBlocks}`);
          break;
        }
      } catch (error) {
        logger.error('Error querying Borrow events in batch', {
          fromBlock,
          toBlock,
          error
        });
        // Continue to next batch on error
      }
    }
    
    logger.info(`[seed] Scan complete. Found ${uniqueBorrowers.size} unique borrowers`);
    
    // Now process each borrower: fetch balances, compute totalDebtUSD, filter by MIN_DEBT_USD
    let addedCount = 0;
    let filteredCount = 0;
    
    for (const borrowerAddress of uniqueBorrowers) {
      try {
        // Add borrower temporarily to registry (not hydrated, from seed scan)
        const borrower = borrowerRegistry.addBorrower(borrowerAddress, BorrowerState.SAFE, false);
        
        // Fetch on-chain balances
        await updateBorrowerBalancesForSeed(borrowerAddress);
        
        // Compute totalDebtUSD using oracle prices
        const totalDebtUSD = await getTotalDebtUSD(provider, borrower);
        
        if (totalDebtUSD < config.minDebtUsd) {
          // Remove from registry
          borrowerRegistry.removeBorrower(borrowerAddress);
          filteredCount++;
        } else {
          addedCount++;
        }
      } catch (error) {
        logger.error('Error processing borrower in seed scan', {
          borrower: borrowerAddress,
          error
        });
        // Remove on error - but log as warning, don't throw
        borrowerRegistry.removeBorrower(borrowerAddress);
      }
    }
    
    logger.info('=== Seed Scan Complete ===', {
      totalFound: uniqueBorrowers.size,
      added: addedCount,
      filtered: filteredCount,
      minDebtUsd: config.minDebtUsd
    });
    
    // Send Telegram notification (optional)
    const message = `✅ Seed Scan Complete
Total Borrowers Found: ${uniqueBorrowers.size}
Added to Registry: ${addedCount}
Filtered (below MIN_DEBT_USD): ${filteredCount}
MIN_DEBT_USD: $${config.minDebtUsd}`;
    
    sendTelegram(message).catch(error => {
      logger.debug('Failed to send Telegram seed completion', { error });
    });
    
    seedScanCompleted = true;
  } catch (error) {
    logger.error('Fatal error in seed scan', { error });
    seedScanCompleted = true; // Mark as completed to avoid retry
  }
}

// Helper function to update borrower balances during seed scan
async function updateBorrowerBalancesForSeed(userAddress: string): Promise<void> {
  const borrower = borrowerRegistry.getBorrower(userAddress);
  if (!borrower) {
    return;
  }
  
  const config = getConfig();
  const addresses = getAaveAddresses();
  
  const poolContract = new ethers.Contract(
    addresses.pool,
    AAVE_POOL_ABI,
    provider
  );
  
  // Fetch collateral balances
  const collateralBalances = [];
  for (const asset of config.targetCollateralAssets) {
    try {
      const assetAddress = getTokenAddress(asset);
      const reserveData = await poolContract.getReserveData(assetAddress);
      const aTokenAddress = reserveData.aTokenAddress;
      
      const aTokenContract = new ethers.Contract(aTokenAddress, ERC20_ABI, provider);
      const balance = await aTokenContract.balanceOf(userAddress);
      
      if (balance > 0n) {
        collateralBalances.push({
          asset,
          amount: balance,
          valueUsd: 0
        });
      }
    } catch (error) {
      logger.error('Error fetching collateral balance in seed', { asset, error });
    }
  }
  
  // Fetch debt balances
  const debtBalances = [];
  for (const asset of config.targetDebtAssets) {
    try {
      const assetAddress = getTokenAddress(asset);
      const reserveData = await poolContract.getReserveData(assetAddress);
      const debtTokenAddress = reserveData.variableDebtTokenAddress;
      
      const debtTokenContract = new ethers.Contract(debtTokenAddress, ERC20_ABI, provider);
      const balance = await debtTokenContract.balanceOf(userAddress);
      
      if (balance > 0n) {
        debtBalances.push({
          asset,
          amount: balance,
          valueUsd: 0
        });
      }
    } catch (error) {
      logger.error('Error fetching debt balance in seed', { asset, error });
    }
  }
  
  // Update borrower
  borrower.collateralBalances = collateralBalances;
  borrower.debtBalances = debtBalances;
}

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
      
      // Skip HF recomputation if borrower is not hydrated yet
      if (!borrower.hydrated) {
        logger.debug('Skipping HF recomputation for non-hydrated borrower', {
          borrower: borrower.address
        });
        continue;
      }
      
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
    
    // Skip HF recomputation if borrower is not hydrated yet
    if (!borrower.hydrated) {
      logger.debug('Skipping HF recomputation for non-hydrated borrower on price update', {
        borrower: borrower.address,
        asset
      });
      continue;
    }
    
    // Recompute HF
    const newHF = calculateBorrowerHF(borrower, prices);
    
    // Invalidate cached tx on price change for CRITICAL/LIQUIDATABLE borrowers
    if ((borrower.state === BorrowerState.CRITICAL || borrower.state === BorrowerState.LIQUIDATABLE) && 
        borrower.cachedTx) {
      borrowerRegistry.invalidateCachedTx(borrower.address, `Price change for ${asset}`);
    }
    
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
  
  // Skip HF recomputation if borrower is not hydrated yet
  if (!borrower.hydrated) {
    logger.debug('Skipping HF recomputation for non-hydrated borrower on event', {
      borrower: borrower.address
    });
    return;
  }
  
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
  
  // Check MIN_DEBT_USD before preparing
  const totalDebtUSD = await getTotalDebtUSD(provider, borrower);
  if (totalDebtUSD < config.minDebtUsd) {
    logger.info('Skipping preparation: debt below MIN_DEBT_USD', {
      borrower: borrowerAddress,
      totalDebtUSD: totalDebtUSD.toFixed(2),
      minDebtUsd: config.minDebtUsd
    });
    borrowerRegistry.updateSkipReason(borrowerAddress, 'below_min_debt');
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
    
    // Check if FlashLiquidator is configured - use flash loan based execution
    const useFlashLoan = !!config.flashLiquidatorAddress;
    
    if (useFlashLoan) {
      // Simulate flash liquidation with exact flow (including Balancer callback)
      const flashSimResult = await simulateFlashLiquidation(provider, borrower, signer?.address || '');
      
      if (!flashSimResult || !flashSimResult.success) {
        logger.warn('Flash liquidation simulation failed', {
          borrower: borrowerAddress,
          reason: flashSimResult?.error
        });
        return;
      }
      
      // Log simulation result explicitly
      logger.info('Flash liquidation simulation succeeded', {
        borrower: borrowerAddress,
        profit: flashSimResult.expectedProfit.toFixed(2),
        gas: flashSimResult.gasUsd.toFixed(2),
        debtAsset: flashSimResult.debtAsset,
        collateralAsset: flashSimResult.collateralAsset,
        minAmountOut: flashSimResult.minAmountOut.toString()
      });
      
      // Get current block number for TTL tracking
      const currentBlock = await provider.getBlockNumber();
      
      // Cache the flash simulation result for execution
      borrower.cachedTx = {
        to: config.flashLiquidatorAddress,
        data: '', // Will be built during execution
        value: 0n,
        gasLimit: flashSimResult.gasEstimate,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        expectedProfitUsd: flashSimResult.expectedProfit,
        estimatedGasUsd: flashSimResult.gasUsd,
        preparedAt: Date.now()
      };
      
      // Store flash result and block number for later use
      borrower.flashResult = flashSimResult;
      borrower.preparedBlockNumber = currentBlock;
      borrower.lastPreparedBlock = currentBlock;
      
    } else {
      // Use traditional direct liquidation
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
          // Get current block number for TTL tracking
          const currentBlock = await provider.getBlockNumber();
          
          borrower.cachedTx = cachedTx;
          borrower.preparedBlockNumber = currentBlock;
          borrower.lastPreparedBlock = currentBlock;
          
          logger.info('Liquidation transaction prepared', {
            borrower: borrowerAddress,
            expectedProfit: cachedTx.expectedProfitUsd.toFixed(2),
            estimatedGas: cachedTx.estimatedGasUsd.toFixed(2),
            preparedBlock: currentBlock
          });
        }
      } else {
        logger.info('Liquidation simulated successfully (no signer available)', {
          borrower: borrowerAddress,
          expectedProfit: simResult.profitUsd.toFixed(2),
          estimatedGas: simResult.gasUsd.toFixed(2)
        });
      }
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
  
  // Check MIN_DEBT_USD before executing
  const totalDebtUSD = await getTotalDebtUSD(provider, borrower);
  if (totalDebtUSD < config.minDebtUsd) {
    logger.info('Skipping execution: debt below MIN_DEBT_USD', {
      borrower: borrowerAddress,
      totalDebtUSD: totalDebtUSD.toFixed(2),
      minDebtUsd: config.minDebtUsd
    });
    borrowerRegistry.updateSkipReason(borrowerAddress, 'below_min_debt');
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
    // Track execution attempt
    borrower.lastExecutionAttemptAt = Date.now();
    
    // Check price feed policy (fail-closed: Binance OR Pyth must be live)
    const feedPolicy = priceAggregator.canExecuteLiquidation(config.priceStaleMs);
    if (!feedPolicy.allowed) {
      const feedStatus = priceAggregator.getFeedStatus(config.priceStaleMs);
      logger.warn('Price feed policy check failed, aborting execution', {
        borrower: borrowerAddress,
        reason: feedPolicy.reason,
        feedStatus
      });
      return;
    }
    
    // Check price staleness before execution (additional check)
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
    
    // Check if cached tx exists
    if (!borrower.cachedTx) {
      logger.warn('No cached transaction for liquidatable borrower', {
        borrower: borrowerAddress
      });
      await prepareLiquidation(borrowerAddress);
      return;
    }
    
    // Check if cached tx is stale (beyond TTL)
    const currentBlock = await provider.getBlockNumber();
    if (borrowerRegistry.isCachedTxStale(borrowerAddress, currentBlock)) {
      logger.warn('Cached tx is stale, invalidating and re-preparing', {
        borrower: borrowerAddress,
        preparedBlock: borrower.preparedBlockNumber,
        currentBlock,
        ttl: config.txCacheTtlBlocks
      });
      borrowerRegistry.invalidateCachedTx(borrowerAddress, 'Block TTL exceeded');
      await prepareLiquidation(borrowerAddress);
      return;
    }
    
    // Verify oracle HF (final confirmation) - MUST be done before broadcast
    const oracleHF = await getOracleHealthFactor(provider, borrowerAddress);
    borrower.oracleHF = oracleHF;
    
    logger.info('Oracle HF check before execution', {
      borrower: borrowerAddress,
      oracleHF: oracleHF.toFixed(4),
      liquidatableThreshold: config.hfLiquidatable
    });
    
    if (oracleHF >= 1.0) {
      logger.warn('Oracle HF >= 1.0, cannot execute (not liquidatable on-chain)', {
        borrower: borrowerAddress,
        oracleHF: oracleHF.toFixed(4)
      });
      return;
    }
    
    if (oracleHF > config.hfLiquidatable) {
      logger.warn('Oracle HF above liquidatable threshold, skipping', {
        borrower: borrowerAddress,
        oracleHF: oracleHF.toFixed(4),
        threshold: config.hfLiquidatable
      });
      return;
    }
    
    // Verify profitability and gas (hard profit floor)
    const expectedProfitUsd = borrower.cachedTx.expectedProfitUsd;
    const estimatedGasUsd = borrower.cachedTx.estimatedGasUsd;
    const netProfitUsd = expectedProfitUsd - estimatedGasUsd;
    
    logger.info('Profit check before execution', {
      borrower: borrowerAddress,
      expectedProfitUsd: expectedProfitUsd.toFixed(2),
      estimatedGasUsd: estimatedGasUsd.toFixed(2),
      netProfitUsd: netProfitUsd.toFixed(2),
      minProfitUsd: config.minProfitUsd
    });
    
    // Enforce hard profit floor (net profit after gas must exceed minimum)
    if (netProfitUsd < config.minProfitUsd) {
      logger.warn('Net profit below minimum, aborting execution', {
        borrower: borrowerAddress,
        expectedProfit: expectedProfitUsd.toFixed(2),
        gasUsd: estimatedGasUsd.toFixed(2),
        netProfit: netProfitUsd.toFixed(2),
        minProfit: config.minProfitUsd,
        reason: 'Net profit (after gas) < MIN_PROFIT_USD'
      });
      borrowerRegistry.updateSkipReason(borrowerAddress, 'profit_floor');
      return;
    }
    
    if (borrower.cachedTx.expectedProfitUsd < config.minProfitUsd) {
      logger.warn('Expected profit below minimum, skipping', {
        borrower: borrowerAddress,
        profit: borrower.cachedTx.expectedProfitUsd.toFixed(2),
        minProfit: config.minProfitUsd
      });
      borrowerRegistry.updateSkipReason(borrowerAddress, 'profit_floor');
      return;
    }
    
    if (borrower.cachedTx.estimatedGasUsd > config.maxGasUsd) {
      logger.warn('Gas above maximum, skipping', {
        borrower: borrowerAddress,
        gas: borrower.cachedTx.estimatedGasUsd.toFixed(2),
        maxGas: config.maxGasUsd
      });
      borrowerRegistry.updateSkipReason(borrowerAddress, 'gas_guard');
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
      estimatedGas: borrower.cachedTx.estimatedGasUsd.toFixed(2),
      netProfit: netProfitUsd.toFixed(2),
      oracleHF: oracleHF.toFixed(4)
    });
    
    activeLiquidations++;
    
    // Check if using flash loan based execution
    const useFlashLoan = !!config.flashLiquidatorAddress;
    const flashResult = borrower.flashResult;
    
    if (useFlashLoan && flashResult && flashResult.success) {
      // Log 1inch swap details
      logger.info('Executing flash liquidation with 1inch swap', {
        borrower: borrowerAddress,
        fromAsset: flashResult.collateralAsset,
        toAsset: flashResult.debtAsset,
        debtAmount: flashResult.debtAmount.toString(),
        minAmountOut: flashResult.minAmountOut.toString(),
        slippageBps: config.maxSlippageBps,
        oneInchDataLength: flashResult.oneInchData.length
      });
      
      // Execute flash liquidation
      const tx = await executeFlashLiquidation(provider, signer, borrowerAddress, flashResult);
      
      if (tx) {
        logger.info('Flash liquidation transaction sent', {
          borrower: borrowerAddress,
          txHash: tx.hash
        });
        
        // Wait for confirmation
        const receipt = await waitForTransaction(provider, tx.hash);
        
        if (receipt && receipt.status === 1) {
          logger.info('Flash liquidation successful', {
            borrower: borrowerAddress,
            txHash: tx.hash,
            gasUsed: receipt.gasUsed.toString()
          });
        } else {
          logger.error('Flash liquidation failed', {
            borrower: borrowerAddress,
            txHash: tx.hash
          });
        }
      }
    } else {
      // Traditional direct liquidation
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
    
    // Run seed scan once (before block loop starts)
    await seedBorrowersOnce();
    
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

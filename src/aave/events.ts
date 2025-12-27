import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getConfig } from '../config/env';
import { getAaveAddresses, AAVE_POOL_ABI, ERC20_ABI } from './addresses';
import { getTokenAddress } from '../tokens';
import { borrowerRegistry } from '../state/registry';
import { BorrowerState, BorrowerBalance } from '../state/borrower';
import { getTotalDebtUSD, getOracleHealthFactor } from '../execution/sim';
import { sendTelegram } from '../notify/telegram';
import logger from '../logging/logger';

// Aave event listener
export class AaveEventListener extends EventEmitter {
  private provider: ethers.JsonRpcProvider;
  private poolContract: ethers.Contract;
  private isListening: boolean = false;
  
  constructor(provider: ethers.JsonRpcProvider) {
    super();
    this.provider = provider;
    
    const addresses = getAaveAddresses();
    this.poolContract = new ethers.Contract(
      addresses.pool,
      AAVE_POOL_ABI,
      provider
    );
  }
  
  // Start listening to events
  async startListening(): Promise<void> {
    if (this.isListening) {
      logger.warn('Already listening to Aave events');
      return;
    }
    
    const config = getConfig();
    logger.info('Starting Aave event listeners', {
      pool: this.poolContract.target,
      confirmations: config.eventConfirmations
    });
    
    // Listen to Borrow events
    this.poolContract.on('Borrow', async (reserve, user, onBehalfOf, amount, _interestRateMode, _borrowRate, _referralCode, event) => {
      try {
        await this.handleBorrowEvent(reserve, user, onBehalfOf, amount, event);
      } catch (error) {
        logger.error('Error handling Borrow event', { error });
      }
    });
    
    // Listen to Repay events
    this.poolContract.on('Repay', async (reserve, user, repayer, amount, _useATokens, event) => {
      try {
        await this.handleRepayEvent(reserve, user, repayer, amount, event);
      } catch (error) {
        logger.error('Error handling Repay event', { error });
      }
    });
    
    // Listen to LiquidationCall events
    this.poolContract.on('LiquidationCall', async (collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, _liquidator, _receiveAToken, event) => {
      try {
        await this.handleLiquidationEvent(collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, event);
      } catch (error) {
        logger.error('Error handling LiquidationCall event', { error });
      }
    });
    
    // Listen to Supply events (collateral added)
    this.poolContract.on('Supply', async (reserve, user, onBehalfOf, amount, _referralCode, event) => {
      try {
        await this.handleSupplyEvent(reserve, user, onBehalfOf, amount, event);
      } catch (error) {
        logger.error('Error handling Supply event', { error });
      }
    });
    
    // Listen to Withdraw events (collateral removed)
    this.poolContract.on('Withdraw', async (reserve, user, to, amount, event) => {
      try {
        await this.handleWithdrawEvent(reserve, user, to, amount, event);
      } catch (error) {
        logger.error('Error handling Withdraw event', { error });
      }
    });
    
    this.isListening = true;
    logger.info('Aave event listeners started');
  }
  
  // Handle Borrow event
  private async handleBorrowEvent(
    reserve: string,
    _user: string,
    onBehalfOf: string,
    amount: bigint,
    event: ethers.Log
  ): Promise<void> {
    logger.info('Borrow event detected', {
      user: onBehalfOf,
      reserve,
      amount: amount.toString(),
      blockNumber: event.blockNumber
    });
    
    const config = getConfig();
    
    // Check if borrower exists
    let borrower = borrowerRegistry.getBorrower(onBehalfOf);
    const isNew = !borrower;
    
    // Add borrower to registry if not exists (start as NOT hydrated)
    if (!borrower) {
      borrower = borrowerRegistry.addBorrower(onBehalfOf, BorrowerState.SAFE, false);
    }
    
    // Update cached balances
    await this.updateBorrowerBalances(onBehalfOf);
    
    // Mark as hydrated ONLY after successful balance update
    borrowerRegistry.markBorrowerHydrated(onBehalfOf);
    
    // For new borrowers, check MIN_DEBT_USD threshold
    if (isNew) {
      try {
        const totalDebtUSD = await getTotalDebtUSD(this.provider, borrower);
        
        if (totalDebtUSD < config.minDebtUsd) {
          logger.info('Skipping new borrower: debt below MIN_DEBT_USD', {
            user: onBehalfOf,
            totalDebtUSD: totalDebtUSD.toFixed(2),
            minDebtUsd: config.minDebtUsd
          });
          // Remove from registry - only valid for new borrowers below threshold
          borrowerRegistry.removeBorrower(onBehalfOf);
          return;
        }
        
        logger.info('New borrower added: meets MIN_DEBT_USD threshold', {
          user: onBehalfOf,
          totalDebtUSD: totalDebtUSD.toFixed(2),
          minDebtUsd: config.minDebtUsd
        });
      } catch (error) {
        logger.warn('Failed to compute debt for new borrower, keeping in registry', {
          user: onBehalfOf,
          error
        });
        // Do NOT remove - transient error, keep borrower
      }
    }
    
    // Mark as updated
    borrowerRegistry.markBorrowerUpdated(onBehalfOf);
    
    // Emit event for HF recalculation
    this.emit('borrowerUpdated', onBehalfOf);
  }
  
  // Handle Repay event
  private async handleRepayEvent(
    reserve: string,
    user: string,
    _repayer: string,
    amount: bigint,
    event: ethers.Log
  ): Promise<void> {
    logger.info('Repay event detected', {
      user,
      reserve,
      amount: amount.toString(),
      blockNumber: event.blockNumber
    });
    
    // Only process if borrower exists
    const borrower = borrowerRegistry.getBorrower(user);
    if (!borrower) {
      logger.debug('Repay event for unknown borrower, skipping', { user });
      return;
    }
    
    // Update cached balances
    await this.updateBorrowerBalances(user);
    
    // Mark as hydrated after successful balance update
    borrowerRegistry.markBorrowerHydrated(user);
    
    // Mark as updated
    borrowerRegistry.markBorrowerUpdated(user);
    
    // Emit event for HF recalculation
    this.emit('borrowerUpdated', user);
  }
  
  // Handle LiquidationCall event
  private async handleLiquidationEvent(
    collateralAsset: string,
    debtAsset: string,
    user: string,
    debtToCover: bigint,
    liquidatedCollateralAmount: bigint,
    event: ethers.Log
  ): Promise<void> {
    const config = getConfig();
    const stats = borrowerRegistry.getStats();
    
    logger.info('Liquidation event detected', {
      user,
      collateralAsset,
      debtAsset,
      debtToCover: debtToCover.toString(),
      liquidatedCollateralAmount: liquidatedCollateralAmount.toString(),
      blockNumber: event.blockNumber
    });
    
    // Get transaction details
    const txHash = event.transactionHash;
    const blockNumber = event.blockNumber;
    
    // Compute USD values for the liquidation
    let debtUSD = 0;
    let collateralUSD = 0;
    
    try {
      // Get asset symbols from addresses
      const debtSymbol = this.getAssetSymbol(debtAsset);
      const collateralSymbol = this.getAssetSymbol(collateralAsset);
      
      // Get decimals
      const debtTokenContract = new ethers.Contract(debtAsset, ERC20_ABI, this.provider);
      const collateralTokenContract = new ethers.Contract(collateralAsset, ERC20_ABI, this.provider);
      
      const debtDecimals = await debtTokenContract.decimals();
      const collateralDecimals = await collateralTokenContract.decimals();
      
      // Get oracle prices
      const oracleContract = new ethers.Contract(
        getAaveAddresses().oracle,
        ['function getAssetPrice(address asset) external view returns (uint256)'],
        this.provider
      );
      
      const debtPrice = await oracleContract.getAssetPrice(debtAsset);
      const collateralPrice = await oracleContract.getAssetPrice(collateralAsset);
      
      // Aave oracle returns prices in 8 decimals USD
      const debtPriceUSD = Number(debtPrice) / 1e8;
      const collateralPriceUSD = Number(collateralPrice) / 1e8;
      
      // Compute USD values
      const debtAmount = Number(debtToCover) / Math.pow(10, debtDecimals);
      const collateralAmount = Number(liquidatedCollateralAmount) / Math.pow(10, collateralDecimals);
      
      debtUSD = debtAmount * debtPriceUSD;
      collateralUSD = collateralAmount * collateralPriceUSD;
      
      // Classify reason for missed liquidation
      const borrower = borrowerRegistry.getBorrower(user);
      let reason = 'unknown';
      
      if (!borrower || borrower.state === BorrowerState.SAFE) {
        reason = 'not_in_watch_set';
      } else if (debtUSD < config.minDebtUsd) {
        reason = 'below_min_debt';
      } else if (borrower.state === BorrowerState.WATCH || borrower.state === BorrowerState.CRITICAL) {
        // Check if we had prepared this liquidation
        if (borrower.lastPreparedBlock && borrower.lastPreparedBlock < blockNumber) {
          reason = 'raced';
        } else {
          // Check oracle HF at audit time
          const oracleHF = await getOracleHealthFactor(this.provider, user);
          if (oracleHF >= 1.0) {
            reason = 'oracle_not_liquidatable';
          } else if (borrower.lastSkipReason === 'profit_floor') {
            reason = 'filtered_by_profit';
          } else if (borrower.lastSkipReason === 'gas_guard') {
            reason = 'filtered_by_gas';
          }
        }
      }
      
      // Build audit message
      const auditMessage = `🔍 LIQUIDATION AUDIT
Borrower: ${user}
Debt Asset: ${debtSymbol} (${debtAsset})
Collateral Asset: ${collateralSymbol} (${collateralAsset})
Debt Covered: ${debtAmount.toFixed(6)} ${debtSymbol} ($${debtUSD.toFixed(2)})
Collateral Seized: ${collateralAmount.toFixed(6)} ${collateralSymbol} ($${collateralUSD.toFixed(2)})
Block: ${blockNumber}
Tx: ${txHash}
Reason: ${reason}
Candidates Total: ${stats.total}`;
      
      logger.info('Liquidation audit', {
        borrower: user,
        debtAsset: debtSymbol,
        collateralAsset: collateralSymbol,
        debtUSD: debtUSD.toFixed(2),
        collateralUSD: collateralUSD.toFixed(2),
        blockNumber,
        txHash,
        reason,
        candidatesTotal: stats.total
      });
      
      // Send to Telegram (best-effort, optional)
      sendTelegram(auditMessage).catch(error => {
        logger.debug('Failed to send Telegram audit', { error });
      });
    } catch (error) {
      logger.error('Error computing liquidation audit details', { error });
    }
    
    // Update cached balances
    await this.updateBorrowerBalances(user);
    
    // Check if borrower should be removed (no debt left)
    const borrower = borrowerRegistry.getBorrower(user);
    if (borrower && borrower.debtBalances.every(b => b.amount === 0n)) {
      borrowerRegistry.removeBorrower(user);
    } else {
      // Mark as updated
      borrowerRegistry.markBorrowerUpdated(user);
      
      // Emit event for HF recalculation
      this.emit('borrowerUpdated', user);
    }
  }
  
  // Helper to get asset symbol from address
  private getAssetSymbol(address: string): string {
    const ASSET_ADDRESSES: Record<string, string> = {
      '0x4200000000000000000000000000000000000006': 'WETH',
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 'USDC',
      '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22': 'cbETH'
    };
    
    return ASSET_ADDRESSES[address] || address;
  }
  
  // Handle Supply event
  private async handleSupplyEvent(
    reserve: string,
    _user: string,
    onBehalfOf: string,
    amount: bigint,
    event: ethers.Log
  ): Promise<void> {
    logger.debug('Supply event detected', {
      user: onBehalfOf,
      reserve,
      amount: amount.toString(),
      blockNumber: event.blockNumber
    });
    
    const config = getConfig();
    
    // Check if borrower exists
    let borrower = borrowerRegistry.getBorrower(onBehalfOf);
    const isNew = !borrower;
    
    // For new borrowers, check if they have debt first
    if (isNew) {
      borrower = borrowerRegistry.addBorrower(onBehalfOf, BorrowerState.SAFE, false);
      
      // Update cached balances
      await this.updateBorrowerBalances(onBehalfOf);
      
      // Mark as hydrated ONLY after successful balance update
      borrowerRegistry.markBorrowerHydrated(onBehalfOf);
      
      // Check MIN_DEBT_USD threshold
      try {
        const totalDebtUSD = await getTotalDebtUSD(this.provider, borrower);
        
        if (totalDebtUSD < config.minDebtUsd) {
          logger.debug('Skipping new borrower on Supply: debt below MIN_DEBT_USD', {
            user: onBehalfOf,
            totalDebtUSD: totalDebtUSD.toFixed(2),
            minDebtUsd: config.minDebtUsd
          });
          // Remove from registry - only valid for new borrowers below threshold
          borrowerRegistry.removeBorrower(onBehalfOf);
          return;
        }
      } catch (error) {
        logger.warn('Failed to compute debt for new borrower on Supply, keeping in registry', {
          user: onBehalfOf,
          error
        });
        // Do NOT remove - transient error, keep borrower
      }
    } else {
      // Update cached balances
      await this.updateBorrowerBalances(onBehalfOf);
      
      // Mark as hydrated after successful balance update
      borrowerRegistry.markBorrowerHydrated(onBehalfOf);
    }
    
    // Mark as updated
    borrowerRegistry.markBorrowerUpdated(onBehalfOf);
    
    // Emit event for HF recalculation
    this.emit('borrowerUpdated', onBehalfOf);
  }
  
  // Handle Withdraw event
  private async handleWithdrawEvent(
    reserve: string,
    user: string,
    _to: string,
    amount: bigint,
    event: ethers.Log
  ): Promise<void> {
    logger.debug('Withdraw event detected', {
      user,
      reserve,
      amount: amount.toString(),
      blockNumber: event.blockNumber
    });
    
    const config = getConfig();
    
    // Check if borrower exists
    let borrower = borrowerRegistry.getBorrower(user);
    const isNew = !borrower;
    
    // For new borrowers, check if they have debt first
    if (isNew) {
      borrower = borrowerRegistry.addBorrower(user, BorrowerState.SAFE, false);
      
      // Update cached balances
      await this.updateBorrowerBalances(user);
      
      // Mark as hydrated ONLY after successful balance update
      borrowerRegistry.markBorrowerHydrated(user);
      
      // Check MIN_DEBT_USD threshold
      try {
        const totalDebtUSD = await getTotalDebtUSD(this.provider, borrower);
        
        if (totalDebtUSD < config.minDebtUsd) {
          logger.debug('Skipping new borrower on Withdraw: debt below MIN_DEBT_USD', {
            user,
            totalDebtUSD: totalDebtUSD.toFixed(2),
            minDebtUsd: config.minDebtUsd
          });
          // Remove from registry - only valid for new borrowers below threshold
          borrowerRegistry.removeBorrower(user);
          return;
        }
      } catch (error) {
        logger.warn('Failed to compute debt for new borrower on Withdraw, keeping in registry', {
          user,
          error
        });
        // Do NOT remove - transient error, keep borrower
      }
    } else {
      // Update cached balances
      await this.updateBorrowerBalances(user);
      
      // Mark as hydrated after successful balance update
      borrowerRegistry.markBorrowerHydrated(user);
    }
    
    // Mark as updated
    borrowerRegistry.markBorrowerUpdated(user);
    
    // Emit event for HF recalculation
    this.emit('borrowerUpdated', user);
  }
  
  // Update borrower balances from on-chain data
  private async updateBorrowerBalances(userAddress: string): Promise<void> {
    const borrower = borrowerRegistry.getBorrower(userAddress);
    if (!borrower) {
      // Skip silently - borrower should have been added before calling this
      logger.debug('Skipping balance update for non-existent borrower', { userAddress });
      return;
    }
    
    const config = getConfig();
    
    // Fetch collateral balances
    const collateralBalances: BorrowerBalance[] = [];
    for (const asset of config.targetCollateralAssets) {
      try {
        const assetAddress = getTokenAddress(asset);
        const balance = await this.getCollateralBalance(userAddress, assetAddress);
        
        if (balance > 0n) {
          collateralBalances.push({
            asset,
            amount: balance,
            valueUsd: 0 // Will be computed during HF calculation
          });
        }
      } catch (error) {
        logger.error('Error fetching collateral balance', { asset, error });
      }
    }
    
    // Fetch debt balances
    const debtBalances: BorrowerBalance[] = [];
    for (const asset of config.targetDebtAssets) {
      try {
        const assetAddress = getTokenAddress(asset);
        const balance = await this.getDebtBalance(userAddress, assetAddress);
        
        if (balance > 0n) {
          debtBalances.push({
            asset,
            amount: balance,
            valueUsd: 0 // Will be computed during HF calculation
          });
        }
      } catch (error) {
        logger.error('Error fetching debt balance', { asset, error });
      }
    }
    
    // Update borrower
    borrower.collateralBalances = collateralBalances;
    borrower.debtBalances = debtBalances;
    
    logger.debug('Borrower balances updated', {
      address: userAddress,
      collateralCount: collateralBalances.length,
      debtCount: debtBalances.length
    });
  }
  
  // Get collateral balance (aToken balance)
  private async getCollateralBalance(userAddress: string, assetAddress: string): Promise<bigint> {
    // Get reserve data to find aToken address
    const reserveData = await this.poolContract.getReserveData(assetAddress);
    const aTokenAddress = reserveData.aTokenAddress;
    
    // Get aToken balance
    const aTokenContract = new ethers.Contract(aTokenAddress, ERC20_ABI, this.provider);
    const balance = await aTokenContract.balanceOf(userAddress);
    
    return balance;
  }
  
  // Get debt balance (variable debt token balance)
  private async getDebtBalance(userAddress: string, assetAddress: string): Promise<bigint> {
    // Get reserve data to find debt token address
    const reserveData = await this.poolContract.getReserveData(assetAddress);
    const debtTokenAddress = reserveData.variableDebtTokenAddress;
    
    // Get debt token balance
    const debtTokenContract = new ethers.Contract(debtTokenAddress, ERC20_ABI, this.provider);
    const balance = await debtTokenContract.balanceOf(userAddress);
    
    return balance;
  }
  
  // Stop listening to events
  stopListening(): void {
    if (!this.isListening) {
      return;
    }
    
    this.poolContract.removeAllListeners();
    this.isListening = false;
    logger.info('Aave event listeners stopped');
  }
}

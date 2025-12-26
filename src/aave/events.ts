import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getConfig } from '../config/env';
import { getAaveAddresses, AAVE_POOL_ABI, ERC20_ABI, getAssetAddress } from './addresses';
import { borrowerRegistry } from '../state/registry';
import { BorrowerState, BorrowerBalance } from '../state/borrower';
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
    
    // Add borrower to registry if not exists
    borrowerRegistry.addBorrower(onBehalfOf, BorrowerState.SAFE);
    
    // Update cached balances
    await this.updateBorrowerBalances(onBehalfOf);
    
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
    
    // Update cached balances
    await this.updateBorrowerBalances(user);
    
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
    logger.info('Liquidation event detected', {
      user,
      collateralAsset,
      debtAsset,
      debtToCover: debtToCover.toString(),
      liquidatedCollateralAmount: liquidatedCollateralAmount.toString(),
      blockNumber: event.blockNumber
    });
    
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
    
    // Update cached balances
    await this.updateBorrowerBalances(onBehalfOf);
    
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
    
    // Update cached balances
    await this.updateBorrowerBalances(user);
    
    // Mark as updated
    borrowerRegistry.markBorrowerUpdated(user);
    
    // Emit event for HF recalculation
    this.emit('borrowerUpdated', user);
  }
  
  // Update borrower balances from on-chain data
  private async updateBorrowerBalances(userAddress: string): Promise<void> {
    const borrower = borrowerRegistry.getBorrower(userAddress);
    if (!borrower) {
      logger.warn('Attempted to update balances for unknown borrower', { userAddress });
      return;
    }
    
    const config = getConfig();
    
    // Fetch collateral balances
    const collateralBalances: BorrowerBalance[] = [];
    for (const asset of config.targetCollateralAssets) {
      try {
        const assetAddress = getAssetAddress(asset);
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
        const assetAddress = getAssetAddress(asset);
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

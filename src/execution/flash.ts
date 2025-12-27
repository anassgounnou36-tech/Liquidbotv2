import { ethers } from 'ethers';
import { Borrower } from '../state/borrower';
import { getConfig } from '../config/env';
import { getAssetAddress } from '../aave/addresses';
import { estimateLiquidation } from '../hf/calc';
import { priceAggregator } from '../prices';
import { build1inchSwapData } from './oneinch';
import logger from '../logging/logger';

// FlashLiquidator ABI (minimal)
const FLASH_LIQUIDATOR_ABI = [
  'function execute(address borrower, address debtAsset, address collateralAsset, uint256 debtAmount, bytes calldata oneInchData) external',
  'function emergencyWithdraw(address token) external',
  'function getDecimals(address asset) external view returns (uint8)'
];

// Flash liquidation simulation result
export interface FlashLiquidationResult {
  success: boolean;
  debtAsset: string;
  collateralAsset: string;
  debtAmount: bigint;
  expectedProfit: number;
  gasEstimate: bigint;
  gasUsd: number;
  oneInchData: string; // 1inch swap calldata
  minAmountOut: bigint; // Minimum amount out from swap (with slippage)
  error?: string;
}

/**
 * Simulate flash liquidation using callStatic
 * This simulates the EXACT flow including Balancer flash loan callback
 */
export async function simulateFlashLiquidation(
  provider: ethers.JsonRpcProvider,
  borrower: Borrower,
  _liquidatorAddress: string
): Promise<FlashLiquidationResult | null> {
  const config = getConfig();
  
  if (!config.flashLiquidatorAddress) {
    logger.error('FlashLiquidator address not configured');
    return null;
  }
  
  try {
    // Get current prices
    const prices = priceAggregator.getAllPrices();
    
    // Find best liquidation opportunity
    let bestEstimate: ReturnType<typeof estimateLiquidation> = null;
    let bestDebtAsset = '';
    let bestCollateralAsset = '';
    
    for (const debtAsset of config.targetDebtAssets) {
      for (const collateralAsset of config.targetCollateralAssets) {
        const estimate = estimateLiquidation(borrower, prices, debtAsset, collateralAsset);
        
        if (estimate && (!bestEstimate || estimate.profitUsd > bestEstimate.profitUsd)) {
          bestEstimate = estimate;
          bestDebtAsset = debtAsset;
          bestCollateralAsset = collateralAsset;
        }
      }
    }
    
    if (!bestEstimate) {
      return {
        success: false,
        debtAsset: '',
        collateralAsset: '',
        debtAmount: 0n,
        expectedProfit: 0,
        gasEstimate: 0n,
        gasUsd: 0,
        oneInchData: '0x',
        minAmountOut: 0n,
        error: 'No profitable liquidation found'
      };
    }
    
    // Get asset addresses
    const debtAssetAddress = getAssetAddress(bestDebtAsset);
    const collateralAssetAddress = getAssetAddress(bestCollateralAsset);
    
    // Build 1inch swap data for collateral -> debt swap
    const oneInchSwap = await build1inchSwapData(
      collateralAssetAddress,
      debtAssetAddress,
      bestEstimate.collateralAmount,
      config.flashLiquidatorAddress,
      provider
    );
    
    if (!oneInchSwap) {
      logger.error('Failed to build 1inch swap data', {
        borrower: borrower.address,
        collateralAsset: bestCollateralAsset,
        debtAsset: bestDebtAsset
      });
      return {
        success: false,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtAmount: bestEstimate.debtAmount,
        expectedProfit: 0,
        gasEstimate: 0n,
        gasUsd: 0,
        oneInchData: '0x',
        minAmountOut: 0n,
        error: 'Failed to build 1inch swap data'
      };
    }
    
    logger.info('1inch swap data built', {
      borrower: borrower.address,
      fromAsset: bestCollateralAsset,
      toAsset: bestDebtAsset,
      amountIn: bestEstimate.collateralAmount.toString(),
      estimatedOut: oneInchSwap.estimatedOut.toString(),
      minAmountOut: oneInchSwap.minAmountOut.toString(),
      slippageBps: config.maxSlippageBps
    });
    
    // Create FlashLiquidator contract instance
    const flashLiquidator = new ethers.Contract(
      config.flashLiquidatorAddress,
      FLASH_LIQUIDATOR_ABI,
      provider
    );
    
    // Simulate using callStatic - this will execute the EXACT flow
    // including the Balancer vault callback to receiveFlashLoan
    try {
      await flashLiquidator.execute.staticCall(
        borrower.address,
        debtAssetAddress,
        collateralAssetAddress,
        bestEstimate.debtAmount,
        oneInchSwap.calldata
      );
      
      // If we get here, simulation succeeded
      logger.info('Flash liquidation simulation succeeded', {
        borrower: borrower.address,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtAmount: bestEstimate.debtAmount.toString()
      });
    } catch (simError: any) {
      // Simulation failed - this is critical
      logger.warn('Flash liquidation simulation failed', {
        borrower: borrower.address,
        error: simError.message,
        reason: simError.reason
      });
      
      return {
        success: false,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtAmount: bestEstimate.debtAmount,
        expectedProfit: bestEstimate.profitUsd,
        gasEstimate: 0n,
        gasUsd: 0,
        oneInchData: oneInchSwap.calldata,
        minAmountOut: oneInchSwap.minAmountOut,
        error: `Simulation failed: ${simError.reason || simError.message}`
      };
    }
    
    // Estimate gas for the actual execution
    const gasEstimate = await flashLiquidator.execute.estimateGas(
      borrower.address,
      debtAssetAddress,
      collateralAssetAddress,
      bestEstimate.debtAmount,
      oneInchSwap.calldata
    );
    
    // Get current base fee
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || 0n;
    
    // Convert gas to USD using ETH price
    const ethPrice = prices.get('WETH')?.priceUsd || 2000;
    const gasUsd = Number(gasEstimate * maxFeePerGas) / 1e18 * ethPrice;
    
    // Check profitability
    if (bestEstimate.profitUsd < config.minProfitUsd) {
      return {
        success: false,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtAmount: bestEstimate.debtAmount,
        expectedProfit: bestEstimate.profitUsd,
        gasEstimate,
        gasUsd,
        oneInchData: oneInchSwap.calldata,
        minAmountOut: oneInchSwap.minAmountOut,
        error: `Profit too low: $${bestEstimate.profitUsd.toFixed(2)} < $${config.minProfitUsd}`
      };
    }
    
    // Check gas cost
    if (gasUsd > config.maxGasUsd) {
      return {
        success: false,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtAmount: bestEstimate.debtAmount,
        expectedProfit: bestEstimate.profitUsd,
        gasEstimate,
        gasUsd,
        oneInchData: oneInchSwap.calldata,
        minAmountOut: oneInchSwap.minAmountOut,
        error: `Gas too high: $${gasUsd.toFixed(2)} > $${config.maxGasUsd}`
      };
    }
    
    return {
      success: true,
      debtAsset: bestDebtAsset,
      collateralAsset: bestCollateralAsset,
      debtAmount: bestEstimate.debtAmount,
      expectedProfit: bestEstimate.profitUsd,
      gasEstimate,
      gasUsd,
      oneInchData: oneInchSwap.calldata,
      minAmountOut: oneInchSwap.minAmountOut
    };
  } catch (error: any) {
    logger.error('Flash liquidation simulation error', {
      borrower: borrower.address,
      error: error.message
    });
    
    return {
      success: false,
      debtAsset: '',
      collateralAsset: '',
      debtAmount: 0n,
      expectedProfit: 0,
      gasEstimate: 0n,
      gasUsd: 0,
      oneInchData: '0x',
      minAmountOut: 0n,
      error: error.message
    };
  }
}

/**
 * Build flash liquidation transaction
 */
export async function buildFlashLiquidationTx(
  provider: ethers.JsonRpcProvider,
  signer: ethers.Wallet,
  borrowerAddress: string,
  flashResult: FlashLiquidationResult
): Promise<ethers.TransactionRequest | null> {
  const config = getConfig();
  
  if (!flashResult.success) {
    logger.error('Cannot build tx for failed simulation');
    return null;
  }
  
  if (!config.flashLiquidatorAddress) {
    logger.error('FlashLiquidator address not configured');
    return null;
  }
  
  try {
    // Get asset addresses
    const debtAssetAddress = getAssetAddress(flashResult.debtAsset);
    const collateralAssetAddress = getAssetAddress(flashResult.collateralAsset);
    
    // Create FlashLiquidator contract instance
    const flashLiquidator = new ethers.Contract(
      config.flashLiquidatorAddress,
      FLASH_LIQUIDATOR_ABI,
      signer
    );
    
    // Build transaction data with actual borrower address and 1inch calldata
    const data = flashLiquidator.interface.encodeFunctionData('execute', [
      borrowerAddress,
      debtAssetAddress,
      collateralAssetAddress,
      flashResult.debtAmount,
      flashResult.oneInchData
    ]);
    
    // Get fee data
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || 0n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 0n;
    
    // Add 20% buffer to gas estimate (flash loans can be unpredictable)
    const gasLimit = (flashResult.gasEstimate * 120n) / 100n;
    
    const tx: ethers.TransactionRequest = {
      to: config.flashLiquidatorAddress,
      data,
      value: 0n,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      chainId: config.chainId,
      type: 2 // EIP-1559
    };
    
    logger.info('Flash liquidation transaction built', {
      borrower: borrowerAddress,
      to: tx.to,
      gasLimit: tx.gasLimit?.toString(),
      expectedProfit: flashResult.expectedProfit.toFixed(2)
    });
    
    return tx;
  } catch (error: any) {
    logger.error('Failed to build flash liquidation tx', {
      borrower: borrowerAddress,
      error: error.message
    });
    return null;
  }
}

/**
 * Execute flash liquidation transaction
 */
export async function executeFlashLiquidation(
  provider: ethers.JsonRpcProvider,
  signer: ethers.Wallet,
  borrowerAddress: string,
  flashResult: FlashLiquidationResult
): Promise<ethers.TransactionResponse | null> {
  const config = getConfig();
  
  if (!config.flashLiquidatorAddress) {
    logger.error('FlashLiquidator address not configured');
    return null;
  }
  
  try {
    // Get asset addresses
    const debtAssetAddress = getAssetAddress(flashResult.debtAsset);
    const collateralAssetAddress = getAssetAddress(flashResult.collateralAsset);
    
    // Create FlashLiquidator contract instance
    const flashLiquidator = new ethers.Contract(
      config.flashLiquidatorAddress,
      FLASH_LIQUIDATOR_ABI,
      signer
    );
    
    // Get fee data
    const feeData = await provider.getFeeData();
    
    // Add 20% buffer to gas estimate
    const gasLimit = (flashResult.gasEstimate * 120n) / 100n;
    
    // Execute the flash liquidation
    const tx = await flashLiquidator.execute(
      borrowerAddress,
      debtAssetAddress,
      collateralAssetAddress,
      flashResult.debtAmount,
      flashResult.oneInchData,
      {
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
      }
    );
    
    logger.info('Flash liquidation transaction sent', {
      borrower: borrowerAddress,
      txHash: tx.hash,
      debtAsset: flashResult.debtAsset,
      collateralAsset: flashResult.collateralAsset
    });
    
    return tx;
  } catch (error: any) {
    logger.error('Failed to execute flash liquidation', {
      borrower: borrowerAddress,
      error: error.message
    });
    return null;
  }
}

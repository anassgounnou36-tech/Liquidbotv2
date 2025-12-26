import { ethers } from 'ethers';
import { Borrower } from '../state/borrower';
import { getAaveAddresses, AAVE_POOL_ABI, AAVE_ORACLE_ABI, getAssetAddress } from '../aave/addresses';
import { estimateLiquidation } from '../hf/calc';
import { priceAggregator } from '../prices';
import { getConfig } from '../config/env';
import logger from '../logging/logger';

// Simulation result
export interface SimulationResult {
  success: boolean;
  debtAsset: string;
  collateralAsset: string;
  debtToCover: bigint;
  expectedCollateral: bigint;
  profitUsd: number;
  gasEstimate: bigint;
  gasUsd: number;
  oracleHF: number;
  error?: string;
}

// Simulate liquidation using callStatic
export async function simulateLiquidation(
  provider: ethers.JsonRpcProvider,
  borrower: Borrower,
  _liquidatorAddress: string
): Promise<SimulationResult | null> {
  const config = getConfig();
  const addresses = getAaveAddresses();
  
  // Get pool contract
  const poolContract = new ethers.Contract(
    addresses.pool,
    AAVE_POOL_ABI,
    provider
  );
  
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
        debtToCover: 0n,
        expectedCollateral: 0n,
        profitUsd: 0,
        gasEstimate: 0n,
        gasUsd: 0,
        oracleHF: borrower.oracleHF,
        error: 'No profitable liquidation found'
      };
    }
    
    // Get asset addresses
    const debtAssetAddress = getAssetAddress(bestDebtAsset);
    const collateralAssetAddress = getAssetAddress(bestCollateralAsset);
    
    // Verify oracle HF first
    const oracleHF = await getOracleHealthFactor(provider, borrower.address);
    
    if (oracleHF > config.hfLiquidatable) {
      return {
        success: false,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtToCover: bestEstimate.debtAmount,
        expectedCollateral: bestEstimate.collateralAmount,
        profitUsd: bestEstimate.profitUsd,
        gasEstimate: 0n,
        gasUsd: 0,
        oracleHF,
        error: `Oracle HF too high: ${oracleHF.toFixed(4)}`
      };
    }
    
    // Simulate liquidation call
    const gasEstimate = await poolContract.liquidationCall.estimateGas(
      collateralAssetAddress,
      debtAssetAddress,
      borrower.address,
      bestEstimate.debtAmount,
      false // receiveAToken
    );
    
    // Get current base fee
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || 0n;
    const gasUsd = Number(gasEstimate * maxFeePerGas) / 1e18 * (prices.get('WETH')?.priceUsd || 2000);
    
    // Check profitability
    if (bestEstimate.profitUsd < config.minProfitUsd) {
      return {
        success: false,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtToCover: bestEstimate.debtAmount,
        expectedCollateral: bestEstimate.collateralAmount,
        profitUsd: bestEstimate.profitUsd,
        gasEstimate,
        gasUsd,
        oracleHF,
        error: `Profit too low: $${bestEstimate.profitUsd.toFixed(2)} < $${config.minProfitUsd}`
      };
    }
    
    if (gasUsd > config.maxGasUsd) {
      return {
        success: false,
        debtAsset: bestDebtAsset,
        collateralAsset: bestCollateralAsset,
        debtToCover: bestEstimate.debtAmount,
        expectedCollateral: bestEstimate.collateralAmount,
        profitUsd: bestEstimate.profitUsd,
        gasEstimate,
        gasUsd,
        oracleHF,
        error: `Gas too high: $${gasUsd.toFixed(2)} > $${config.maxGasUsd}`
      };
    }
    
    return {
      success: true,
      debtAsset: bestDebtAsset,
      collateralAsset: bestCollateralAsset,
      debtToCover: bestEstimate.debtAmount,
      expectedCollateral: bestEstimate.collateralAmount,
      profitUsd: bestEstimate.profitUsd,
      gasEstimate,
      gasUsd,
      oracleHF
    };
  } catch (error: any) {
    logger.error('Simulation failed', {
      borrower: borrower.address,
      error: error.message
    });
    
    return {
      success: false,
      debtAsset: '',
      collateralAsset: '',
      debtToCover: 0n,
      expectedCollateral: 0n,
      profitUsd: 0,
      gasEstimate: 0n,
      gasUsd: 0,
      oracleHF: borrower.oracleHF,
      error: error.message
    };
  }
}

// Get Health Factor from Aave oracle
export async function getOracleHealthFactor(
  provider: ethers.JsonRpcProvider,
  userAddress: string
): Promise<number> {
  const addresses = getAaveAddresses();
  
  const poolContract = new ethers.Contract(
    addresses.pool,
    AAVE_POOL_ABI,
    provider
  );
  
  try {
    const accountData = await poolContract.getUserAccountData(userAddress);
    const healthFactor = accountData.healthFactor;
    
    // Convert from 18 decimals to float
    return Number(healthFactor) / 1e18;
  } catch (error) {
    logger.error('Failed to get oracle HF', { userAddress, error });
    return Infinity;
  }
}

// Get asset prices from Aave oracle
export async function getOraclePrices(
  provider: ethers.JsonRpcProvider,
  assets: string[]
): Promise<Map<string, number>> {
  const addresses = getAaveAddresses();
  const prices = new Map<string, number>();
  
  const oracleContract = new ethers.Contract(
    addresses.oracle,
    AAVE_ORACLE_ABI,
    provider
  );
  
  try {
    const assetAddresses = assets.map(asset => getAssetAddress(asset));
    const oraclePrices = await oracleContract.getAssetsPrices(assetAddresses);
    
    for (let i = 0; i < assets.length; i++) {
      // Aave oracle returns prices in 8 decimals USD
      prices.set(assets[i], Number(oraclePrices[i]) / 1e8);
    }
  } catch (error) {
    logger.error('Failed to get oracle prices', { error });
  }
  
  return prices;
}

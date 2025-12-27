import { Borrower, BorrowerBalance } from '../state/borrower';
import { getTokenDecimalsSync } from '../tokens';
import logger from '../logging/logger';

// Aave liquidation threshold (from protocol, typically stored per asset)
// This should be fetched from Aave protocol data, but we use reasonable defaults
const DEFAULT_LIQUIDATION_THRESHOLDS: Record<string, number> = {
  'WETH': 0.825, // 82.5%
  'cbETH': 0.78, // 78%
  'USDC': 0.80, // 80%
  'USDT': 0.80, // 80%
  'DAI': 0.80, // 80%
};

// Price data interface
export interface PriceData {
  asset: string;
  priceUsd: number;
  timestamp: number;
  source: 'binance' | 'pyth' | 'oracle';
}

// Calculate Health Factor
// HF = (Σ collateral_value × liquidation_threshold) / total_debt
export function calculateHealthFactor(
  collateralBalances: BorrowerBalance[],
  debtBalances: BorrowerBalance[],
  prices: Map<string, PriceData>,
  liquidationThresholds?: Map<string, number>
): number {
  // If no debt, HF is infinite
  const totalDebt = debtBalances.reduce((sum, balance) => {
    const price = prices.get(balance.asset);
    if (!price) {
      logger.warn('Price not found for debt asset', { asset: balance.asset });
      return sum;
    }
    const decimals = getTokenDecimalsSync(balance.asset);
    return sum + (Number(balance.amount) * price.priceUsd / Math.pow(10, decimals));
  }, 0);
  
  if (totalDebt === 0) {
    return Infinity;
  }
  
  // Calculate weighted collateral value
  const weightedCollateral = collateralBalances.reduce((sum, balance) => {
    const price = prices.get(balance.asset);
    if (!price) {
      logger.warn('Price not found for collateral asset', { asset: balance.asset });
      return sum;
    }
    
    // Get liquidation threshold for this asset
    const threshold = liquidationThresholds?.get(balance.asset) || 
                     DEFAULT_LIQUIDATION_THRESHOLDS[balance.asset] || 
                     0.75; // Default fallback
    
    const decimals = getTokenDecimalsSync(balance.asset);
    const collateralValue = Number(balance.amount) * price.priceUsd / Math.pow(10, decimals);
    return sum + (collateralValue * threshold);
  }, 0);
  
  // HF = weighted_collateral / total_debt
  return weightedCollateral / totalDebt;
}

// Calculate HF for a borrower using current prices
export function calculateBorrowerHF(
  borrower: Borrower,
  prices: Map<string, PriceData>,
  liquidationThresholds?: Map<string, number>
): number {
  return calculateHealthFactor(
    borrower.collateralBalances,
    borrower.debtBalances,
    prices,
    liquidationThresholds
  );
}

// Estimate liquidation profit
export interface LiquidationEstimate {
  debtAsset: string;
  debtAmount: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  profitUsd: number;
  debtValueUsd: number;
  collateralValueUsd: number;
  liquidationBonus: number;
}

// Calculate potential liquidation profit
// Aave allows liquidating up to 50% of debt and gives a 5% bonus on collateral
export function estimateLiquidation(
  borrower: Borrower,
  prices: Map<string, PriceData>,
  debtAsset: string,
  collateralAsset: string,
  liquidationBonus: number = 0.05
): LiquidationEstimate | null {
  // Find debt balance
  const debtBalance = borrower.debtBalances.find(b => b.asset === debtAsset);
  if (!debtBalance) {
    return null;
  }
  
  // Find collateral balance
  const collateralBalance = borrower.collateralBalances.find(b => b.asset === collateralAsset);
  if (!collateralBalance) {
    return null;
  }
  
  // Get prices
  const debtPrice = prices.get(debtAsset);
  const collateralPrice = prices.get(collateralAsset);
  if (!debtPrice || !collateralPrice) {
    return null;
  }
  
  // Calculate max liquidatable debt (50% of total debt)
  const maxDebtAmount = debtBalance.amount / 2n;
  const debtDecimals = getTokenDecimalsSync(debtAsset);
  const debtValueUsd = Number(maxDebtAmount) * debtPrice.priceUsd / Math.pow(10, debtDecimals);
  
  // Calculate required collateral (with bonus)
  const requiredCollateralValueUsd = debtValueUsd * (1 + liquidationBonus);
  const collateralDecimals = getTokenDecimalsSync(collateralAsset);
  const requiredCollateralAmount = BigInt(Math.floor(requiredCollateralValueUsd / collateralPrice.priceUsd * Math.pow(10, collateralDecimals)));
  
  // Check if enough collateral available
  if (requiredCollateralAmount > collateralBalance.amount) {
    return null;
  }
  
  // Calculate profit (bonus amount in USD)
  const profitUsd = debtValueUsd * liquidationBonus;
  const collateralValueUsd = Number(requiredCollateralAmount) * collateralPrice.priceUsd / Math.pow(10, collateralDecimals);
  
  return {
    debtAsset,
    debtAmount: maxDebtAmount,
    collateralAsset,
    collateralAmount: requiredCollateralAmount,
    profitUsd,
    debtValueUsd,
    collateralValueUsd,
    liquidationBonus
  };
}

// Get default liquidation threshold for an asset
export function getLiquidationThreshold(asset: string): number {
  return DEFAULT_LIQUIDATION_THRESHOLDS[asset] || 0.75;
}

// Update liquidation thresholds from Aave protocol data
export function updateLiquidationThresholds(thresholds: Map<string, number>): void {
  for (const [asset, threshold] of thresholds) {
    DEFAULT_LIQUIDATION_THRESHOLDS[asset] = threshold;
  }
  logger.info('Liquidation thresholds updated', { count: thresholds.size });
}

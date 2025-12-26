import { calculateHealthFactor, estimateLiquidation } from '../src/hf/calc';
import { BorrowerBalance, createBorrower } from '../src/state/borrower';
import { PriceData } from '../src/hf/calc';

describe('Health Factor Calculation', () => {
  describe('calculateHealthFactor', () => {
    it('should return Infinity when no debt', () => {
      const collateralBalances: BorrowerBalance[] = [
        { asset: 'WETH', amount: BigInt(10e18), valueUsd: 0 }
      ];
      const debtBalances: BorrowerBalance[] = [];
      
      const prices = new Map<string, PriceData>([
        ['WETH', { asset: 'WETH', priceUsd: 2000, timestamp: Date.now(), source: 'binance' }]
      ]);
      
      const hf = calculateHealthFactor(collateralBalances, debtBalances, prices);
      
      expect(hf).toBe(Infinity);
    });
    
    it('should calculate correct HF with single collateral and debt', () => {
      // 10 WETH collateral at $2000 = $20,000
      // Liquidation threshold 82.5% = $16,500 weighted collateral
      // 10,000 USDC debt = $10,000
      // HF = 16,500 / 10,000 = 1.65
      
      const collateralBalances: BorrowerBalance[] = [
        { asset: 'WETH', amount: BigInt(10 * 1e18), valueUsd: 0 }
      ];
      
      const debtBalances: BorrowerBalance[] = [
        { asset: 'USDC', amount: BigInt(10000 * 1e6), valueUsd: 0 }
      ];
      
      const prices = new Map<string, PriceData>([
        ['WETH', { asset: 'WETH', priceUsd: 2000, timestamp: Date.now(), source: 'binance' }],
        ['USDC', { asset: 'USDC', priceUsd: 1, timestamp: Date.now(), source: 'binance' }]
      ]);
      
      const hf = calculateHealthFactor(collateralBalances, debtBalances, prices);
      
      // Expected: (10 * 2000 * 0.825) / 10000 = 1.65
      expect(hf).toBeCloseTo(1.65, 2);
    });
    
    it('should calculate HF below 1 for liquidatable position', () => {
      // 1 WETH collateral at $2000 = $2,000
      // Liquidation threshold 82.5% = $1,650 weighted collateral
      // 2,000 USDC debt = $2,000
      // HF = 1,650 / 2,000 = 0.825
      
      const collateralBalances: BorrowerBalance[] = [
        { asset: 'WETH', amount: BigInt(1 * 1e18), valueUsd: 0 }
      ];
      
      const debtBalances: BorrowerBalance[] = [
        { asset: 'USDC', amount: BigInt(2000 * 1e6), valueUsd: 0 }
      ];
      
      const prices = new Map<string, PriceData>([
        ['WETH', { asset: 'WETH', priceUsd: 2000, timestamp: Date.now(), source: 'binance' }],
        ['USDC', { asset: 'USDC', priceUsd: 1, timestamp: Date.now(), source: 'binance' }]
      ]);
      
      const hf = calculateHealthFactor(collateralBalances, debtBalances, prices);
      
      expect(hf).toBeLessThan(1);
      expect(hf).toBeCloseTo(0.825, 2);
    });
    
    it('should handle multiple collateral assets', () => {
      // 5 WETH at $2000 = $10,000 * 0.825 = $8,250
      // 10 cbETH at $1900 = $19,000 * 0.78 = $14,820
      // Total weighted collateral = $23,070
      // 15,000 USDC debt = $15,000
      // HF = 23,070 / 15,000 = 1.538
      
      const collateralBalances: BorrowerBalance[] = [
        { asset: 'WETH', amount: BigInt(5 * 1e18), valueUsd: 0 },
        { asset: 'cbETH', amount: BigInt(10 * 1e18), valueUsd: 0 }
      ];
      
      const debtBalances: BorrowerBalance[] = [
        { asset: 'USDC', amount: BigInt(15000 * 1e6), valueUsd: 0 }
      ];
      
      const prices = new Map<string, PriceData>([
        ['WETH', { asset: 'WETH', priceUsd: 2000, timestamp: Date.now(), source: 'binance' }],
        ['cbETH', { asset: 'cbETH', priceUsd: 1900, timestamp: Date.now(), source: 'binance' }],
        ['USDC', { asset: 'USDC', priceUsd: 1, timestamp: Date.now(), source: 'binance' }]
      ]);
      
      const hf = calculateHealthFactor(collateralBalances, debtBalances, prices);
      
      expect(hf).toBeGreaterThan(1.5);
      expect(hf).toBeCloseTo(1.538, 2);
    });
    
    it('should handle missing prices gracefully', () => {
      const collateralBalances: BorrowerBalance[] = [
        { asset: 'WETH', amount: BigInt(10 * 1e18), valueUsd: 0 }
      ];
      
      const debtBalances: BorrowerBalance[] = [
        { asset: 'USDC', amount: BigInt(10000 * 1e6), valueUsd: 0 }
      ];
      
      // Missing USDC price
      const prices = new Map<string, PriceData>([
        ['WETH', { asset: 'WETH', priceUsd: 2000, timestamp: Date.now(), source: 'binance' }]
      ]);
      
      const hf = calculateHealthFactor(collateralBalances, debtBalances, prices);
      
      // With missing debt price, debt is 0, so HF is Infinity
      expect(hf).toBe(Infinity);
    });
  });
  
  describe('estimateLiquidation', () => {
    it('should estimate liquidation profit correctly', () => {
      // 10 WETH collateral at $2000 = $20,000
      // 10,000 USDC debt at $1 = $10,000
      // Max liquidatable = 50% = 5,000 USDC
      // Collateral needed = 5,000 * 1.05 = $5,250 worth of WETH
      // Profit = 5,000 * 0.05 = $250
      
      const borrower = createBorrower('0x123');
      borrower.collateralBalances = [
        { asset: 'WETH', amount: BigInt(10 * 1e18), valueUsd: 0 }
      ];
      borrower.debtBalances = [
        { asset: 'USDC', amount: BigInt(10000 * 1e6), valueUsd: 0 }
      ];
      
      const prices = new Map<string, PriceData>([
        ['WETH', { asset: 'WETH', priceUsd: 2000, timestamp: Date.now(), source: 'binance' }],
        ['USDC', { asset: 'USDC', priceUsd: 1, timestamp: Date.now(), source: 'binance' }]
      ]);
      
      const estimate = estimateLiquidation(borrower, prices, 'USDC', 'WETH');
      
      expect(estimate).not.toBeNull();
      expect(estimate!.profitUsd).toBeCloseTo(250, 0);
      expect(estimate!.debtValueUsd).toBeCloseTo(5000, 0);
    });
    
    it('should return null for non-existent asset', () => {
      const borrower = createBorrower('0x123');
      borrower.collateralBalances = [
        { asset: 'WETH', amount: BigInt(10 * 1e18), valueUsd: 0 }
      ];
      borrower.debtBalances = [
        { asset: 'USDC', amount: BigInt(10000 * 1e6), valueUsd: 0 }
      ];
      
      const prices = new Map<string, PriceData>([
        ['WETH', { asset: 'WETH', priceUsd: 2000, timestamp: Date.now(), source: 'binance' }],
        ['USDC', { asset: 'USDC', priceUsd: 1, timestamp: Date.now(), source: 'binance' }]
      ]);
      
      const estimate = estimateLiquidation(borrower, prices, 'DAI', 'WETH');
      
      expect(estimate).toBeNull();
    });
    
    it('should return null for missing prices', () => {
      const borrower = createBorrower('0x123');
      borrower.collateralBalances = [
        { asset: 'WETH', amount: BigInt(10 * 1e18), valueUsd: 0 }
      ];
      borrower.debtBalances = [
        { asset: 'USDC', amount: BigInt(10000 * 1e6), valueUsd: 0 }
      ];
      
      // Missing prices
      const prices = new Map<string, PriceData>();
      
      const estimate = estimateLiquidation(borrower, prices, 'USDC', 'WETH');
      
      expect(estimate).toBeNull();
    });
  });
});

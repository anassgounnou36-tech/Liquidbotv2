import { 
  BorrowerState, 
  createBorrower, 
  updateBorrowerState, 
  determineState,
  isValidStateTransition 
} from '../src/state/borrower';

describe('Borrower State Machine', () => {
  describe('createBorrower', () => {
    it('should create a borrower with default SAFE state', () => {
      const borrower = createBorrower('0x123');
      
      expect(borrower.address).toBe('0x123');
      expect(borrower.state).toBe(BorrowerState.SAFE);
      expect(borrower.predictedHF).toBe(Infinity);
      expect(borrower.oracleHF).toBe(Infinity);
      expect(borrower.collateralBalances).toEqual([]);
      expect(borrower.debtBalances).toEqual([]);
    });
    
    it('should create a borrower with specified state', () => {
      const borrower = createBorrower('0x456', BorrowerState.WATCH);
      
      expect(borrower.state).toBe(BorrowerState.WATCH);
      expect(borrower.stateHistory.length).toBe(1);
      expect(borrower.stateHistory[0].state).toBe(BorrowerState.WATCH);
    });
  });
  
  describe('updateBorrowerState', () => {
    it('should update borrower state and history', () => {
      const borrower = createBorrower('0x123', BorrowerState.SAFE);
      
      updateBorrowerState(borrower, BorrowerState.WATCH, 1.08);
      
      expect(borrower.state).toBe(BorrowerState.WATCH);
      expect(borrower.stateHistory.length).toBe(2);
      expect(borrower.stateHistory[1].state).toBe(BorrowerState.WATCH);
      expect(borrower.stateHistory[1].hf).toBe(1.08);
    });
    
    it('should not update if state is the same', () => {
      const borrower = createBorrower('0x123', BorrowerState.SAFE);
      const historyLength = borrower.stateHistory.length;
      
      updateBorrowerState(borrower, BorrowerState.SAFE, 2.0);
      
      expect(borrower.state).toBe(BorrowerState.SAFE);
      expect(borrower.stateHistory.length).toBe(historyLength);
    });
    
    it('should allow reverse transitions (CRITICAL to WATCH)', () => {
      const borrower = createBorrower('0x123', BorrowerState.CRITICAL);
      
      updateBorrowerState(borrower, BorrowerState.WATCH, 1.08);
      
      expect(borrower.state).toBe(BorrowerState.WATCH);
    });
    
    it('should keep only last 100 state transitions', () => {
      const borrower = createBorrower('0x123');
      
      // Add 150 state transitions
      for (let i = 0; i < 150; i++) {
        const state = i % 2 === 0 ? BorrowerState.SAFE : BorrowerState.WATCH;
        updateBorrowerState(borrower, state, 1.0 + i * 0.01);
      }
      
      expect(borrower.stateHistory.length).toBe(100);
    });
  });
  
  describe('determineState', () => {
    const hfWatch = 1.10;
    const hfCritical = 1.04;
    const hfLiquidatable = 1.00;
    
    it('should return SAFE for HF > HF_WATCH', () => {
      expect(determineState(1.50, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.SAFE);
      expect(determineState(1.11, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.SAFE);
    });
    
    it('should return WATCH for HF_CRITICAL < HF <= HF_WATCH', () => {
      expect(determineState(1.10, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.WATCH);
      expect(determineState(1.05, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.WATCH);
    });
    
    it('should return CRITICAL for HF_LIQUIDATABLE < HF <= HF_CRITICAL', () => {
      expect(determineState(1.04, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.CRITICAL);
      expect(determineState(1.01, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.CRITICAL);
    });
    
    it('should return LIQUIDATABLE for HF <= HF_LIQUIDATABLE', () => {
      expect(determineState(1.00, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.LIQUIDATABLE);
      expect(determineState(0.99, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.LIQUIDATABLE);
      expect(determineState(0.50, hfWatch, hfCritical, hfLiquidatable)).toBe(BorrowerState.LIQUIDATABLE);
    });
  });
  
  describe('isValidStateTransition', () => {
    it('should allow all transitions (including reverse)', () => {
      // Forward transitions
      expect(isValidStateTransition(BorrowerState.SAFE, BorrowerState.WATCH)).toBe(true);
      expect(isValidStateTransition(BorrowerState.WATCH, BorrowerState.CRITICAL)).toBe(true);
      expect(isValidStateTransition(BorrowerState.CRITICAL, BorrowerState.LIQUIDATABLE)).toBe(true);
      
      // Reverse transitions
      expect(isValidStateTransition(BorrowerState.LIQUIDATABLE, BorrowerState.CRITICAL)).toBe(true);
      expect(isValidStateTransition(BorrowerState.CRITICAL, BorrowerState.WATCH)).toBe(true);
      expect(isValidStateTransition(BorrowerState.WATCH, BorrowerState.SAFE)).toBe(true);
      
      // Skip transitions
      expect(isValidStateTransition(BorrowerState.SAFE, BorrowerState.LIQUIDATABLE)).toBe(true);
    });
  });
});

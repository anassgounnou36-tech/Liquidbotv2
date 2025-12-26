import { Borrower, BorrowerState, createBorrower, updateBorrowerState, determineState } from './borrower';
import { getConfig } from '../config/env';
import logger from '../logging/logger';

// Borrower registry
class BorrowerRegistry {
  private borrowers: Map<string, Borrower> = new Map();
  private borrowerMutex: Map<string, boolean> = new Map();
  
  // Get borrower by address
  getBorrower(address: string): Borrower | undefined {
    return this.borrowers.get(address.toLowerCase());
  }
  
  // Add or update borrower
  addBorrower(address: string, state: BorrowerState = BorrowerState.SAFE): Borrower {
    const key = address.toLowerCase();
    let borrower = this.borrowers.get(key);
    
    if (!borrower) {
      borrower = createBorrower(address, state);
      this.borrowers.set(key, borrower);
      logger.info('Borrower added to registry', { address, state });
    }
    
    return borrower;
  }
  
  // Remove borrower
  removeBorrower(address: string): void {
    const key = address.toLowerCase();
    const borrower = this.borrowers.get(key);
    
    if (borrower) {
      this.borrowers.delete(key);
      logger.info('Borrower removed from registry', { address, lastState: borrower.state });
    }
  }
  
  // Get all borrowers
  getAllBorrowers(): Borrower[] {
    return Array.from(this.borrowers.values());
  }
  
  // Get borrowers by state
  getBorrowersByState(state: BorrowerState): Borrower[] {
    return this.getAllBorrowers().filter(b => b.state === state);
  }
  
  // Get borrowers in multiple states
  getBorrowersByStates(states: BorrowerState[]): Borrower[] {
    return this.getAllBorrowers().filter(b => states.includes(b.state));
  }
  
  // Update borrower HF and transition state if needed
  updateBorrowerHF(address: string, predictedHF: number, oracleHF?: number): void {
    const borrower = this.getBorrower(address);
    if (!borrower) {
      logger.warn('Attempted to update HF for unknown borrower', { address });
      return;
    }
    
    const config = getConfig();
    const now = Date.now();
    
    // Update HF values
    borrower.predictedHF = predictedHF;
    if (oracleHF !== undefined) {
      borrower.oracleHF = oracleHF;
    }
    borrower.lastHFUpdate = now;
    borrower.lastUpdatedAt = now;
    
    // Determine new state based on predicted HF
    const newState = determineState(
      predictedHF,
      config.hfWatch,
      config.hfCritical,
      config.hfLiquidatable
    );
    
    // Update state if changed
    if (newState !== borrower.state) {
      const oldState = borrower.state;
      updateBorrowerState(borrower, newState, predictedHF);
      
      logger.info('Borrower state transition', {
        address: borrower.address,
        oldState,
        newState,
        predictedHF: predictedHF.toFixed(4),
        oracleHF: borrower.oracleHF.toFixed(4)
      });
    }
  }
  
  // Mark borrower as updated (for event tracking)
  markBorrowerUpdated(address: string): void {
    const borrower = this.getBorrower(address);
    if (borrower) {
      borrower.lastEventAt = Date.now();
      borrower.lastUpdatedAt = Date.now();
    }
  }
  
  // Get registry statistics
  getStats(): {
    total: number;
    safe: number;
    watch: number;
    critical: number;
    liquidatable: number;
  } {
    const borrowers = this.getAllBorrowers();
    return {
      total: borrowers.length,
      safe: borrowers.filter(b => b.state === BorrowerState.SAFE).length,
      watch: borrowers.filter(b => b.state === BorrowerState.WATCH).length,
      critical: borrowers.filter(b => b.state === BorrowerState.CRITICAL).length,
      liquidatable: borrowers.filter(b => b.state === BorrowerState.LIQUIDATABLE).length
    };
  }
  
  // Clear registry (for testing)
  clear(): void {
    this.borrowers.clear();
    this.borrowerMutex.clear();
    logger.info('Borrower registry cleared');
  }
  
  // Borrower-level mutex methods
  
  // Try to acquire lock for borrower (returns true if acquired, false if already locked)
  tryAcquireLock(address: string): boolean {
    const key = address.toLowerCase();
    
    if (this.borrowerMutex.get(key)) {
      return false; // Already locked
    }
    
    this.borrowerMutex.set(key, true);
    return true;
  }
  
  // Release lock for borrower
  releaseLock(address: string): void {
    const key = address.toLowerCase();
    this.borrowerMutex.delete(key);
  }
  
  // Check if borrower is locked
  isLocked(address: string): boolean {
    const key = address.toLowerCase();
    return this.borrowerMutex.get(key) || false;
  }
}

// Export singleton instance
export const borrowerRegistry = new BorrowerRegistry();

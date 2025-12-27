// Borrower state enum
export enum BorrowerState {
  SAFE = 'SAFE',
  WATCH = 'WATCH',
  CRITICAL = 'CRITICAL',
  LIQUIDATABLE = 'LIQUIDATABLE'
}

// Borrower balance information
export interface BorrowerBalance {
  asset: string;
  amount: bigint;
  valueUsd: number;
}

// Cached transaction for execution
export interface CachedTransaction {
  to: string;
  data: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  expectedProfitUsd: number;
  estimatedGasUsd: number;
  preparedAt: number;
}

// Borrower data
export interface Borrower {
  address: string;
  state: BorrowerState;
  
  // Cached balances
  collateralBalances: BorrowerBalance[];
  debtBalances: BorrowerBalance[];
  
  // Health factors
  predictedHF: number; // Using off-chain prices
  oracleHF: number; // Using on-chain oracle prices
  lastHFUpdate: number;
  
  // Hydration guard: do not compute HF until balances are hydrated
  hydrated: boolean; // false for seeded borrowers until first event updates balances
  firstHydratedAt?: number; // Timestamp when first hydrated
  
  // State transition history
  stateHistory: Array<{
    state: BorrowerState;
    timestamp: number;
    hf: number;
  }>;
  
  // Cached transaction (for CRITICAL state)
  cachedTx?: CachedTransaction;
  preparedBlockNumber?: number; // Block number when tx was prepared (for TTL tracking)
  
  // Flash liquidation result (for flash loan mode)
  flashResult?: {
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
  };
  
  // Audit tracking fields
  lastSkipReason?: string; // Reason for last skip (e.g., "profit_floor", "gas_guard")
  lastPreparedBlock?: number; // Block number when last prepared
  lastExecutionAttemptAt?: number; // Timestamp of last execution attempt
  
  // Timestamps
  firstSeenAt: number;
  lastUpdatedAt: number;
  lastEventAt: number;
}

// Create a new borrower
export function createBorrower(address: string, state: BorrowerState = BorrowerState.SAFE, hydrated: boolean = false): Borrower {
  const now = Date.now();
  return {
    address,
    state,
    collateralBalances: [],
    debtBalances: [],
    predictedHF: Infinity,
    oracleHF: Infinity,
    lastHFUpdate: now,
    hydrated, // Initialize hydration status
    stateHistory: [{
      state,
      timestamp: now,
      hf: Infinity
    }],
    firstSeenAt: now,
    lastUpdatedAt: now,
    lastEventAt: now
  };
}

// Update borrower state
export function updateBorrowerState(borrower: Borrower, newState: BorrowerState, hf: number): void {
  if (borrower.state === newState) {
    return;
  }
  
  const now = Date.now();
  borrower.state = newState;
  borrower.lastUpdatedAt = now;
  borrower.stateHistory.push({
    state: newState,
    timestamp: now,
    hf
  });
  
  // Keep only last 100 state transitions
  if (borrower.stateHistory.length > 100) {
    borrower.stateHistory = borrower.stateHistory.slice(-100);
  }
}

// Determine state based on HF and thresholds
export function determineState(hf: number, hfWatch: number, hfCritical: number, hfLiquidatable: number): BorrowerState {
  if (hf <= hfLiquidatable) {
    return BorrowerState.LIQUIDATABLE;
  } else if (hf <= hfCritical) {
    return BorrowerState.CRITICAL;
  } else if (hf <= hfWatch) {
    return BorrowerState.WATCH;
  } else {
    return BorrowerState.SAFE;
  }
}

// Check if state transition is valid
export function isValidStateTransition(_from: BorrowerState, _to: BorrowerState): boolean {
  // All transitions are valid (including reverse transitions)
  return true;
}

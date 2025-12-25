import { getConfig } from '../config/env';

// Aave contract addresses
export function getAaveAddresses() {
  const config = getConfig();
  
  return {
    poolAddressProvider: config.aavePoolAddressProvider,
    pool: config.aavePoolAddress,
    oracle: config.aaveOracleAddress
  };
}

// Aave Pool ABI (minimal interface for events and liquidation)
export const AAVE_POOL_ABI = [
  // Events
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  
  // Functions
  'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))'
];

// Aave Oracle ABI (minimal interface)
export const AAVE_ORACLE_ABI = [
  'function getAssetPrice(address asset) external view returns (uint256)',
  'function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)'
];

// ERC20 ABI (minimal interface for balance checks)
export const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)'
];

// Asset addresses on Base network (must match .env configuration)
export const ASSET_ADDRESSES: Record<string, string> = {
  'WETH': '0x4200000000000000000000000000000000000006',
  'USDC': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'cbETH': '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
};

// Get asset address by symbol
export function getAssetAddress(symbol: string): string {
  const address = ASSET_ADDRESSES[symbol];
  if (!address) {
    throw new Error(`Asset address not found for symbol: ${symbol}`);
  }
  return address;
}

// Get all configured asset addresses
export function getAllAssetAddresses(): string[] {
  return Object.values(ASSET_ADDRESSES);
}

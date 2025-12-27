import { ethers } from 'ethers';
import tokenCatalog from './base.json';
import { getAssetAddress as getAssetAddressFromEnv } from '../aave/addresses';
import logger from '../logging/logger';

// Token catalog interface
export interface TokenCatalog {
  [symbol: string]: string;
}

// Standard token decimals for Base network
// Used for HF calculations when async lookups are not possible
export const TOKEN_DECIMALS: Record<string, number> = {
  'USDC': 6,
  'EURC': 6,
  'WETH': 18,
  'cbETH': 18,
  'weETH': 18,
  'wstETH': 18,
  'cbBTC': 8,
  'GHO': 18
};

// Get token decimals (synchronous, from catalog)
export function getTokenDecimalsSync(symbol: string): number {
  return TOKEN_DECIMALS[symbol] || 18; // Default to 18 decimals if unknown
}

// Get token address from catalog by symbol
export function getTokenAddress(symbol: string): string {
  // First check the token catalog
  const address = (tokenCatalog as TokenCatalog)[symbol];
  if (address) {
    return address;
  }
  
  // Fallback to env/addresses.ts for backward compatibility
  try {
    return getAssetAddressFromEnv(symbol);
  } catch (error) {
    throw new Error(`Token address not found for symbol: ${symbol}`);
  }
}

// Get token decimals by symbol (async)
export async function getTokenDecimals(
  provider: ethers.JsonRpcProvider,
  symbol: string
): Promise<number> {
  try {
    const address = getTokenAddress(symbol);
    return await getTokenDecimalsByAddress(provider, address);
  } catch (error) {
    logger.error('Failed to get decimals for token', { symbol, error });
    throw error;
  }
}

// Get token decimals by address (async)
export async function getTokenDecimalsByAddress(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<number> {
  try {
    const ERC20_ABI = ['function decimals() external view returns (uint8)'];
    const tokenContract = new ethers.Contract(address, ERC20_ABI, provider);
    const decimals = await tokenContract.decimals();
    return Number(decimals);
  } catch (error) {
    logger.error('Failed to get decimals for asset address', { address, error });
    throw error;
  }
}

// Get all token addresses from catalog
export function getAllTokenAddresses(): Record<string, string> {
  return tokenCatalog as TokenCatalog;
}

// Get token symbol by address (reverse lookup)
export function getTokenSymbol(address: string): string | undefined {
  const catalog = tokenCatalog as TokenCatalog;
  for (const [symbol, addr] of Object.entries(catalog)) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      return symbol;
    }
  }
  return undefined;
}

// Check if symbol exists in catalog
export function hasToken(symbol: string): boolean {
  return symbol in (tokenCatalog as TokenCatalog);
}

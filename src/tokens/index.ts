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

// Decimals cache to memoize decimals per token address and provide robust fallback
class DecimalsCache {
  private cache: Map<string, number> = new Map();
  private failedAddresses: Set<string> = new Set();
  
  // Get decimals with fallback to known-safe defaults
  async getDecimals(provider: ethers.JsonRpcProvider, address: string): Promise<number> {
    const normalizedAddress = address.toLowerCase();
    
    // Return cached value if available
    if (this.cache.has(normalizedAddress)) {
      return this.cache.get(normalizedAddress)!;
    }
    
    // Try to fetch from chain
    try {
      const ERC20_ABI = ['function decimals() external view returns (uint8)'];
      const tokenContract = new ethers.Contract(address, ERC20_ABI, provider);
      const decimals = await tokenContract.decimals();
      const decimalValue = Number(decimals);
      
      // Cache and return
      this.cache.set(normalizedAddress, decimalValue);
      return decimalValue;
    } catch (error) {
      // Log once for first failure
      if (!this.failedAddresses.has(normalizedAddress)) {
        logger.warn('Failed to fetch decimals from chain, using fallback', {
          address,
          error: error instanceof Error ? error.message : String(error)
        });
        this.failedAddresses.add(normalizedAddress);
      }
      
      // Fallback to known-safe defaults based on token symbol lookup
      let fallbackDecimals = 18; // Default fallback
      
      try {
        const symbol = getTokenSymbol(address);
        if (symbol && TOKEN_DECIMALS[symbol]) {
          fallbackDecimals = TOKEN_DECIMALS[symbol];
          logger.debug('Using known decimals for symbol', { address, symbol, decimals: fallbackDecimals });
        } else {
          logger.debug('Using default 18 decimals', { address });
        }
      } catch (symbolError) {
        // If symbol lookup fails, use default
        logger.debug('Symbol lookup failed, using default 18 decimals', { address });
      }
      
      // Cache the fallback value
      this.cache.set(normalizedAddress, fallbackDecimals);
      return fallbackDecimals;
    }
  }
  
  // Clear cache (for testing)
  clear(): void {
    this.cache.clear();
    this.failedAddresses.clear();
  }
}

// Singleton instance
const decimalsCache = new DecimalsCache();

// Get token decimals (synchronous, from catalog)
export function getTokenDecimalsSync(symbol: string): number {
  return TOKEN_DECIMALS[symbol] || 18; // Default to 18 decimals if unknown
}

// Get token decimals by address using cache with robust fallback
// This function has comprehensive error handling and will always return a valid decimal value
// Falls back to 18 decimals in worst case. Suitable for use in critical paths.
export async function getTokenDecimalsByAddressCached(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<number> {
  return decimalsCache.getDecimals(provider, address);
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

// Get token decimals by symbol (async) - uses cache with robust fallback
export async function getTokenDecimals(
  provider: ethers.JsonRpcProvider,
  symbol: string
): Promise<number> {
  const address = getTokenAddress(symbol);
  return await getTokenDecimalsByAddressCached(provider, address);
}

// Get token decimals by address (async) - LEGACY, prefer getTokenDecimalsByAddressCached
export async function getTokenDecimalsByAddress(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<number> {
  return await getTokenDecimalsByAddressCached(provider, address);
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

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import logger, { setLogLevel } from '../logging/logger';

// Configuration interface
export interface BotConfig {
  // Network
  rpcUrl: string;
  chainId: number;
  
  // Aave addresses
  aavePoolAddressProvider: string;
  aavePoolAddress: string;
  aaveOracleAddress: string;
  
  // Flash Liquidator
  flashLiquidatorAddress: string;
  swapRouterAddress: string;
  oneInchRouterAddress: string;
  maxSlippageBps: number;
  txCacheTtlBlocks: number;
  
  // Health Factor thresholds
  hfWatch: number;
  hfCritical: number;
  hfLiquidatable: number;
  
  // Execution parameters
  minProfitUsd: number;
  maxGasUsd: number;
  enableExecution: boolean;
  dryRun: boolean;
  maxConcurrentTx: number;
  
  // Target assets
  targetDebtAssets: string[];
  targetCollateralAssets: string[];
  
  // Price feeds
  binanceWsUrl: string;
  binanceSymbols: string[];
  binanceSymbolMap: Map<string, string>;
  pythWsUrl: string;
  pythFeedIds: string[];
  pythFeedMap: Map<string, string>;
  priceStaleMs: number;
  
  // Relay
  relayMode: 'none' | 'flashbots' | 'custom';
  privateRelayUrl: string;
  flashbotsAuthHeader: string;
  
  // Signer
  signerPk: string;
  signerKeystore: string;
  
  // Logging
  logLevel: string;
  logFile: string;
  
  // Advanced
  blockPollInterval: number;
  priceUpdateDebounce: number;
  eventConfirmations: number;
  maxTxRetry: number;
  txTimeout: number;
}

// Global config instance
let config: BotConfig;

// Callbacks for config changes
const configChangeCallbacks: Array<(config: BotConfig) => void> = [];

// Parse environment variables into config
function parseConfig(): BotConfig {
  return {
    // Network
    rpcUrl: process.env.RPC_URL_BASE || '',
    chainId: parseInt(process.env.CHAIN_ID || '8453', 10),
    
    // Aave addresses
    aavePoolAddressProvider: process.env.AAVE_POOL_ADDRESS_PROVIDER || '',
    aavePoolAddress: process.env.AAVE_POOL_ADDRESS || '',
    aaveOracleAddress: process.env.AAVE_ORACLE_ADDRESS || '',
    
    // Flash Liquidator
    flashLiquidatorAddress: process.env.FLASH_LIQUIDATOR_ADDRESS || '',
    swapRouterAddress: process.env.SWAP_ROUTER_ADDRESS || '',
    oneInchRouterAddress: process.env.ONEINCH_ROUTER_ADDRESS || '0x1111111254EEB25477B68fb85Ed929f73A960582',
    maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50', 10),
    txCacheTtlBlocks: parseInt(process.env.TX_CACHE_TTL_BLOCKS || '5', 10),
    
    // Health Factor thresholds
    hfWatch: parseFloat(process.env.HF_WATCH || '1.10'),
    hfCritical: parseFloat(process.env.HF_CRITICAL || '1.04'),
    hfLiquidatable: parseFloat(process.env.HF_LIQUIDATABLE || '1.000'),
    
    // Execution parameters
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '50'),
    maxGasUsd: parseFloat(process.env.MAX_GAS_USD || '20'),
    enableExecution: process.env.ENABLE_EXECUTION === 'true',
    dryRun: process.env.DRY_RUN !== 'false',
    maxConcurrentTx: parseInt(process.env.MAX_CONCURRENT_TX || '1', 10),
    
    // Target assets
    targetDebtAssets: (process.env.TARGET_DEBT_ASSETS || 'USDC').split(',').map(s => s.trim()),
    targetCollateralAssets: (process.env.TARGET_COLLATERAL_ASSETS || 'WETH,cbETH').split(',').map(s => s.trim()),
    
    // Price feeds
    binanceWsUrl: process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws',
    binanceSymbols: (process.env.PRICE_BINANCE_SYMBOLS || 'ETHUSDT,USDCUSDT').split(',').map(s => s.trim()),
    binanceSymbolMap: parseMapFromEnv(process.env.BINANCE_SYMBOL_MAP || 'WETH:ETHUSDT,USDC:USDCUSDT,cbETH:ETHUSDT'),
    pythWsUrl: process.env.PYTH_WS_URL || 'wss://hermes.pyth.network/ws',
    pythFeedIds: (process.env.PYTH_PRICE_FEED_IDS || '').split(',').map(s => s.trim()).filter(s => s),
    pythFeedMap: parseMapFromEnv(process.env.PYTH_FEED_MAP || ''),
    priceStaleMs: parseInt(process.env.PRICE_STALE_MS || '5000', 10),
    
    // Relay
    relayMode: (process.env.RELAY_MODE || 'none') as 'none' | 'flashbots' | 'custom',
    privateRelayUrl: process.env.PRIVATE_RELAY_URL || '',
    flashbotsAuthHeader: process.env.FLASHBOTS_AUTH_HEADER || '',
    
    // Signer
    signerPk: process.env.SIGNER_PK || '',
    signerKeystore: process.env.SIGNER_KEYSTORE || '',
    
    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    logFile: process.env.LOG_FILE || '',
    
    // Advanced
    blockPollInterval: parseInt(process.env.BLOCK_POLL_INTERVAL || '1000', 10),
    priceUpdateDebounce: parseInt(process.env.PRICE_UPDATE_DEBOUNCE || '500', 10),
    eventConfirmations: parseInt(process.env.EVENT_CONFIRMATIONS || '0', 10),
    maxTxRetry: parseInt(process.env.MAX_TX_RETRY || '1', 10),
    txTimeout: parseInt(process.env.TX_TIMEOUT || '60', 10),
  };
}

// Parse map from environment variable (format: KEY1:VALUE1,KEY2:VALUE2)
function parseMapFromEnv(envValue: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!envValue) return map;
  
  const pairs = envValue.split(',');
  for (const pair of pairs) {
    const [key, value] = pair.split(':').map(s => s.trim());
    if (key && value) {
      map.set(key, value);
    }
  }
  return map;
}

// Load configuration
export function loadConfig(): BotConfig {
  // Load .env file
  dotenv.config();
  
  // Parse config
  config = parseConfig();
  
  // Update log level
  setLogLevel(config.logLevel);
  
  logger.info('Configuration loaded', {
    dryRun: config.dryRun,
    enableExecution: config.enableExecution,
    chainId: config.chainId,
    relayMode: config.relayMode
  });
  
  return config;
}

// Get current configuration
export function getConfig(): BotConfig {
  if (!config) {
    throw new Error('Configuration not loaded. Call loadConfig() first.');
  }
  return config;
}

// Register callback for config changes
export function onConfigChange(callback: (config: BotConfig) => void): void {
  configChangeCallbacks.push(callback);
}

// Watch .env file for changes and reload
export function watchConfig(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  
  // Check if .env file exists
  if (!fs.existsSync(envPath)) {
    logger.warn('.env file not found. Hot-reload disabled.');
    return;
  }
  
  logger.info('Watching .env file for changes...');
  
  const watcher = chokidar.watch(envPath, {
    persistent: true,
    ignoreInitial: true
  });
  
  watcher.on('change', () => {
    logger.info('.env file changed. Reloading configuration...');
    
    try {
      // Reload environment variables
      dotenv.config({ override: true });
      
      // Parse new config
      const newConfig = parseConfig();
      
      // Update log level if changed
      if (newConfig.logLevel !== config.logLevel) {
        setLogLevel(newConfig.logLevel);
      }
      
      // Update global config
      config = newConfig;
      
      logger.info('Configuration reloaded successfully', {
        hfWatch: config.hfWatch,
        hfCritical: config.hfCritical,
        hfLiquidatable: config.hfLiquidatable,
        minProfitUsd: config.minProfitUsd,
        maxGasUsd: config.maxGasUsd
      });
      
      // Notify callbacks
      for (const callback of configChangeCallbacks) {
        try {
          callback(config);
        } catch (error) {
          logger.error('Error in config change callback', { error });
        }
      }
    } catch (error) {
      logger.error('Failed to reload configuration', { error });
    }
  });
}

// Validate configuration
export function validateConfig(): void {
  const errors: string[] = [];
  
  if (!config.rpcUrl) {
    errors.push('RPC_URL_BASE is required');
  }
  
  if (!config.aavePoolAddress) {
    errors.push('AAVE_POOL_ADDRESS is required');
  }
  
  if (!config.aaveOracleAddress) {
    errors.push('AAVE_ORACLE_ADDRESS is required');
  }
  
  if (config.enableExecution && config.dryRun) {
    logger.warn('ENABLE_EXECUTION is true but DRY_RUN is also true. No transactions will be executed.');
  }
  
  if (config.enableExecution && !config.dryRun && !config.signerPk && !config.signerKeystore) {
    errors.push('SIGNER_PK or SIGNER_KEYSTORE is required when ENABLE_EXECUTION=true and DRY_RUN=false');
  }
  
  if (config.hfWatch <= config.hfCritical) {
    errors.push('HF_WATCH must be greater than HF_CRITICAL');
  }
  
  if (config.hfCritical <= config.hfLiquidatable) {
    errors.push('HF_CRITICAL must be greater than HF_LIQUIDATABLE');
  }
  
  if (errors.length > 0) {
    logger.error('Configuration validation failed', { errors });
    throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
  }
  
  logger.info('Configuration validated successfully');
}

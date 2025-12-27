import { EventEmitter } from 'events';
import { BinancePriceFeed } from './binance';
import { PythPriceFeed } from './pyth';
import { PriceData } from '../hf/calc';
import { getConfig } from '../config/env';
import logger from '../logging/logger';

// Price aggregator that combines multiple price sources
export class PriceAggregator extends EventEmitter {
  private binanceFeed?: BinancePriceFeed;
  private pythFeed?: PythPriceFeed;
  private prices: Map<string, PriceData> = new Map();
  private updateDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Track last update timestamps for staleness checks
  private lastBinanceUpdate: number = 0;
  private lastPythUpdate: number = 0;
  private binanceConnected: boolean = false;
  private pythConnected: boolean = false;
  
  constructor() {
    super();
  }
  
  // Initialize price feeds
  initialize(): void {
    const config = getConfig();
    
    // Initialize Binance feed
    if (config.binanceSymbols.length > 0) {
      this.binanceFeed = new BinancePriceFeed(config.binanceSymbols);
      
      this.binanceFeed.on('price', (priceData: PriceData) => {
        this.lastBinanceUpdate = Date.now();
        this.handlePriceUpdate(priceData);
      });
      
      this.binanceFeed.on('connected', () => {
        this.binanceConnected = true;
        this.lastBinanceUpdate = Date.now();
        logger.info('Binance price feed connected');
      });
      
      this.binanceFeed.on('error', (error: Error) => {
        this.binanceConnected = false;
        logger.error('Binance price feed error', { error: error.message });
      });
      
      this.binanceFeed.connect();
    }
    
    // Initialize Pyth feed
    if (config.pythFeedIds.length > 0) {
      this.pythFeed = new PythPriceFeed(config.pythFeedIds);
      
      this.pythFeed.on('price', (priceData: PriceData) => {
        this.lastPythUpdate = Date.now();
        this.handlePriceUpdate(priceData);
      });
      
      this.pythFeed.on('connected', () => {
        this.pythConnected = true;
        this.lastPythUpdate = Date.now();
        logger.info('Pyth price feed connected');
      });
      
      this.pythFeed.on('error', (error: Error) => {
        this.pythConnected = false;
        logger.error('Pyth price feed error', { error: error.message });
      });
      
      this.pythFeed.connect();
    }
    
    logger.info('Price aggregator initialized');
  }
  
  // Handle price update from any source
  private handlePriceUpdate(priceData: PriceData): void {
    const { asset } = priceData;
    
    // Update stored price
    this.prices.set(asset, priceData);
    
    // Debounce price updates to avoid excessive recomputation
    const config = getConfig();
    const existingTimer = this.updateDebounceTimers.get(asset);
    
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timer = setTimeout(() => {
      this.updateDebounceTimers.delete(asset);
      this.emit('priceUpdate', priceData);
      
      logger.debug('Price updated', {
        asset: priceData.asset,
        price: priceData.priceUsd.toFixed(2),
        source: priceData.source
      });
    }, config.priceUpdateDebounce);
    
    this.updateDebounceTimers.set(asset, timer);
  }
  
  // Get current price for an asset
  getPrice(asset: string): PriceData | undefined {
    return this.prices.get(asset);
  }
  
  // Get all current prices
  getAllPrices(): Map<string, PriceData> {
    return new Map(this.prices);
  }
  
  // Check if price is available for asset
  hasPrice(asset: string): boolean {
    return this.prices.has(asset);
  }
  
  // Get price age in milliseconds
  getPriceAge(asset: string): number | null {
    const priceData = this.prices.get(asset);
    if (!priceData) return null;
    
    return Date.now() - priceData.timestamp;
  }
  
  // Check if all required assets have prices
  hasAllPrices(assets: string[]): boolean {
    return assets.every(asset => this.hasPrice(asset));
  }
  
  // Disconnect all feeds
  disconnect(): void {
    if (this.binanceFeed) {
      this.binanceFeed.disconnect();
    }
    
    if (this.pythFeed) {
      this.pythFeed.disconnect();
    }
    
    // Clear debounce timers
    for (const timer of this.updateDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.updateDebounceTimers.clear();
    
    logger.info('Price aggregator disconnected');
  }
  
  // Get connection status
  getStatus(): {
    binance: boolean;
    pyth: boolean;
    priceCount: number;
  } {
    return {
      binance: this.binanceFeed?.isActive() || false,
      pyth: this.pythFeed?.isActive() || false,
      priceCount: this.prices.size
    };
  }
  
  // Check if prices are stale
  isPriceStale(priceStaleMs: number): boolean {
    const now = Date.now();
    
    // Check if either configured feed is stale
    let hasStale = false;
    
    if (this.binanceFeed && this.binanceConnected) {
      const binanceStale = (now - this.lastBinanceUpdate > priceStaleMs);
      if (binanceStale) hasStale = true;
    }
    
    if (this.pythFeed && this.pythConnected) {
      const pythStale = (now - this.lastPythUpdate > priceStaleMs);
      if (pythStale) hasStale = true;
    }
    
    return hasStale;
  }
  
  // Check if feeds are connected
  areFeedsConnected(): boolean {
    // At least one feed must be connected
    return this.binanceConnected || this.pythConnected;
  }
  
  // Check if execution should be allowed based on price feed policy
  // Policy: Binance OR Pyth must be live (fail-closed)
  canExecuteLiquidation(priceStaleMs: number): { allowed: boolean; reason?: string } {
    const now = Date.now();
    
    // Check if Binance is live (connected and not stale)
    const binanceLive = this.binanceConnected && 
                        this.lastBinanceUpdate > 0 && 
                        (now - this.lastBinanceUpdate <= priceStaleMs);
    
    // Check if Pyth is live (connected and not stale)
    const pythLive = this.pythConnected && 
                     this.lastPythUpdate > 0 && 
                     (now - this.lastPythUpdate <= priceStaleMs);
    
    // At least one feed must be live
    if (binanceLive || pythLive) {
      return { allowed: true };
    }
    
    // Both feeds are down or stale - fail closed
    return {
      allowed: false,
      reason: `Both price feeds are stale or disconnected. Binance: ${binanceLive ? 'live' : 'stale/down'}, Pyth: ${pythLive ? 'live' : 'stale/down'}`
    };
  }
  
  // Get detailed feed status for each source
  getFeedStatus(priceStaleMs: number): {
    binance: { connected: boolean; live: boolean; ageMs: number };
    pyth: { connected: boolean; live: boolean; ageMs: number };
  } {
    const now = Date.now();
    
    const binanceAge = this.lastBinanceUpdate > 0 ? now - this.lastBinanceUpdate : -1;
    const binanceLive = this.binanceConnected && binanceAge >= 0 && binanceAge <= priceStaleMs;
    
    const pythAge = this.lastPythUpdate > 0 ? now - this.lastPythUpdate : -1;
    const pythLive = this.pythConnected && pythAge >= 0 && pythAge <= priceStaleMs;
    
    return {
      binance: {
        connected: this.binanceConnected,
        live: binanceLive,
        ageMs: binanceAge
      },
      pyth: {
        connected: this.pythConnected,
        live: pythLive,
        ageMs: pythAge
      }
    };
  }
  
  // Get price staleness info (kept for backward compatibility)
  getStalenessInfo(): {
    binanceAge: number;
    pythAge: number;
    binanceConnected: boolean;
    pythConnected: boolean;
  } {
    const now = Date.now();
    return {
      binanceAge: this.lastBinanceUpdate > 0 ? now - this.lastBinanceUpdate : -1,
      pythAge: this.lastPythUpdate > 0 ? now - this.lastPythUpdate : -1,
      binanceConnected: this.binanceConnected,
      pythConnected: this.pythConnected
    };
  }
}

// Export singleton instance
export const priceAggregator = new PriceAggregator();

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
        this.handlePriceUpdate(priceData);
      });
      
      this.binanceFeed.on('connected', () => {
        logger.info('Binance price feed connected');
      });
      
      this.binanceFeed.on('error', (error: Error) => {
        logger.error('Binance price feed error', { error: error.message });
      });
      
      this.binanceFeed.connect();
    }
    
    // Initialize Pyth feed
    if (config.pythFeedIds.length > 0) {
      this.pythFeed = new PythPriceFeed(config.pythFeedIds);
      
      this.pythFeed.on('price', (priceData: PriceData) => {
        this.handlePriceUpdate(priceData);
      });
      
      this.pythFeed.on('connected', () => {
        logger.info('Pyth price feed connected');
      });
      
      this.pythFeed.on('error', (error: Error) => {
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
}

// Export singleton instance
export const priceAggregator = new PriceAggregator();

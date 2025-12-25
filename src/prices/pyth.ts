import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getConfig } from '../config/env';
import logger from '../logging/logger';
import { PriceData } from '../hf/calc';

// Pyth price feed connector
export class PythPriceFeed extends EventEmitter {
  private ws?: WebSocket;
  private feedIds: string[];
  private reconnectInterval: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private lastPrices: Map<string, PriceData> = new Map();
  
  constructor(feedIds: string[]) {
    super();
    this.feedIds = feedIds;
  }
  
  // Connect to Pyth WebSocket
  connect(): void {
    const config = getConfig();
    
    logger.info('Connecting to Pyth WebSocket', { feedCount: this.feedIds.length });
    
    try {
      this.ws = new WebSocket(config.pythWsUrl);
      
      this.ws.on('open', () => {
        this.isConnected = true;
        logger.info('Pyth WebSocket connected');
        this.emit('connected');
        
        // Subscribe to price feeds
        this.subscribe();
      });
      
      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          logger.error('Error parsing Pyth message', { error });
        }
      });
      
      this.ws.on('error', (error: Error) => {
        logger.error('Pyth WebSocket error', { error: error.message });
        this.emit('error', error);
      });
      
      this.ws.on('close', () => {
        this.isConnected = false;
        logger.warn('Pyth WebSocket disconnected');
        this.emit('disconnected');
        this.scheduleReconnect();
      });
    } catch (error) {
      logger.error('Failed to connect to Pyth WebSocket', { error });
      this.scheduleReconnect();
    }
  }
  
  // Subscribe to price feeds
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    
    if (this.feedIds.length === 0) {
      logger.warn('No Pyth feed IDs configured');
      return;
    }
    
    const subscribeMessage = {
      type: 'subscribe',
      ids: this.feedIds
    };
    
    this.ws.send(JSON.stringify(subscribeMessage));
    logger.info('Subscribed to Pyth price feeds', { count: this.feedIds.length });
  }
  
  // Handle incoming message
  private handleMessage(message: any): void {
    // Pyth sends different message types
    if (message.type === 'price_update') {
      this.handlePriceUpdate(message);
    }
  }
  
  // Handle price update
  private handlePriceUpdate(message: any): void {
    const priceFeeds = message.price_feeds || [];
    
    for (const feed of priceFeeds) {
      const feedId = feed.id;
      const price = feed.price;
      
      if (!feedId || !price) continue;
      
      // Parse price and expo
      const priceValue = parseFloat(price.price);
      const expo = parseInt(price.expo);
      const priceUsd = priceValue * Math.pow(10, expo);
      
      if (isNaN(priceUsd)) continue;
      
      // Map feed ID to asset
      const config = getConfig();
      let asset: string | undefined;
      
      for (const [assetName, pythFeedId] of config.pythFeedMap) {
        if (pythFeedId.toLowerCase() === feedId.toLowerCase()) {
          asset = assetName;
          break;
        }
      }
      
      if (!asset) {
        logger.debug('Unknown Pyth feed ID', { feedId });
        continue;
      }
      
      const priceData: PriceData = {
        asset,
        priceUsd,
        timestamp: Date.now(),
        source: 'pyth'
      };
      
      this.lastPrices.set(asset, priceData);
      
      // Emit price update event
      this.emit('price', priceData);
    }
  }
  
  // Schedule reconnection
  private scheduleReconnect(): void {
    if (this.reconnectInterval) return;
    
    logger.info('Scheduling Pyth WebSocket reconnection in 5 seconds');
    this.reconnectInterval = setTimeout(() => {
      this.reconnectInterval = null;
      this.connect();
    }, 5000);
  }
  
  // Disconnect
  disconnect(): void {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    
    this.isConnected = false;
    logger.info('Pyth WebSocket disconnected');
  }
  
  // Get last known prices
  getLastPrices(): Map<string, PriceData> {
    return new Map(this.lastPrices);
  }
  
  // Check connection status
  isActive(): boolean {
    return this.isConnected;
  }
}

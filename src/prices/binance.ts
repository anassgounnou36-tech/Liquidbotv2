import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getConfig } from '../config/env';
import logger from '../logging/logger';
import { PriceData } from '../hf/calc';

// Binance price feed connector
export class BinancePriceFeed extends EventEmitter {
  private ws?: WebSocket;
  private symbols: string[];
  private reconnectInterval: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private lastPrices: Map<string, PriceData> = new Map();
  
  constructor(symbols: string[]) {
    super();
    this.symbols = symbols.map(s => s.toLowerCase());
  }
  
  // Connect to Binance WebSocket
  connect(): void {
    const config = getConfig();
    const streams = this.symbols.map(s => `${s}@ticker`).join('/');
    const wsUrl = `${config.binanceWsUrl}/stream?streams=${streams}`;
    
    logger.info('Connecting to Binance WebSocket', { symbols: this.symbols });
    
    try {
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        this.isConnected = true;
        logger.info('Binance WebSocket connected');
        this.emit('connected');
      });
      
      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          logger.error('Error parsing Binance message', { error });
        }
      });
      
      this.ws.on('error', (error: Error) => {
        logger.error('Binance WebSocket error', { error: error.message });
        this.emit('error', error);
      });
      
      this.ws.on('close', () => {
        this.isConnected = false;
        logger.warn('Binance WebSocket disconnected');
        this.emit('disconnected');
        this.scheduleReconnect();
      });
    } catch (error) {
      logger.error('Failed to connect to Binance WebSocket', { error });
      this.scheduleReconnect();
    }
  }
  
  // Handle incoming message
  private handleMessage(message: any): void {
    if (!message.data) return;
    
    const data = message.data;
    const symbol = data.s; // e.g., "ETHUSDT"
    const price = parseFloat(data.c); // Current price
    
    if (!symbol || isNaN(price)) return;
    
    // Map symbol to asset (e.g., ETHUSDT -> WETH)
    const config = getConfig();
    let asset: string = '';
    
    for (const [assetName, binanceSymbol] of config.binanceSymbolMap) {
      if (binanceSymbol.toLowerCase() === symbol.toLowerCase()) {
        asset = assetName;
        break;
      }
    }
    
    if (!asset) {
      // Try to extract asset from symbol (e.g., ETHUSDT -> ETH)
      asset = symbol.replace('USDT', '').replace('USDC', '').toUpperCase();
      if (asset === 'ETH') asset = 'WETH';
    }
    
    if (!asset) {
      logger.warn('Could not map Binance symbol to asset', { symbol });
      return;
    }
    
    const priceData: PriceData = {
      asset,
      priceUsd: price,
      timestamp: Date.now(),
      source: 'binance'
    };
    
    this.lastPrices.set(asset, priceData);
    
    // Emit price update event
    this.emit('price', priceData);
  }
  
  // Schedule reconnection
  private scheduleReconnect(): void {
    if (this.reconnectInterval) return;
    
    logger.info('Scheduling Binance WebSocket reconnection in 5 seconds');
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
    logger.info('Binance WebSocket disconnected');
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

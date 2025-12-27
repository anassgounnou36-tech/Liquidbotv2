import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getConfig } from '../config/env';
import logger from '../logging/logger';
import { PriceData } from '../hf/calc';

function buildCombinedStreamUrl(baseUrl: string, symbols: string[]): string {
  // Ensure base is root (no trailing /ws or /stream)
  const normalized = baseUrl.replace(/\/ws$/i, '').replace(/\/stream$/i, '');
  const streams = symbols.map(s => `${s.toLowerCase()}@trade`).join('/');
  return `${normalized}/stream?streams=${streams}`;
}

// Binance price feed connector using combined streams
export class BinancePriceFeed extends EventEmitter {
  private ws?: WebSocket;
  private symbols: string[];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected: boolean = false;
  private lastPrices: Map<string, PriceData> = new Map();

  constructor(symbols: string[]) {
    super();
    this.symbols = symbols.map(s => s.toLowerCase());
  }

  connect(): void {
    const cfg = getConfig();
    const wsUrl = buildCombinedStreamUrl(cfg.binanceWsUrl, this.symbols);

    logger.info('Connecting to Binance WebSocket', { symbols: this.symbols });
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.connected = true;
        logger.info('Binance WebSocket connected');
        this.emit('connected');
        // IMPORTANT: Do not send SUBSCRIBE messages — combined streams are already active
      });

      this.ws.on('message', (raw: WebSocket.Data) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleCombinedMessage(msg);
        } catch (error) {
          logger.error('Error parsing Binance message', { error });
        }
      });

      this.ws.on('error', (error: Error) => {
        logger.error('Binance WebSocket error', { error: error.message });
        this.emit('error', error);
      });

      this.ws.on('close', () => {
        this.connected = false;
        logger.warn('Binance WebSocket disconnected');
        this.emit('disconnected');
        this.scheduleReconnect();
      });
    } catch (error) {
      logger.error('Failed to connect to Binance WebSocket', { error });
      this.scheduleReconnect();
    }
  }

  // Combined stream format:
  // {
  //   "stream": "ethusdt@trade",
  //   "data": { "p": "2450.12", "T": 1712345678901, "s": "ETHUSDT", ... }
  // }
  private handleCombinedMessage(message: any): void {
    const streamName: string | undefined = message?.stream;
    const data = message?.data;
    if (!streamName || !data) return;

    // Prefer stream-derived symbol for robustness
    const streamSymbol = streamName.split('@')[0]; // e.g., 'ethusdt'
    const symbol = (data.s || streamSymbol).toString().toUpperCase(); // 'ETHUSDT', 'USDCUSDT'
    const priceStr = data.p; // trade price
    const ts = data.T; // trade time

    const price = parseFloat(priceStr);
    if (!symbol || isNaN(price)) return;

    // Map symbol to asset using env BINANCE_SYMBOL_MAP; fallback by stripping quote
    const cfg = getConfig();
    let asset = '';
    for (const [assetName, binanceSymbol] of cfg.binanceSymbolMap) {
      if (binanceSymbol.toLowerCase() === symbol.toLowerCase()) {
        asset = assetName;
        break;
      }
    }
    if (!asset) {
      // Fallback: strip USDT/USDC; map ETH->WETH
      asset = symbol.replace('USDT', '').replace('USDC', '');
      if (asset === 'ETH') asset = 'WETH';
    }
    if (!asset) {
      logger.warn('Could not map Binance symbol to asset', { symbol });
      return;
    }

    const priceData: PriceData = {
      asset,
      priceUsd: price,
      timestamp: typeof ts === 'number' ? ts : Date.now(),
      source: 'binance'
    };

    this.lastPrices.set(asset, priceData);
    this.emit('price', priceData);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = 2000; // 2s per guidance (1–3s)
    logger.info('Scheduling Binance WebSocket reconnection', { delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.connected = false;
    logger.info('Binance WebSocket disconnected');
  }

  getLastPrices(): Map<string, PriceData> {
    return new Map(this.lastPrices);
  }

  isActive(): boolean {
    return this.connected;
  }
}

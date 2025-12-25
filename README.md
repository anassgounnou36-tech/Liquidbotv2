# Aave v3 Liquidation Bot for Base Network

A production-grade, event-driven liquidation bot for Aave v3 on Base network, built with TypeScript and ethers.js.

## 🎯 Features

- **Event-Driven Architecture**: Reacts to price changes and Aave events instead of polling
- **State Machine**: Borrowers transition through SAFE → WATCH → CRITICAL → LIQUIDATABLE states
- **Off-Chain Price Prediction**: Uses Binance and Pyth WebSocket feeds for fast price updates
- **Oracle Confirmation**: Verifies liquidation legality with on-chain oracle before execution
- **Hot-Reloadable Configuration**: Update thresholds without restarting the bot
- **Private Relay Support**: Abstraction for Flashbots or custom relay integration
- **Comprehensive Logging**: Structured logs for monitoring and auditing
- **Capital Preservation**: Strict profit/gas checks before execution

## 🏗️ Architecture

### State Machine

```
SAFE → WATCH → CRITICAL → LIQUIDATABLE
  ↑      ↑         ↑           ↑
  └──────┴─────────┴───────────┘
    (Reverse transitions allowed)
```

- **SAFE**: HF > HF_WATCH (default: 1.10)
- **WATCH**: HF_CRITICAL < HF ≤ HF_WATCH (default: 1.04 < HF ≤ 1.10)
- **CRITICAL**: HF_LIQUIDATABLE < HF ≤ HF_CRITICAL (default: 1.00 < HF ≤ 1.04)
- **LIQUIDATABLE**: HF ≤ HF_LIQUIDATABLE (default: 1.00)

### Components

1. **Price Feeds**: Binance WebSocket + Pyth WebSocket for real-time prices
2. **Event Listeners**: Monitor Borrow, Repay, Liquidation events from Aave
3. **Block Loop**: Light operations only on WATCH/CRITICAL borrowers
4. **Execution Engine**: Simulate, verify, and execute liquidations

## 📦 Installation

### Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn
- RPC endpoint for Base network (Alchemy, Infura, or public RPC)

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd Liquidbotv2

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Edit .env with your configuration
nano .env
```

## ⚙️ Configuration

All configuration is done via the `.env` file. The bot supports hot-reloading, so you can update thresholds without restarting.

### Required Configuration

```env
# Network
RPC_URL_BASE=https://mainnet.base.org
CHAIN_ID=8453

# Aave Addresses
AAVE_POOL_ADDRESS_PROVIDER=0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D
AAVE_POOL_ADDRESS=0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
AAVE_ORACLE_ADDRESS=0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156

# Health Factor Thresholds (hot-reloadable)
HF_WATCH=1.10
HF_CRITICAL=1.04
HF_LIQUIDATABLE=1.000

# Execution Parameters (hot-reloadable)
MIN_PROFIT_USD=50
MAX_GAS_USD=20
ENABLE_EXECUTION=false
DRY_RUN=true
MAX_CONCURRENT_TX=1

# Target Assets
TARGET_DEBT_ASSETS=USDC
TARGET_COLLATERAL_ASSETS=WETH,cbETH

# Private Key (KEEP SECURE!)
SIGNER_PK=your_private_key_here
```

### Optional Configuration

See `.env.example` for all available configuration options including:
- Price feed mappings (Binance, Pyth)
- Private relay settings
- Logging configuration
- Advanced parameters

## 🚀 Usage

### Development Mode

```bash
# Run in development with ts-node
npm run dev
```

### Production Mode

```bash
# Build TypeScript
npm run build

# Start the bot
npm start
```

### Testing

```bash
# Run tests
npm test
```

## 🔒 Security

### Hard Rules (Never Violated)

- ❌ Do NOT recompute HF for all borrowers per block
- ❌ Do NOT poll prices per block
- ❌ Do NOT trust Chainlink as primary signal
- ❌ Do NOT broadcast to public mempool by default
- ❌ Do NOT execute unless all conditions are met

### Best Practices

1. **Start in DRY_RUN mode**: Test configuration before enabling execution
2. **Use private relay**: Configure Flashbots or custom relay for production
3. **Secure private key**: Use environment variables, never commit keys
4. **Monitor logs**: Review state transitions and execution attempts
5. **Set conservative thresholds**: Higher MIN_PROFIT_USD reduces risk

## 📊 Monitoring

The bot logs comprehensive information:

- **State Transitions**: When borrowers move between states
- **HF Changes**: Predicted vs oracle HF comparison
- **Price Updates**: Real-time price feed updates
- **Transaction Lifecycle**: Preparation, execution, confirmation
- **Profit/Loss**: Expected and actual profit from liquidations

### Log Levels

```env
LOG_LEVEL=info  # Options: error, warn, info, debug, verbose
```

### Statistics

The bot logs statistics every 100 blocks:

```
Bot statistics: {
  borrowers: { total: 50, safe: 45, watch: 3, critical: 2, liquidatable: 0 },
  priceFeeds: { binance: true, pyth: true, priceCount: 3 },
  activeLiquidations: 0
}
```

## 🐳 Docker Deployment

```bash
# Build Docker image
docker build -t liquidation-bot .

# Run container
docker run -d \
  --name liquidation-bot \
  --env-file .env \
  --restart unless-stopped \
  liquidation-bot
```

## 🔧 Advanced Configuration

### Hot-Reloadable Parameters

These parameters can be updated in `.env` while the bot is running:

- `HF_WATCH`, `HF_CRITICAL`, `HF_LIQUIDATABLE`
- `MIN_PROFIT_USD`, `MAX_GAS_USD`
- `LOG_LEVEL`
- `ENABLE_EXECUTION`, `DRY_RUN`

The bot will automatically reload the configuration when `.env` is saved.

### Private Relay Configuration

#### Flashbots (Placeholder)

```env
RELAY_MODE=flashbots
PRIVATE_RELAY_URL=https://relay.flashbots.net
FLASHBOTS_AUTH_HEADER=your_auth_header
```

#### Custom Relay (Placeholder)

```env
RELAY_MODE=custom
PRIVATE_RELAY_URL=https://your-relay-endpoint.com
```

**Note**: Flashbots and custom relay integrations are placeholders. Implement the actual integration in `src/execution/broadcast.ts` for production use.

### PM2 Process Manager

```bash
# Install PM2
npm install -g pm2

# Start bot with PM2
pm2 start dist/index.js --name liquidation-bot

# Monitor
pm2 logs liquidation-bot
pm2 monit

# Auto-restart on reboot
pm2 startup
pm2 save
```

### Systemd Service

Create `/etc/systemd/system/liquidation-bot.service`:

```ini
[Unit]
Description=Aave v3 Liquidation Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/path/to/Liquidbotv2
ExecStart=/usr/bin/node /path/to/Liquidbotv2/dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable liquidation-bot
sudo systemctl start liquidation-bot
sudo systemctl status liquidation-bot
```

## 📁 Project Structure

```
Liquidbotv2/
├── src/
│   ├── aave/
│   │   ├── addresses.ts    # Aave contract addresses and ABIs
│   │   └── events.ts       # Event listeners for Aave Pool
│   ├── config/
│   │   └── env.ts          # Configuration with hot-reload
│   ├── execution/
│   │   ├── broadcast.ts    # Transaction broadcasting
│   │   ├── sim.ts          # Liquidation simulation
│   │   └── tx.ts           # Transaction building
│   ├── hf/
│   │   └── calc.ts         # Health Factor calculation
│   ├── logging/
│   │   └── logger.ts       # Structured logging
│   ├── prices/
│   │   ├── binance.ts      # Binance WebSocket feed
│   │   ├── pyth.ts         # Pyth WebSocket feed
│   │   └── index.ts        # Price aggregator
│   ├── state/
│   │   ├── borrower.ts     # Borrower types and state machine
│   │   └── registry.ts     # Borrower registry
│   └── index.ts            # Main bot lifecycle
├── tests/
│   ├── hf.test.ts          # Health Factor tests
│   └── state.test.ts       # State machine tests
├── .env.example            # Example configuration
├── .gitignore
├── Chatgpt.txt             # Bot specification
├── Dockerfile              # Docker configuration
├── jest.config.js          # Jest test configuration
├── package.json
├── README.md               # This file
└── tsconfig.json           # TypeScript configuration
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- tests/state.test.ts
```

## 🤝 Contributing

This is a production bot. Before making changes:

1. Review the specification in `Chatgpt.txt`
2. Maintain the event-driven architecture
3. Follow the hard rules
4. Add tests for new features
5. Update documentation

## ⚠️ Disclaimer

This bot is provided as-is for educational and operational purposes. Users are responsible for:

- Testing thoroughly before production use
- Securing private keys and credentials
- Understanding liquidation mechanics
- Monitoring bot performance
- Complying with applicable regulations

Liquidation involves financial risk. Only use with funds you can afford to lose.

## 📝 License

MIT License - See LICENSE file for details

## 🔗 Resources

- [Aave v3 Documentation](https://docs.aave.com/developers/getting-started/readme)
- [Base Network](https://base.org/)
- [Pyth Network](https://pyth.network/)
- [Binance WebSocket API](https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams)
- [ethers.js Documentation](https://docs.ethers.org/)

## 📞 Support

For issues and questions:
- Review `Chatgpt.txt` for bot specification
- Check logs for error messages
- Verify configuration in `.env`
- Test with DRY_RUN=true first

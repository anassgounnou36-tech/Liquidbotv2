# Aave v3 Liquidation Bot for Base Network

A production-grade, event-driven liquidation bot for Aave v3 on Base network, built with TypeScript and ethers.js.

## 🎯 Features

- **Event-Driven Architecture**: Reacts to price changes and Aave events instead of polling
- **Startup Seed Scan**: One-time historical scan of Borrow events to discover existing borrowers
- **MIN_DEBT_USD Filtering**: Only tracks borrowers with debt above configurable threshold
- **Candidate Cap**: Limits maximum borrowers tracked with early-stop optimization
- **Balancer Flash Loans**: Zero-capital liquidations using Balancer V2 flash loans
- **1inch Integration**: Real collateral-to-debt swaps using 1inch aggregation router
- **State Machine**: Borrowers transition through SAFE → WATCH → CRITICAL → LIQUIDATABLE states
- **Off-Chain Price Prediction**: Uses Binance and Pyth WebSocket feeds for fast price updates
- **Price Staleness Guards**: Aborts execution if price feeds are stale or disconnected
- **Fail-Closed Policy**: Requires at least one price feed (Binance OR Pyth) to be live
- **Oracle Confirmation**: Verifies liquidation legality with on-chain oracle before execution
- **Liquidation Audit System**: Diagnostics for missed liquidations with reason classification
- **Telegram Notifications**: Optional notifications for seed completion and liquidation audits
- **Strict Safety Controls**: Cache invalidation, block TTL, profit floor enforcement
- **Borrower-Level Mutex**: Prevents concurrent operations on the same borrower
- **Strict Block Loop**: Only recomputes HF for WATCH/CRITICAL borrowers using cached prices
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

1. **Startup Seed Scan**: One-time historical scan at startup to discover existing borrowers
   - Scans Borrow events over configurable lookback period (default: 100,000 blocks)
   - Filters borrowers by MIN_DEBT_USD threshold using oracle prices
   - Implements candidate cap with **immediate early stop** when MAX_CANDIDATES is reached
   - Progress reporting at 20%, 40%, 60%, 80%, 100%
   - Runs once before block loop starts
   - Seeded borrowers are marked as **not hydrated** until first Aave event updates their balances
2. **Flash Liquidator Contract**: Solidity contract using Balancer V2 flash loans for zero-capital liquidations
3. **Price Feeds**: Binance WebSocket + Pyth WebSocket for real-time prices with staleness detection
4. **Event Listeners**: Monitor Borrow, Repay, Liquidation events from Aave with MIN_DEBT_USD filtering
5. **Block Loop**: Light operations only on WATCH/CRITICAL borrowers (no preparation in block loop)
6. **Execution Engine**: Simulate (with callStatic), verify, and execute liquidations
7. **Borrower Mutex**: Prevents concurrent preparation/execution for the same borrower
8. **Liquidation Audit**: Diagnostics for missed liquidations with reason classification and Telegram alerts

### Token Catalog

The bot uses a static token catalog (`src/tokens/base.json`) to maintain Base mainnet token addresses outside of `.env` files:

```json
{
  "USDC": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "cbBTC": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  "weETH": "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",
  "wstETH": "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
  "EURC": "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  "cbETH": "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  "GHO": "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee",
  "WETH": "0x4200000000000000000000000000000000000006"
}
```

**Benefits:**
- Centralized token address management
- Easy to add new tokens for future expansion
- Type-safe lookups via `getTokenAddress(symbol)` helper
- Prevents "symbol vs address" errors in ERC20 and oracle calls
- Falls back to `src/aave/addresses.ts` for backward compatibility

**Usage:**
```typescript
import { getTokenAddress, getTokenDecimals } from './tokens';

// Get address by symbol
const usdcAddress = getTokenAddress('USDC');

// Get decimals (async)
const decimals = await getTokenDecimals(provider, 'USDC');
```

### Hydration Guard

The bot implements a **hydration guard** to prevent spurious state transitions for borrowers discovered during the seed scan:

**Problem:** Borrowers seeded from historical events may have stale or incomplete balance data, leading to incorrect Health Factor calculations and false SAFE→LIQUIDATABLE transitions.

**Solution:**
1. **Seeded borrowers** are marked as `hydrated: false` when added during startup scan
2. **HF recomputation is skipped** for non-hydrated borrowers in:
   - Block loop (`processBlock`)
   - Price update handlers (`handlePriceUpdate`)
   - Event handlers (`handleBorrowerUpdate`)
3. **Hydration occurs** when an Aave event (Borrow, Repay, Supply, Withdraw) updates the borrower's balances
4. **Hydration log** is emitted: `"Borrower hydrated | address=0x... | firstHydratedAt=..."`
5. **State transitions** are only allowed after hydration

**Example Flow:**
```
Seed Scan → Add borrower (hydrated=false)
  ↓
Skip HF recomputation (borrower not hydrated)
  ↓
Aave event (e.g., Borrow) → Update balances → Set hydrated=true
  ↓
HF recomputation now allowed → State transitions enabled
```

This prevents the bot from attempting to liquidate borrowers with stale data before their balances are confirmed via on-chain events.

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

# Deploy FlashLiquidator contract (optional, for flash loan execution)
npm run compile
npm run deploy
```

### Deploying FlashLiquidator Contract

The bot supports two execution modes:

1. **Direct Liquidation**: Traditional on-chain liquidation (requires capital)
2. **Flash Loan Liquidation**: Zero-capital liquidation using Balancer V2 (recommended)

To enable flash loan liquidation:

```bash
# Compile Solidity contracts
npm run compile

# Deploy FlashLiquidator contract (requires SIGNER_PK in .env)
npm run deploy

# The deployment script will automatically update .env with the contract address
```

The FlashLiquidator contract will be deployed to Base mainnet and the address will be saved in:
- `.env` file (FLASH_LIQUIDATOR_ADDRESS)
- `deployment.json` file

### 1inch Integration for Collateral Swaps

The FlashLiquidator contract uses **1inch aggregation router** to swap seized collateral into debt assets:

- **Router Address**: `0x1111111254EEB25477B68fb85Ed929f73A960582` (Base mainnet)
- **Supported Swaps**: WETH → USDC, cbETH → USDC
- **Slippage Protection**: Configurable via `MAX_SLIPPAGE_BPS` (default: 50 = 0.50%)
- **Simulation**: All swaps are simulated via `callStatic` before execution
- **Safety**: Contract enforces `amountOutMinimum` and reverts on excessive slippage

The TypeScript bot builds 1inch swap calldata off-chain and passes it to the contract during execution. This ensures:
1. Real-time optimal routing
2. Configurable slippage tolerance
3. Simulation-based safety checks
4. On-chain enforcement of minimum output

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

# Flash Liquidator (optional, for flash loan execution)
FLASH_LIQUIDATOR_ADDRESS=your_deployed_contract_address

# 1inch Router address for collateral -> debt swaps (Base mainnet)
ONEINCH_ROUTER_ADDRESS=0x1111111254EEB25477B68fb85Ed929f73A960582

# Maximum slippage in basis points (e.g., 50 = 0.50%)
MAX_SLIPPAGE_BPS=50

# Transaction cache TTL in blocks
TX_CACHE_TTL_BLOCKS=5

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

# Price Staleness (hot-reloadable)
PRICE_STALE_MS=5000

# Target Assets
TARGET_DEBT_ASSETS=USDC
TARGET_COLLATERAL_ASSETS=WETH,cbETH

# Private Key (KEEP SECURE!)
SIGNER_PK=your_private_key_here
```

### Optional Configuration

See `.env.example` for all available configuration options including:
- Startup seed scan parameters
- MIN_DEBT_USD filtering
- Telegram notifications
- Price feed mappings (Binance, Pyth)
- Private relay settings
- Logging configuration
- Advanced parameters

## 🌱 Startup Seed Scan

The bot performs a one-time historical scan at startup to discover existing borrowers before entering the runtime event loop.

### How It Works

1. **Historical Event Query**: Scans Borrow events over the last `SEED_LOOKBACK_BLOCKS` blocks (default: 100,000)
2. **Batched Queries**: Uses 2,000-block batches to avoid RPC provider limits
3. **Unique Borrower Extraction**: Deduplicates borrower addresses from events
4. **Balance Fetching**: Queries on-chain collateral and debt balances for each borrower
5. **MIN_DEBT_USD Filtering**: Computes total debt in USD using Aave Oracle prices
6. **Registry Population**: Adds borrowers with debt ≥ MIN_DEBT_USD to the registry as SAFE
7. **Hydration Status**: Seeded borrowers are marked as `hydrated=false` until their first Aave event updates balances

### Progress Reporting

The seed scan logs progress at 20%, 40%, 60%, 80%, and 100% completion:

```
[seed] 40% complete | borrowers_found=18,420 | blocks_scanned=40,000/100,000
```

### Candidate Cap & Early Stop

To avoid memory exhaustion, the scan **stops immediately** when:
- `borrowers_found >= MAX_CANDIDATES` (default: 50,000)

```
[seed] stopped early — max candidates reached (50,000) | blocks_scanned=62,000/100,000
```

**Note:** The previous ≥80% progress requirement has been removed for more aggressive memory protection.

### Configuration

```env
# Startup Seed Scan Configuration
SEED_LOOKBACK_BLOCKS=100000  # Number of blocks to scan backward
MAX_CANDIDATES=50000         # Maximum borrowers to track (early stop)
MIN_DEBT_USD=50             # Minimum debt threshold in USD
```

### Completion Summary

```
=== Seed Scan Complete ===
Total Borrowers Found: 25,842
Added to Registry: 1,234
Filtered (below MIN_DEBT_USD): 24,608
MIN_DEBT_USD: $50
```

## 📊 MIN_DEBT_USD Filtering

The bot enforces a global `MIN_DEBT_USD` threshold to filter out low-value borrowers and reduce noise.

### Where It's Applied

1. **Startup Seed Scan**: Never adds borrowers with debt < MIN_DEBT_USD
2. **Borrow Events**: Computes totalDebtUSD; skips adding if below threshold
3. **Supply/Withdraw Events**: For new borrowers, checks debt before adding
4. **Repay Events**: Re-validates debt after repayment
5. **Liquidation Events**: Audits liquidations below threshold (diagnostics only)
6. **Preparation**: Aborts preparation if debt drops below threshold
7. **Execution**: Final check before executing liquidation

### How It Works

- Uses **Aave Oracle prices** (on-chain) for consistency
- Queries ERC20 decimals for accurate USD conversion
- Computed as: `Σ(debt_amount / 10^decimals × oracle_price_usd)`
- Applied uniformly across all code paths

### Configuration

```env
MIN_DEBT_USD=50  # Only track borrowers with debt >= $50
```

### Logging Example

```
Skipping new borrower: debt below MIN_DEBT_USD
  user: 0x1234...
  totalDebtUSD: 23.45
  minDebtUsd: 50
```

## 🔍 Liquidation Audit System

The bot includes a diagnostics-only audit system that logs missed liquidations with reason classification.

### When It Triggers

- **LiquidationCall events** detected on-chain (by any liquidator)
- Bot emits a structured audit log with classification

### Audit Information

- Borrower address
- Debt asset, collateral asset
- Debt covered (amount + USD value)
- Collateral seized (amount + USD value)
- Block number, transaction hash
- Current registry size (`candidates_total`)
- **Reason classification**

### Reason Classification

| Reason | Description |
|--------|-------------|
| `not_in_watch_set` | Borrower not in registry OR state was SAFE |
| `below_min_debt` | Liquidation debt < MIN_DEBT_USD |
| `raced` | Borrower was WATCH/CRITICAL but liquidated before our execution |
| `oracle_not_liquidatable` | On-chain HF ≥ 1.0 at audit time |
| `filtered_by_profit` | Last skip reason was profit floor |
| `filtered_by_gas` | Last skip reason was gas guard |
| `unknown` | Default fallback |

### Audit Log Example

```
Liquidation audit
  borrower: 0xabcd...
  debtAsset: USDC
  collateralAsset: WETH
  debtUSD: 1523.45
  collateralUSD: 1685.23
  blockNumber: 12345678
  txHash: 0x9876...
  reason: raced
  candidatesTotal: 1234
```

### Telegram Integration

If configured, the audit message is also sent to Telegram:

```
🔍 LIQUIDATION AUDIT
Borrower: 0xabcd...
Debt Asset: USDC (0x833...)
Collateral Asset: WETH (0x4200...)
Debt Covered: 1523.450000 USDC ($1523.45)
Collateral Seized: 0.850000 WETH ($1685.23)
Block: 12345678
Tx: 0x9876...
Reason: raced
Candidates Total: 1234
```

## 📱 Telegram Notifications

Optional Telegram integration for seed completion and liquidation audit alerts.

### Setup

1. **Create a Telegram Bot**
   - Message [@BotFather](https://t.me/BotFather) on Telegram
   - Send `/newbot` and follow instructions
   - Save the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

2. **Get Your Chat ID**
   - Message your bot
   - Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Find your chat ID in the JSON response

3. **Configure Environment**
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   TELEGRAM_CHAT_ID=987654321
   ```

### What Gets Notified

- **Seed Scan Completion**: Summary with total found, added, filtered
- **Liquidation Audits**: Detailed audit message with reason classification

### Error Handling

- **Graceful Failures**: Errors are logged but never crash the bot
- **No-Op Mode**: If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is empty, notifications are skipped
- **Best-Effort**: Uses simple HTTPS POST; retries not implemented

### Logging

```
Telegram notification sent successfully
```

```
Failed to send Telegram notification
  error: Network timeout
```

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
- ❌ Do NOT trust Chainlink as primary signal (only used for final HF confirmation)
- ❌ Do NOT broadcast to public mempool by default
- ❌ Do NOT execute unless all conditions are met
- ❌ Do NOT execute if price feeds are stale or disconnected
- ❌ Do NOT execute if BOTH Binance and Pyth feeds are down (fail-closed policy)
- ❌ Do NOT execute if oracle HF >= 1.0
- ❌ Do NOT execute if net profit (after gas) < MIN_PROFIT_USD
- ❌ Do NOT execute without 1inch swap calldata
- ❌ Do NOT prepare liquidations in the block loop (event-driven only)
- ❌ Do NOT track borrowers with debt < MIN_DEBT_USD

### Safety Controls

1. **Price Feed Policy (Fail-Closed)**
   - Requires at least one feed (Binance OR Pyth) to be live
   - Aborts execution if both feeds are stale or disconnected
   - Logs detailed feed status for post-mortem analysis

2. **Oracle HF Confirmation**
   - Fetches on-chain Aave Oracle prices before execution
   - Recomputes HF using oracle prices
   - Aborts if oracle HF >= 1.0 (not liquidatable on-chain)
   - Mandatory check after simulation, before broadcast

3. **Hard Profit Floor**
   - Calculates net profit: `expectedProfit - gasUsd`
   - Aborts if net profit < MIN_PROFIT_USD
   - No exceptions, enforced immediately before execution

4. **Cache Invalidation**
   - Cached transactions expire after `TX_CACHE_TTL_BLOCKS` blocks
   - Cache invalidated on significant price changes
   - Cache invalidated when HF improves out of liquidatable range
   - Prevents execution of stale liquidation parameters

5. **Slippage Protection**
   - Configurable `MAX_SLIPPAGE_BPS` for 1inch swaps
   - On-chain enforcement via `amountOutMinimum`
   - Contract reverts if swap output < required amount
   - Simulated before execution via `callStatic`

6. **Borrower-Level Mutex**
   - Prevents concurrent preparation/execution for same borrower
   - Lock acquired before preparation or execution
   - Always released in finally block

### Best Practices

1. **Start in DRY_RUN mode**: Test configuration before enabling execution
2. **Deploy FlashLiquidator**: Use flash loans for zero-capital liquidations
3. **Configure swap router**: Set SWAP_ROUTER_ADDRESS for collateral-to-debt swaps
4. **Use private relay**: Configure Flashbots or custom relay for production
5. **Secure private key**: Use environment variables, never commit keys
6. **Monitor logs**: Review state transitions and execution attempts
7. **Set conservative thresholds**: Higher MIN_PROFIT_USD reduces risk
8. **Monitor price staleness**: Ensure PRICE_STALE_MS is appropriate for your network conditions

## 📊 Monitoring

The bot logs comprehensive information:

- **State Transitions**: When borrowers move between states
- **HF Changes**: Predicted vs oracle HF comparison
- **Price Updates**: Real-time price feed updates with staleness tracking
- **Simulation Results**: Explicit logging of simulation success/failure
- **Transaction Lifecycle**: Preparation, execution, confirmation
- **Profit/Loss**: Expected and actual profit from liquidations
- **Borrower Mutex**: Lock acquisition/release for concurrent operation prevention

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
  priceStaleness: { 
    binanceAge: 1234, 
    pythAge: 2345, 
    binanceConnected: true, 
    pythConnected: true 
  },
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
- `PRICE_STALE_MS`
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
├── contracts/
│   ├── FlashLiquidator.sol       # Main flash loan liquidation contract
│   └── interfaces/
│       ├── IFlashLoanRecipient.sol  # Balancer flash loan recipient interface
│       ├── IVault.sol               # Balancer Vault interface
│       ├── IPool.sol                # Aave Pool interface
│       └── IERC20.sol               # ERC20 interface
├── scripts/
│   └── deploy.ts                 # FlashLiquidator deployment script
├── src/
│   ├── aave/
│   │   ├── addresses.ts          # Aave contract addresses and ABIs
│   │   └── events.ts             # Event listeners for Aave Pool
│   ├── config/
│   │   └── env.ts                # Configuration with hot-reload
│   ├── execution/
│   │   ├── broadcast.ts          # Transaction broadcasting
│   │   ├── sim.ts                # Traditional liquidation simulation
│   │   ├── tx.ts                 # Transaction building
│   │   └── flash.ts              # Flash loan liquidation execution
│   ├── hf/
│   │   └── calc.ts               # Health Factor calculation
│   ├── logging/
│   │   └── logger.ts             # Structured logging
│   ├── prices/
│   │   ├── binance.ts            # Binance WebSocket feed
│   │   ├── pyth.ts               # Pyth WebSocket feed
│   │   └── index.ts              # Price aggregator with staleness tracking
│   ├── state/
│   │   ├── borrower.ts           # Borrower types and state machine
│   │   └── registry.ts           # Borrower registry with mutex
│   └── index.ts                  # Main bot lifecycle
├── tests/
│   ├── hf.test.ts                # Health Factor tests
│   └── state.test.ts             # State machine tests
├── .env.example                  # Example configuration
├── .gitignore
├── hardhat.config.ts             # Hardhat configuration
├── Chatgpt.txt                   # Bot specification
├── Dockerfile                    # Docker configuration
├── jest.config.js                # Jest test configuration
├── package.json
├── README.md                     # This file
└── tsconfig.json                 # TypeScript configuration
```
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

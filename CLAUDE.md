# TrainBets — CLAUDE.md

This file provides context and conventions for AI assistants working in this repository.

---

## Project Overview

**TrainBets** is a decentralized prediction market for Swedish train delays built on the **Base blockchain** (Coinbase L2). Users bet on whether SJ trains departing from Stockholm Central Station (Cst) will arrive on-time or delayed, using USDC stablecoin. Markets are automatically created and resolved by an oracle that reads official Trafikverket (Swedish Traffic Authority) data.

---

## Repository Structure

```
trainbets/
├── public/
│   └── index.html              # Complete frontend SPA (HTML + CSS + JS, ~1,100 lines)
├── netlify/
│   └── functions/
│       ├── oracle.mjs          # Netlify scheduled oracle (1-min cron)
│       └── trafikverket.js     # CORS proxy for Trafikverket API
├── scripts/
│   └── keeper.mjs              # Standalone oracle for GitHub Actions (backup)
├── .github/
│   └── workflows/
│       └── keeper.yml          # GitHub Actions CI/CD (runs keeper every 5 min)
├── netlify.toml                # Netlify build & function config
├── package.json                # Node.js dependencies (ethers + @netlify/functions)
└── CLAUDE.md                   # This file
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JavaScript (single SPA file) |
| Blockchain | Base mainnet (Chain ID: 8453) |
| Smart Contracts | Solidity (deployed externally, ABI embedded in frontend/oracle) |
| Payment Token | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| Web3 Library | ethers.js v6 |
| Oracle / Keeper | Netlify Functions (1-min cron) + GitHub Actions (5-min cron) |
| Data Source | Trafikverket API (official Swedish rail data) |
| Hosting | Netlify (static site + serverless functions) |

---

## Key Constants

These values appear in multiple files — keep them consistent:

```
CONTRACT_ADDRESS = 0xb54bcee43acad2c99e59bc89f19823181da4cef9  (Base mainnet)
OWNER_ADDRESS    = 0xA0CaAEd5D619dCA906170eB01540d893117B73a5  (treasury/keeper wallet, contract owner)
USDC_ADDRESS     = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  (Base USDC)
CHAIN_ID         = 8453
USDC_DECIMALS    = 6
DELAY_THRESHOLD  = 5 minutes  (≥5 min delay → DELAYED; <5 min → ON_TIME)
LOOKAHEAD_HOURS  = 8          (only create markets for departures within 8 hours)
CLOSING_OFFSET   = 30 min after scheduled departure
PLATFORM_FEE     = 3%
```

**Outcome enum (on-chain):**
```
0 = Unresolved
1 = OnTime
2 = Delayed
```

**Supported destination codes (Trafikverket):**
```
G    → Göteborg C
M    → Malmö C
U    → Uppsala
Son  → Sundsvall
```

---

## Environment Variables

| Variable | Required By | Purpose |
|---|---|---|
| `TRAFIKVERKET_API_KEY` | `trafikverket.js`, `oracle.mjs`, `keeper.mjs` | Auth for Trafikverket REST API |
| `TREASURY_PRIVATE_KEY` | `oracle.mjs` | Wallet private key for Netlify oracle transactions |
| `KEEPER_PRIVATE_KEY` | `keeper.mjs`, GitHub Actions | Wallet private key for GitHub Actions keeper |
| `RPC_URL` | `oracle.mjs`, `keeper.mjs` | Base RPC endpoint (default: `https://mainnet.base.org`) |
| `CONTRACT_ADDRESS` | `oracle.mjs`, `keeper.mjs` | Override default contract address |

**Never commit private keys or API keys.** Use Netlify environment variables and GitHub Actions secrets.

Note: `trafikverket.js` contains a hardcoded fallback API key — prefer the env variable.

---

## Architecture & Data Flow

```
User Browser (index.html)
  │
  ├─→ POST /.netlify/functions/trafikverket  (CORS proxy)
  │       └─→ Trafikverket API (train schedule data)
  │
  └─→ Base Blockchain (ethers.js via MetaMask/Rabby)
          └─→ Smart Contract 0xa0caae...
                  ↑
         Oracle / Keeper (two systems, same logic)
            ├── Netlify oracle.mjs  (1-min cron via scheduled function)
            └── scripts/keeper.mjs (5-min cron via GitHub Actions)
                    └─→ Trafikverket API (resolves actual arrival data)
```

**User journey:**
1. Connect wallet (MetaMask or Rabby) on Base network
2. Browse open markets (train routes from Stockholm)
3. Approve USDC spend → place bet (YES = on-time, NO = delayed)
4. Oracle monitors Trafikverket; resolves market at closing time
5. User claims USDC winnings if prediction was correct

---

## Smart Contract ABI (read / write)

The contract is not in this repo. Both oracles and the frontend use this ABI:

```javascript
// Read
marketCount()                                    → uint256
markets(uint256 id)                              → (trainId, departureDate, closingTime, outcome, totalYes, totalNo)
getUserBet(uint256 marketId, address user)       → (amount, side, claimed)

// Write (oracle only)
createMarket(string trainId, string departureDate, uint256 closingTime)
resolveMarket(uint256 marketId, uint8 outcome)

// Write (user)
placeBet(uint256 marketId, uint8 side, uint256 amount)
claimWinnings(uint256 marketId)
```

---

## Oracle / Keeper Logic

Both `oracle.mjs` and `keeper.mjs` perform two jobs on each run:

1. **createMarkets()** — fetch departures from Trafikverket, create on-chain markets for qualifying trains not yet tracked.
2. **resolveMarkets()** — query open markets past their closing time, fetch actual arrival data, resolve on-chain.

**ethers.js v6 note:** `contract.markets(id)` returns an `ethers.Result` object. Access fields by name (e.g., `result.outcome`) not by numeric index. This has caused bugs before — be careful when reading contract results.

**Gas settings:**
```javascript
maxFeePerGas: 0.005 gwei
maxPriorityFeePerGas: 0.001 gwei
```
Base is cheap; these values are intentionally low.

---

## Frontend (public/index.html)

The entire frontend is a single self-contained HTML file (~1,100 lines). It includes:

- Embedded CSS (styles in `<style>` tag)
- Embedded JavaScript (app logic in `<script>` tag)
- Bilingual UI (Swedish primary, English secondary)
- Dark/light mode toggle with localStorage persistence
- Tab navigation: Markets, Stations, How It Works, Contract Info, Profile

**Tabs use hash routing:** `#marknader`, `#stationer`, `#howto`, `#kontrakt`, `#profil`

**Wallet support:** MetaMask and Rabby on Base network only. The app will prompt to switch network if wrong chain.

**USDC flow:** Two-step — `approve()` first, then `placeBet()`. Approval modal handles both steps.

---

## Development Workflow

### Local Development

There is no local build step. Netlify handles bundling.

```bash
# Install dependencies (only needed for Netlify Functions)
npm install

# Run Netlify locally (requires Netlify CLI)
netlify dev
```

The frontend (`public/index.html`) can be opened directly in a browser for UI work, but blockchain and oracle features require a full Netlify environment.

### Deployment

Push to `master` branch → Netlify auto-deploys.

- Static site from `public/`
- Functions bundled with esbuild from `netlify/functions/`

### Oracle / Keeper

- **Netlify oracle** runs automatically on 1-minute cron via `schedule` export in `oracle.mjs`
- **GitHub Actions keeper** runs every 5 minutes via `keeper.yml`, also triggerable manually via `workflow_dispatch`

Both systems are intentionally redundant.

---

## Code Conventions

- **No build tools or TypeScript** — plain JavaScript ES modules (`.mjs` for Node scripts, `.js` for Netlify functions)
- **No test suite** — no test framework is configured; rely on Netlify function logs and GitHub Actions run logs
- **No linter configured** — follow existing style (2-space indent, single quotes, no semicolons in frontend JS)
- **Minimal dependencies** — only add packages if strictly necessary; the project intentionally avoids heavy toolchains
- **Single-file frontend** — do not split `index.html` into components; keep it as one file
- **Inline comments** in Swedish or English are both acceptable (codebase uses both)

---

## Common Tasks

### Update the smart contract address

Update in three places:
1. `public/index.html` — `const CONTRACT = "0x..."`
2. `netlify/functions/oracle.mjs` — `const CONTRACT_ADDRESS`
3. `scripts/keeper.mjs` — `const CONTRACT_ADDRESS`

Also update the default in `.github/workflows/keeper.yml` if hardcoded there.

### Add a new train destination

1. Add destination code to the `DESTINATIONS` array/set in `oracle.mjs` and `keeper.mjs`
2. Add route info to the Stations tab in `public/index.html`

### Adjust delay threshold

Change `DELAY_THRESHOLD_MINUTES` in both `oracle.mjs` and `keeper.mjs`. The value is currently 5 minutes.

### Debug the oracle

Check Netlify Function logs in the Netlify dashboard, or trigger the GitHub Actions keeper manually via `workflow_dispatch` and inspect the run log.

---

## Security Notes

- Private keys (`TREASURY_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`) must only live in Netlify environment variables and GitHub Actions secrets — never in source code
- `trafikverket.js` contains a hardcoded fallback API key; remove it and enforce the env variable if possible
- The CORS proxy (`trafikverket.js`) allows all origins — acceptable for a public dApp, but be aware
- No input validation on the proxy; it forwards arbitrary POST bodies to Trafikverket (low risk since the API key scopes access)

---

## External Resources

| Resource | URL |
|---|---|
| Smart Contract (Basescan) | https://basescan.org/address/0xb54bcee43acad2c99e59bc89f19823181da4cef9 |
| Base blockchain | https://base.org |
| Trafikverket API docs | https://api.trafikinfo.trafikverket.se |
| USDC on Base | https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |

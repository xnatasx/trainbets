# TrainBets — Outstanding Tasks

Each task is **independent** and self-contained.
Read `CLAUDE.md` first for full project context, addresses and architecture.

**Last updated:** 2026-03-15
**Site:** https://trainbets.netlify.app

---

## Quick-start

```bash
git clone https://github.com/xnatasx/trainbets.git
cd trainbets && npm install
```

Netlify auto-deploys on every push to `main`. Never use Netlify drag-and-drop — functions won't bundle.

---

## TASK 1 — Verify GitHub Actions keeper runs clean

**Priority:** HIGH — do this first.
**Status:** Two bugs fixed (`c95452d`, `cf34da6`). Needs verification.

**Verify it works:**
- Go to GitHub → Actions tab → check latest keeper runs
- Or trigger manually via `workflow_dispatch`

**Expected success in run logs:**
```
[Keeper] Wallet: 0xA0CaAEd5D619dCA906170eB01540d893117B73a5
[Keeper] Created X markets
[Keeper] X markets to resolve
[Keeper] Done
```

**If it still fails — common causes:**
- `Cannot read properties of undefined` → add null guard around the specific property
- `insufficient funds` → treasury has no ETH for gas; send ~0.01 ETH to `0xA0CaAEd5D619dCA906170eB01540d893117B73a5` on Base
- `execution reverted` on resolveMarket → market may already be resolved (check outcome !== 0)

**File:** `scripts/keeper.mjs`, `.github/workflows/keeper.yml`

---

## TASK 2 — Debug empty ticker / departures on live site

**Priority:** HIGH
**Status:** User reports ticker (scrolling train banner) and station stats show empty.

**What the ticker does:**
`index.html` → `refreshTicker()` → POST to `/.netlify/functions/trafikverket` → renders arrivals

**Diagnose:**
1. Open browser DevTools → Network tab → look for POST to `trafikverket` function
2. Check if it returns data or errors
3. If function returns HTML/error → Netlify function not deployed, check deploy logs
4. If function returns data but ticker empty → bug in `renderTicker()` (~line 735)

**Note:** The ticker queries *arrivals at destination* (G/M/Son/U), not departures from Stockholm. Best tested between 07:00–22:00 Swedish time.

**Files:** `netlify/functions/trafikverket.js`, `public/index.html` (`refreshTicker` ~line 712)

---

## TASK 3 — Verify Netlify oracle creates markets

**Priority:** MEDIUM
**Status:** Oracle uses `TREASURY_PRIVATE_KEY` set in Netlify env. Unverified if actually running.

**Check market count on-chain:**
```bash
node -e "
const {ethers}=require('./node_modules/ethers');
const p=new ethers.JsonRpcProvider('https://mainnet.base.org');
const c=new ethers.Contract(
  '0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9',
  ['function marketCount() view returns (uint256)',
   'function markets(uint256) view returns (string,string,uint256,uint8,uint256,uint256)'],
  p
);
c.marketCount().then(n => console.log('Total markets:', n.toString()));
"
```

**If 0 markets today:** Oracle is not running. Check Netlify env vars:
- Netlify dashboard → Site → Environment variables
- Must have: `TRAFIKVERKET_API_KEY`, `TREASURY_PRIVATE_KEY`, `RPC_URL`, `CONTRACT_ADDRESS`

**Check Netlify function logs:** Netlify dashboard → Logs → Functions → `oracle`

**File:** `netlify/functions/oracle.mjs`

---

## TASK 4 — (Future) MetaMask mobile deep-link

Add one line near the "Anslut plånbok" button in `index.html` for mobile users who don't have an injected wallet:

```html
<a href="https://metamask.app.link/dapp/trainbets.netlify.app"
   id="metamask-mobile-link" style="display:none">
  Open in MetaMask
</a>
```

Show it only when `!window.ethereum` on mobile (detect via `navigator.userAgent`).

---

## TASK 5 — (Future) Live odds via blockchain events

Currently odds refresh every 2 minutes (`setInterval(init, 120_000)`).
For real-time updates, subscribe to `placeBet` events via Alchemy WebSocket on Base:
- Endpoint: `wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY`
- Listen for contract events → call `loadMarkets()` on each event

Not urgent — works fine with polling for now.

---

## GitHub Actions Secrets (already set)
| Secret | Status |
|---|---|
| `TRAFIKVERKET_API_KEY` | ✅ Set |
| `KEEPER_PRIVATE_KEY` | ✅ Set |

## Netlify Env Vars (set in dashboard, verify if oracle not running)
| Variable | Notes |
|---|---|
| `TRAFIKVERKET_API_KEY` | Trafikverket auth |
| `TREASURY_PRIVATE_KEY` | Oracle wallet key |
| `RPC_URL` | `https://mainnet.base.org` |
| `CONTRACT_ADDRESS` | `0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9` |

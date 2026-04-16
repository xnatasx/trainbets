# TrainBets — Outstanding Tasks

Each task is **independent** and self-contained.
Read `CLAUDE.md` first for full project context, addresses and architecture.

**Last updated:** 2026-04-16
**Site:** https://trainbets.netlify.app

> All three core subsystems (GitHub Actions keeper, Netlify oracle, Netlify
> create-market + trafikverket proxy) are now wired up and the frontend
> end-to-end flow works. Remaining items below are verification / nice-to-have
> follow-ups rather than blockers.

---

## Quick-start

```bash
git clone https://github.com/xnatasx/trainbets.git
cd trainbets && npm install
```

Netlify auto-deploys on every push to `main`. Never use Netlify drag-and-drop — functions won't bundle.

---

## TASK 1 — Verify GitHub Actions keeper runs clean

**Priority:** MEDIUM (was HIGH — all known keeper bugs have been fixed).
**Status:** Bugs fixed across `702dd55` (exit 0 on missing secrets / RPC failures),
`a2671b2` / `51da680` / `c45cdb4` (RPC fallback + marketCount probe), and
`baa3f90` (race-safe CALL_EXCEPTION handling). Keeper artifacts are uploaded
every run (see `keeper.yml`) so logs are always inspectable.

**Verify it works:**
- Go to GitHub → Actions tab → check latest keeper runs (workflow: *TrainBets Keeper*)
- Or trigger manually via `workflow_dispatch`
- Download the `keeper-log-<runId>` artifact to inspect stdout/stderr

**Expected success in run logs:**
```
[Keeper] Wallet: 0xA0CaAEd5D619dCA906170eB01540d893117B73a5
[Keeper] <N> departures from Trafikverket
[Keeper] Skipped: past=… future=… wrongDest=… alreadyExists=…
[Keeper] Created X markets
[Keeper] X markets to resolve
[Keeper] Resolved Y markets
[Keeper] Done
```

**If it still fails — common causes:**
- `Cannot read properties of undefined` → add a null guard around the specific property
- `insufficient funds` → treasury has no ETH for gas; send ~0.01 ETH to `0xA0CaAEd5D619dCA906170eB01540d893117B73a5` on Base
- `execution reverted` on resolveMarket → market may already be resolved (outcome !== 0)
- `Missing TRAFIKVERKET_API_KEY` / `Missing KEEPER_PRIVATE_KEY` → add the secret under repo Settings → Secrets → Actions (the keeper now `exit 0`s so the workflow won't email-spam)

**File:** `scripts/keeper.mjs`, `.github/workflows/keeper.yml`

---

## TASK 2 — Debug empty ticker / departures on live site

**Priority:** LOW (root cause was fixed by `c440811` — today+tomorrow fetch so
evenings/overnight trains still appear).
**Status:** `trafikverket.js` now fetches *both* today and tomorrow and
concatenates the announcements; the ticker also renders a visible warning when
the proxy returns a non-2xx response. If the ticker still looks empty:

**Diagnose:**
1. Open browser DevTools → Network tab → look for POST to `/.netlify/functions/trafikverket`
2. Confirm the response body is `{ "trains": [...] }` (not an HTML error page)
3. If function returns HTML / 500 → Netlify function not deployed or `TRAFIKVERKET_API_KEY` env var missing — check Netlify deploy & function logs
4. If function returns data but UI still empty → inspect `renderTicker()` around `public/index.html:816` and `refreshTicker()` around `public/index.html:789`

**Note:** The ticker queries **departures from Stockholm Cst** (`station:"Cst", type:"Avgang"`) and the frontend filters to the four supported destinations (G / M / Son / U). Best tested between 07:00–22:00 Swedish time.

**Files:** `netlify/functions/trafikverket.js`, `public/index.html` (`refreshTicker` at ~line 789, `renderTicker` at ~line 816)

---

## TASK 3 — Verify Netlify oracle creates markets

**Priority:** MEDIUM
**Status:** Oracle uses `TREASURY_PRIVATE_KEY` set in Netlify env. Now runs on
a 5-min cron (reduced from 1 min in `3e826af` to stay inside Netlify's free
scheduled-function budget). `create-market.mjs` also creates markets on-demand
when a user opens a pre-market modal.

**Check market count on-chain:**
```bash
node -e "
const {ethers}=require('./node_modules/ethers');
const p=new ethers.JsonRpcProvider('https://mainnet.base.org');
const c=new ethers.Contract(
  '0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9',
  ['function marketCount() view returns (uint256)',
   'function getMarket(uint256) view returns (tuple(string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 totalYes, uint256 totalNo))'],
  p
);
c.marketCount().then(n => console.log('Total markets:', n.toString()));
"
```

**If 0 markets today:** Oracle is not running. Check Netlify env vars:
- Netlify dashboard → Site → Environment variables
- Must have: `TRAFIKVERKET_API_KEY`, `TREASURY_PRIVATE_KEY`; optionally `RPC_URL`, `CONTRACT_ADDRESS` (defaults are used if omitted)

**Check Netlify function logs:** Netlify dashboard → Logs → Functions → `oracle` (scheduled) and `create-market` (on-demand)

**Files:** `netlify/functions/oracle.mjs`, `netlify/functions/create-market.mjs`

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

Currently markets refresh every 60 seconds (`setInterval(init, 60_000)` at
`public/index.html:1520`) and the ticker also polls every 60 s. For real-time
updates, subscribe to `placeBet` events via Alchemy WebSocket on Base:
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
| `TRAFIKVERKET_API_KEY` | Trafikverket auth (required by `trafikverket.js`, `oracle.mjs`) |
| `TREASURY_PRIVATE_KEY` | Oracle wallet key (required by `oracle.mjs`, `create-market.mjs`) |
| `RPC_URL` | Optional override; defaults to `https://mainnet.base.org` with public-RPC fallbacks |
| `CONTRACT_ADDRESS` | Optional override; defaults to `0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9` |

> `RPC_URL` is listed in `SECRETS_SCAN_OMIT_KEYS` in `netlify.toml` because
> Netlify's secret scanner otherwise flags its public Base RPC value.

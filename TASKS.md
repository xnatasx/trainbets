# TrainBets — Outstanding Tasks

Each task is **independent** and self-contained.
Read `CLAUDE.md` first for full project context, addresses and architecture.

**Last updated:** 2026-03-12
**Latest working commit:** `878bcf2`
**Site:** https://trainbets.netlify.app
**GitHub PAT (workflow scope):** stored in your password manager — do not commit to repo

---

## Quick-start (clone & run)

```bash
git clone https://<YOUR_GITHUB_PAT>@github.com/xnatasx/trainbets.git
cd trainbets && npm install

# Push changes
git add -A && git commit -m "your message"
git push https://<YOUR_GITHUB_PAT>@github.com/xnatasx/trainbets.git main
```

Netlify auto-deploys on every push to `main`. Never use Netlify drag-and-drop — functions won't bundle.

---

## TASK 1 — Verify GitHub Actions keeper runs clean

**Priority:** HIGH — do this first.
**Status:** Keeper was crashing. Two bugs fixed in recent commits:
- `c95452d` — removed `cache: "npm"` from keeper.yml (no package-lock.json)
- `cf34da6` — fixed `{...r.value}` spread on ethers Result (trainId was undefined)

**Verify it works:**
```bash
# Trigger a manual run
curl -s -X POST \
  -H "Authorization: token <YOUR_GITHUB_PAT>" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/xnatasx/trainbets/actions/workflows/keeper.yml/dispatches \
  -d '{"ref":"main"}'

# Check status of last 3 runs
curl -s \
  -H "Authorization: token <YOUR_GITHUB_PAT>" \
  "https://api.github.com/repos/xnatasx/trainbets/actions/runs?per_page=3" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
    JSON.parse(d).workflow_runs.forEach(r=> \
    console.log('#'+r.run_number, r.status, r.conclusion, r.created_at))"
```

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

**Check treasury ETH balance:**
```bash
node -e "
const {ethers}=require('./node_modules/ethers');
const p=new ethers.JsonRpcProvider('https://mainnet.base.org');
p.getBalance('0xA0CaAEd5D619dCA906170eB01540d893117B73a5')
 .then(b=>console.log('ETH balance:', ethers.formatEther(b)));
"
```

**File:** `scripts/keeper.mjs`, `.github/workflows/keeper.yml`

---

## TASK 2 — Debug empty ticker / departures on live site

**Priority:** HIGH
**Status:** User reports ticker (scrolling train banner) and station stats show empty.

**What the ticker does:**
`index.html` → `refreshTicker()` → POST to `/.netlify/functions/trafikverket` → renders arrivals

**Step 1 — Test Netlify CORS proxy directly (update date to today):**
```bash
curl -s -X POST https://trainbets.netlify.app/.netlify/functions/trafikverket \
  -H "Content-Type: application/json" \
  -d '{
    "objectType": "TrainAnnouncement",
    "filter": {"AND": [
      {"EQ": {"name": "ActivityType", "value": "Ankomst"}},
      {"IN": {"name": "LocationSignature", "value": ["G","M","Son","U"]}},
      {"EQ": {"name": "Advertised", "value": "true"}},
      {"GT": {"name": "AdvertisedTimeAtLocation", "value": "2026-03-12T06:00:00.000+01:00"}},
      {"LT": {"name": "AdvertisedTimeAtLocation", "value": "2026-03-12T23:59:59.000+01:00"}}
    ]},
    "includes": ["AdvertisedTrainIdent","AdvertisedTimeAtLocation","TimeAtLocation","LocationSignature","Canceled"]
  }' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
    const r=JSON.parse(d); \
    const arr=r?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement??[]; \
    console.log('Trains returned:', arr.length); \
    arr.slice(0,3).forEach(t=>console.log(t.AdvertisedTrainIdent, t.LocationSignature, t.AdvertisedTimeAtLocation));"
```

**Step 2 — Test Trafikverket API directly:**
```bash
curl -s -X POST https://api.trafikinfo.trafikverket.se/v2/data.json \
  -H "Content-Type: application/json" \
  -d '{
    "REQUEST": {
      "LOGIN": {"authenticationkey": "4135d9b931704bf99d40ca7f84fcf9ad"},
      "QUERY": [{"objecttype": "TrainAnnouncement", "schemaversion": "1.8",
        "FILTER": {"AND": [
          {"EQ": {"name": "ActivityType", "value": "Ankomst"}},
          {"IN": {"name": "LocationSignature", "value": ["G","M","Son","U"]}},
          {"EQ": {"name": "Advertised", "value": "true"}},
          {"GT": {"name": "AdvertisedTimeAtLocation", "value": "2026-03-12T06:00:00.000+01:00"}},
          {"LT": {"name": "AdvertisedTimeAtLocation", "value": "2026-03-12T23:59:59.000+01:00"}}
        ]},
        "INCLUDE": ["AdvertisedTrainIdent","AdvertisedTimeAtLocation","TimeAtLocation","LocationSignature","Canceled"]
      }]
    }
  }' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
    const arr=JSON.parse(d)?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement??[]; \
    console.log('Direct API trains:', arr.length);"
```

**Diagnose from results:**
| Netlify proxy | Direct API | Cause |
|---|---|---|
| 0 trains | 0 trains | Wrong query / nighttime / no trains today |
| 0 trains | N trains | Bug in `trafikverket.js` or proxy not deployed |
| Error / HTML | any | Netlify function not deployed — check deploy logs |

**Check Netlify function is deployed:**
- Netlify dashboard → Site → Functions tab → look for `trafikverket`
- If missing: the function has a syntax/build error. Check Netlify deploy logs.

**If proxy returns data but ticker still empty:**
- Bug in `renderTicker()` around line 735 of `index.html`
- Check the data path: `data?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement`

**Note:** The ticker queries *arrivals at destination* (G/M/Son/U), not departures from Stockholm. This is intentional — we show when trains arrive at their destination. Best tested between 07:00–22:00 Swedish time.

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
const today=new Date().toISOString().slice(0,10);
c.marketCount().then(async n=>{
  console.log('Total markets ever:', n.toString());
  const ids=Array.from({length:Number(n)},(_,i)=>i+1);
  const all=await Promise.all(ids.map(i=>c.markets(i)));
  const todayMkts=all.filter(m=>m[1]===today);
  console.log('Today markets:', todayMkts.length);
  todayMkts.forEach((m,i)=>console.log(' ',m[0],m[1],'outcome:',m[3].toString()));
});
"
```

**If 0 markets today:** Oracle is not running. Check Netlify env vars:
- Netlify dashboard → Site → Environment variables
- Must have: `TRAFIKVERKET_API_KEY`, `TREASURY_PRIVATE_KEY`, `RPC_URL`, `CONTRACT_ADDRESS`

**Check Netlify function logs:** Netlify dashboard → Logs → Functions → `oracle`

**File:** `netlify/functions/oracle.mjs`

---

## TASK 4 — Fix stats if still showing wrong numbers

**Priority:** LOW (already fixed in `76ccc62`, verify it looks correct)
**Status:** Stats now filter to today's markets only.

Stats should show:
- **Aktiva marknader** = open markets right now (outcome=0 AND closingTime > now)
- **Volym idag** = total USDC bet in today's markets
- **I tid idag** = % of today's resolved markets that were on-time
- **Marknader idag** = count of today's markets (real chain number)

If numbers still look fake or inflated, check `updateStats()` in `index.html` around line 699.

---

## TASK 5 — (Future) MetaMask mobile deep-link

Add one line near the "Anslut plånbok" button in `index.html` for mobile users who don't have an injected wallet:

```html
<a href="https://metamask.app.link/dapp/trainbets.netlify.app"
   id="metamask-mobile-link" style="display:none">
  Open in MetaMask
</a>
```

Show it only when `!window.ethereum` on mobile (detect via `navigator.userAgent`).

---

## TASK 6 — (Future) Live odds via blockchain events

Currently odds refresh every 2 minutes (`setInterval(init, 120_000)`).
For real-time updates, subscribe to `placeBet` events via Alchemy WebSocket on Base:
- Endpoint: `wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY`
- Listen for contract events → call `loadMarkets()` on each event

Not urgent — works fine with polling for now.

---

## GitHub Actions Secrets (already set)
| Secret | Status |
|---|---|
| `TRAFIKVERKET_API_KEY` | ✅ `4135d9b931704bf99d40ca7f84fcf9ad` |
| `KEEPER_PRIVATE_KEY` | ✅ Set by user |

## Netlify Env Vars (set in dashboard, verify if oracle not running)
| Variable | Value |
|---|---|
| `TRAFIKVERKET_API_KEY` | `4135d9b931704bf99d40ca7f84fcf9ad` |
| `TREASURY_PRIVATE_KEY` | user's wallet private key |
| `RPC_URL` | `https://mainnet.base.org` |
| `CONTRACT_ADDRESS` | `0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9` |

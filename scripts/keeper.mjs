// TrainBets Keeper — runs via GitHub Actions every 5 minutes
// Creates markets for today's departures and resolves expired ones
import { ethers } from "ethers";

const TV_API = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const DEST_SIGS = ["G", "M", "Son", "U"];
const DELAY_THRESHOLD = 5; // minutes
const Outcome = { Unresolved: 0, OnTime: 1, Delayed: 2 };

function getStockholmDate() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(now);
  const isCEST = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Stockholm", timeZoneName: "short" }).format(now).includes("CEST");
  return { date, tz: isCEST ? "+02:00" : "+01:00" };
}

const ABI = [
  "function marketCount() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 totalYes, uint256 totalNo))",
  "function createMarket(string calldata trainId, string calldata departureDate, uint256 closingTime) external returns (uint256)",
  "function resolveMarket(uint256 marketId, uint8 outcome) external",
];

const GAS = {
  maxFeePerGas:         ethers.parseUnits("0.005", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
};

async function tvFetch(apiKey, objecttype, filter, includes, limit = 1000) {
  const r = await fetch(TV_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      REQUEST: {
        LOGIN: { authenticationkey: apiKey },
        QUERY: [{ objecttype, schemaversion: "1.8", FILTER: filter, INCLUDE: includes, LIMIT: limit }],
      },
    }),
  });
  const json = await r.json();
  const result = json?.RESPONSE?.RESULT?.[0] ?? {};
  if (result.ERROR) console.error(`[Keeper] Trafikverket API error: ${JSON.stringify(result.ERROR)}`);
  return result;
}

async function fetchDepartures(apiKey) {
  const { date: today, tz } = getStockholmDate();
  const tomorrowDt = new Date(Date.now() + 86400000);
  const tomorrow = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(tomorrowDt);
  const fetchDay = (date) => tvFetch(apiKey, "TrainAnnouncement", {
    AND: [
      { EQ:   [{ name: "ActivityType",             value: "Avgang"                     }] },
      { EQ:   [{ name: "LocationSignature",        value: "Cst"                        }] },
      { GT:   [{ name: "AdvertisedTimeAtLocation", value: date + "T00:00:00.000" + tz  }] },
      { LT:   [{ name: "AdvertisedTimeAtLocation", value: date + "T23:59:59.000" + tz  }] },
    ],
  }, ["AdvertisedTrainIdent", "AdvertisedTimeAtLocation", "Canceled", "ToLocation"])
    .then(res => res.TrainAnnouncement ?? []);
  const [todayTrains, tomorrowTrains] = await Promise.all([fetchDay(today), fetchDay(tomorrow)]);
  return [...todayTrains, ...tomorrowTrains];
}

async function fetchArrival(apiKey, trainIdent, destSig, departureDate) {
  const { tz } = getStockholmDate();
  const res = await tvFetch(apiKey, "TrainAnnouncement", {
    AND: [
      { EQ: [{ name: "ActivityType",               value: "Ankomst"                            }] },
      { EQ: [{ name: "AdvertisedTrainIdent",       value: trainIdent                           }] },
      { EQ: [{ name: "LocationSignature",          value: destSig                              }] },
      { GT: [{ name: "ScheduledDepartureDateTime", value: departureDate + "T00:00:00.000" + tz }] },
      { LT: [{ name: "ScheduledDepartureDateTime", value: departureDate + "T23:59:59.000" + tz }] },
    ],
  }, ["TimeAtLocation", "AdvertisedTimeAtLocation", "Canceled"]);
  const ann = res.TrainAnnouncement?.[0];
  if (!ann) return { arrived: false, delayMinutes: 0, cancelled: false };
  const delay = ann.TimeAtLocation
    ? Math.round((new Date(ann.TimeAtLocation) - new Date(ann.AdvertisedTimeAtLocation)) / 60000)
    : 0;
  return { arrived: !!ann.TimeAtLocation, delayMinutes: delay, cancelled: ann.Canceled === true };
}

// Try each RPC until one can serve eth_call (probed via marketCount).
// Public Base RPCs sometimes throttle eth_call while still serving eth_blockNumber,
// so we probe with a real contract call, not getBlockNumber().
const RPC_URLS = [
  process.env.RPC_URL ?? "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base-rpc.publicnode.com",
  "https://rpc.ankr.com/base",
  "https://1rpc.io/base",
];

async function connectToChain(privateKey, contractAddress) {
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const wallet   = new ethers.Wallet(privateKey, provider);
      const contract = new ethers.Contract(contractAddress, ABI, wallet);
      const count = await Promise.race([
        contract.marketCount(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 4000)),
      ]);
      console.log(`[Keeper] RPC: ${url} | wallet: ${wallet.address} | marketCount: ${count}`);
      return { wallet, contract, count: Number(count) };
    } catch (e) {
      console.warn(`[Keeper] RPC ${url} failed: ${e.message}`);
    }
  }
  throw new Error("All RPC endpoints unavailable");
}

async function run() {
  const apiKey     = process.env.TRAFIKVERKET_API_KEY;
  const privateKey = process.env.KEEPER_PRIVATE_KEY;
  const contractAddress = process.env.CONTRACT_ADDRESS ?? "0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9";

  if (!apiKey)     { console.error("[Keeper] Missing TRAFIKVERKET_API_KEY — add this secret in GitHub repo Settings → Secrets → Actions"); process.exit(0); }
  if (!privateKey) { console.error("[Keeper] Missing KEEPER_PRIVATE_KEY — add this secret in GitHub repo Settings → Secrets → Actions"); process.exit(0); }

  let wallet, contract, count;
  try { ({ wallet, contract, count } = await connectToChain(privateKey, contractAddress)); }
  catch (err) { console.error("[Keeper] " + err.message); process.exit(0); }

  console.log(`[Keeper] Wallet: ${wallet.address}`);
  const now = Math.floor(Date.now() / 1000);

  // — Load existing markets (last 200 to avoid RPC overload) —
  // count already comes from the RPC probe — no second marketCount() call needed.
  const scanStart = Math.max(1, count - 199);
  const mkts  = (await Promise.allSettled(
    Array.from({ length: count - scanStart + 1 }, (_, i) => contract.getMarket(scanStart + i))
  )).map((r, i) => r.status === "fulfilled"
    ? { trainId: r.value.trainId, departureDate: r.value.departureDate,
        closingTime: Number(r.value.closingTime), outcome: Number(r.value.outcome),
        totalYes: r.value.totalYes, totalNo: r.value.totalNo, marketId: scanStart + i }
    : null
  ).filter(Boolean);

  // — Create new markets —
  const trains  = await fetchDepartures(apiKey);
  console.log(`[Keeper] ${trains.length} departures from Trafikverket`);
  const existing = new Set(mkts.map(m => m.trainId + "|" + m.departureDate));
  const cutoff  = now + 8 * 3600; // 8h lookahead
  let created = 0;
  let skipped = { past: 0, future: 0, dest: 0, exists: 0 };

  for (const train of trains) {
    const deptMs = new Date(train.AdvertisedTimeAtLocation).getTime();
    const deptSec = deptMs / 1000;
    if (deptSec < now + 1800) { skipped.past++; continue; } // skip if closing time (30 min before departure) already passed
    if (deptSec > cutoff) { skipped.future++; continue; }
    const dest = train.ToLocation?.find(l => DEST_SIGS.includes(l.LocationName))?.LocationName;
    if (!dest) { skipped.dest++; continue; }
    const trainId = train.AdvertisedTrainIdent + " " + dest;
    const deptDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date(deptMs));
    if (existing.has(trainId + "|" + deptDate)) { skipped.exists++; continue; }
    try {
      const tx = await contract.createMarket(trainId, deptDate, Math.floor(deptSec) - 1800, GAS);
      await tx.wait();
      console.log(`[Keeper] Created: ${trainId}`);
      existing.add(trainId + "|" + deptDate);
      created++;
    } catch (err) {
      console.error(`[Keeper] Create failed ${trainId}: ${err.message}`);
    }
  }
  console.log(`[Keeper] Skipped: past=${skipped.past} future=${skipped.future} wrongDest=${skipped.dest} alreadyExists=${skipped.exists}`);
  console.log(`[Keeper] Created ${created} markets`);

  // — Resolve expired markets —
  const toResolve = mkts.filter(m => m.outcome === Outcome.Unresolved &&
                                    m.closingTime <= now &&
                                    m.closingTime >= now - 48 * 3600); // skip markets older than 48 h
  console.log(`[Keeper] ${toResolve.length} markets to resolve`);
  let resolved = 0;

  for (const m of toResolve) {
    const [trainIdent, destSig = "G"] = m.trainId.split(" ");
    try {
      const { arrived, delayMinutes, cancelled } = await fetchArrival(apiKey, trainIdent, destSig, m.departureDate);
      if (!arrived && !cancelled) { console.log(`[Keeper] ${m.trainId} not yet arrived`); continue; }
      const isDelayed = cancelled || delayMinutes >= DELAY_THRESHOLD;
      const outcome   = isDelayed ? Outcome.Delayed : Outcome.OnTime;
      const tx = await contract.resolveMarket(m.marketId, outcome, GAS);
      await tx.wait();
      console.log(`[Keeper] Resolved #${m.marketId} ${m.trainId} → ${isDelayed ? "DELAYED" : "ON TIME"}`);
      resolved++;
    } catch (err) {
      console.error(`[Keeper] Resolve failed ${m.trainId}: ${err.message}`);
    }
  }
  console.log(`[Keeper] Resolved ${resolved} markets`);
  console.log("[Keeper] Done");
}

run().catch(err => { console.error("[Keeper] Fatal:", err.message); process.exit(1); });

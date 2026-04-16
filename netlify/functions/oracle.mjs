import { schedule } from "@netlify/functions";
import { ethers }    from "ethers";

const DELAY_THRESHOLD_MINUTES = 5;
const MARKET_LOOKAHEAD_HOURS  = 8;
const TV_API = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const Outcome = { Unresolved: 0, OnTime: 1, Delayed: 2 };
const DEST_SIGNATURES = ["G", "M", "Son", "U"];

function getStockholmDate() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(now);
  const isCEST = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Stockholm", timeZoneName: "short" }).format(now).includes("CEST");
  return { date, tz: isCEST ? "+02:00" : "+01:00" };
}

const CONTRACT_ABI = [
  "function marketCount() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 totalYes, uint256 totalNo))",
  "function createMarket(string calldata trainId, string calldata departureDate, uint256 closingTime) external returns (uint256)",
  "function resolveMarket(uint256 marketId, uint8 outcome) external",
];

// NOTE: BASE_GAS is defined inside oracleJob() — NOT at module scope.
// Top-level ethers calls would crash the module on load and cause the scheduled
// function handler to never register (same issue as was fixed in create-market.mjs).

async function tvFetch(apiKey, objecttype, filter, includes, limit = 1000) {
  const r = await fetch(TV_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ REQUEST: { LOGIN: { authenticationkey: apiKey }, QUERY: [{ objecttype, schemaversion: "1.8", FILTER: filter, INCLUDE: includes, LIMIT: limit }] } }),
  });
  const json = await r.json();
  const result = json?.RESPONSE?.RESULT?.[0] ?? {};
  if (result.ERROR) console.error("Trafikverket API error: " + JSON.stringify(result.ERROR));
  return result;
}

async function fetchTodayDepartures(apiKey) {
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

async function fetchArrivalStatus(apiKey, trainIdent, destSig, departureDate) {
  const { tz } = getStockholmDate();
  const res = await tvFetch(apiKey, "TrainAnnouncement", {
    AND: [
      { EQ: [{ name: "ActivityType",               value: "Ankomst"                              }] },
      { EQ: [{ name: "AdvertisedTrainIdent",       value: trainIdent                             }] },
      { EQ: [{ name: "LocationSignature",          value: destSig                                }] },
      { GT: [{ name: "ScheduledDepartureDateTime", value: departureDate + "T00:00:00.000" + tz   }] },
      { LT: [{ name: "ScheduledDepartureDateTime", value: departureDate + "T23:59:59.000" + tz   }] },
    ],
  }, ["TimeAtLocation", "AdvertisedTimeAtLocation", "Canceled"]);
  const ann = res.TrainAnnouncement?.[0];
  if (!ann) return { arrived: false, delayMinutes: 0, cancelled: false };
  const cancelled    = ann.Canceled === true;
  const arrived      = !!ann.TimeAtLocation;
  const delayMinutes = arrived
    ? Math.round((new Date(ann.TimeAtLocation) - new Date(ann.AdvertisedTimeAtLocation)) / 60000)
    : 0;
  return { arrived, delayMinutes, cancelled };
}

async function createMarkets(contract, apiKey, BASE_GAS) {
  console.log("Creating markets...");
  const trains = await fetchTodayDepartures(apiKey);
  console.log('TV API returned', trains.length, 'departures');
  const now    = Date.now();
  const cutoff = now + MARKET_LOOKAHEAD_HOURS * 3600000;
  let count = 0;
  try { count = Number(await contract.marketCount()); } catch(e) { console.error('marketCount err: ' + e.message); return; }
  // Only scan the most recent 200 markets — older ones can't conflict with upcoming departures
  const scanStart = Math.max(1, count - 199);
  const settled1 = await Promise.allSettled(
    Array.from({ length: count - scanStart + 1 }, (_, i) => contract.getMarket(scanStart + i))
  );
  const allMkts = settled1.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  const existing = new Set(allMkts.map(m => m.trainId + "|" + m.departureDate));
  let created = 0;
  for (const train of trains) {
    const deptMs = new Date(train.AdvertisedTimeAtLocation).getTime();
    if (deptMs < now + 1800000 || deptMs > cutoff) continue; // skip if closing time (30 min before departure) already passed
    const dest = train.ToLocation?.find(l => DEST_SIGNATURES.includes(l.LocationName))?.LocationName;
    if (!dest) continue;
    const trainId = train.AdvertisedTrainIdent + " " + dest;
    const deptDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date(deptMs));
    if (existing.has(trainId + "|" + deptDate)) continue;
    try {
      const tx = await contract.createMarket(
        trainId, deptDate, Math.floor(deptMs / 1000) - 1800, BASE_GAS
      );
      await tx.wait();
      console.log("Created: " + trainId);
      existing.add(trainId + "|" + deptDate);
      created++;
    } catch (err) {
      console.error("Failed to create " + trainId + ": " + err.message);
    }
  }
  console.log("Created " + created + " new markets");
}

async function resolveMarkets(contract, apiKey, BASE_GAS) {
  console.log("Resolving markets...");
  let count = 0;
  try { count = Number(await contract.marketCount()); } catch(e) { console.error('marketCount err: ' + e.message); return; }
  const now     = Math.floor(Date.now() / 1000);
  // Scan last 200 markets — unresolved markets older than 48h are skipped anyway
  const scanStart2 = Math.max(1, count - 199);
  const settled2 = await Promise.allSettled(
    Array.from({ length: count - scanStart2 + 1 }, (_, i) => contract.getMarket(scanStart2 + i))
  );
  const allMkts = settled2.map((r, i) => r.status !== 'fulfilled' ? null : { trainId: r.value.trainId, departureDate: r.value.departureDate, closingTime: r.value.closingTime, outcome: r.value.outcome, totalYes: r.value.totalYes, totalNo: r.value.totalNo, marketId: scanStart2 + i }).filter(Boolean);
  const toResolve = allMkts
    .filter(m => Number(m.outcome) === Outcome.Unresolved &&
                 Number(m.closingTime) <= now &&
                 Number(m.closingTime) >= now - 48 * 3600); // skip markets older than 48 h
  console.log(toResolve.length + " markets need resolving");
  let resolved = 0;
  for (const m of toResolve) {
    const [trainIdent, destSig = "G"] = m.trainId.split(" ");
    try {
      const { arrived, delayMinutes, cancelled } = await fetchArrivalStatus(
        apiKey, trainIdent, destSig, m.departureDate
      );
      if (!arrived && !cancelled) {
        console.log(m.trainId + " not yet arrived");
        continue;
      }
      const isDelayed = cancelled || delayMinutes >= DELAY_THRESHOLD_MINUTES;
      const outcome   = isDelayed ? Outcome.Delayed : Outcome.OnTime;
      const tx = await contract.resolveMarket(m.marketId, outcome, BASE_GAS);
      await tx.wait();
      console.log("Resolved #" + m.marketId + " " + m.trainId + " isDelayed=" + isDelayed);
      resolved++;
    } catch (err) {
      console.error("Failed " + m.trainId + ": " + err.message);
    }
  }
  console.log("Resolved " + resolved + " markets");
}

// Try each RPC until one can actually serve eth_call (probed via marketCount).
// Public Base RPCs sometimes throttle eth_call while still serving eth_blockNumber,
// so we must probe with a real contract call, not getBlockNumber().
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
      const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
      const count = await Promise.race([
        contract.marketCount(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 4000)),
      ]);
      console.log(`[Oracle] RPC: ${url} | wallet: ${wallet.address} | marketCount: ${count}`);
      return { wallet, contract };
    } catch (e) {
      console.warn(`[Oracle] RPC ${url} failed: ${e.message}`);
    }
  }
  throw new Error("All RPC endpoints unavailable");
}

const oracleJob = async () => {
  try {
    const apiKey          = process.env.TRAFIKVERKET_API_KEY;
    const privateKey      = process.env.TREASURY_PRIVATE_KEY;
    const contractAddress = process.env.CONTRACT_ADDRESS ?? "0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9";
    if (!apiKey)     throw new Error("Missing TRAFIKVERKET_API_KEY");
    if (!privateKey) throw new Error("Missing TREASURY_PRIVATE_KEY");
    // Define gas params here (inside oracleJob) so ethers.parseUnits never runs at module load time.
    // A top-level ethers call makes the scheduled handler fail to register silently.
    const BASE_GAS = {
      maxFeePerGas:         ethers.parseUnits("0.005", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
    };
    const { contract } = await connectToChain(privateKey, contractAddress);
    await createMarkets(contract, apiKey, BASE_GAS);
    await resolveMarkets(contract, apiKey, BASE_GAS);
    console.log("Done");
  } catch (err) {
    console.error("Oracle error:", err.message);
  }
};

export const handler = schedule("*/5 * * * *", oracleJob);

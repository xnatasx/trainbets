import { schedule } from "@netlify/functions";
import { ethers }    from "ethers";

const DELAY_THRESHOLD_MINUTES = 5;
const MARKET_LOOKAHEAD_HOURS  = 8;
const TV_API = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const Outcome = { Unresolved: 0, OnTime: 1, Delayed: 2 };
const DEST_SIGNATURES = ["G", "M", "Son", "U"];

const CONTRACT_ABI = [
  "function marketCount() view returns (uint256)",
  "function markets(uint256) view returns (string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 totalYes, uint256 totalNo)",
  "function createMarket(string calldata trainId, string calldata departureDate, uint256 closingTime) external returns (uint256)",
  "function resolveMarket(uint256 marketId, uint8 outcome) external",
];

const BASE_GAS = {
  maxFeePerGas:         ethers.parseUnits("0.005", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
};

async function tvFetch(apiKey, objecttype, filter, includes) {
  const r = await fetch(TV_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ REQUEST: { LOGIN: { authenticationkey: apiKey }, QUERY: [{ objecttype, schemaversion: "1.8", FILTER: filter, INCLUDE: includes }] } }),
  });
  return ((await r.json())?.RESPONSE?.RESULT?.[0]) ?? {};
}

async function fetchTodayDepartures(apiKey) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await tvFetch(apiKey, "TrainAnnouncement", {
    AND: [
      { EQ: { name: "ActivityType",             value: "Avgang"                      } },
      { EQ: { name: "LocationSignature",        value: "Cst"                         } },
      { EQ: { name: "Advertised",               value: "true"                        } },
      { GT: { name: "AdvertisedTimeAtLocation", value: today + "T00:00:00.000+01:00" } },
      { LT: { name: "AdvertisedTimeAtLocation", value: today + "T23:59:59.000+01:00" } },
    ],
  }, ["AdvertisedTrainIdent", "AdvertisedTimeAtLocation", "Canceled", "ToLocation"]);
  return res.TrainAnnouncement ?? [];
}

async function fetchArrivalStatus(apiKey, trainIdent, destSig, departureDate) {
  const res = await tvFetch(apiKey, "TrainAnnouncement", {
    AND: [
      { EQ:   { name: "ActivityType",               value: "Ankomst"           } },
      { EQ:   { name: "AdvertisedTrainIdent",       value: trainIdent          } },
      { EQ:   { name: "LocationSignature",          value: destSig             } },
      { LIKE: { name: "ScheduledDepartureDateTime", value: departureDate + "%" } },
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

async function createMarkets(contract, apiKey) {
  console.log("Creating markets...");
  const trains = await fetchTodayDepartures(apiKey);
  const now    = Date.now();
  const cutoff = now + MARKET_LOOKAHEAD_HOURS * 3600000;
  const today  = new Date().toISOString().slice(0, 10);
  let count = 0;
  try { count = Number(await contract.marketCount()); } catch(e) { console.error('marketCount err: ' + e.message); return; }
  const settled1 = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => contract.markets(i + 1))
  );
  const allMkts = settled1.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  const existing = new Set(allMkts.map(m => m.trainId + "|" + m.departureDate));
  let created = 0;
  for (const train of trains) {
    const deptMs = new Date(train.AdvertisedTimeAtLocation).getTime();
    if (deptMs < now || deptMs > cutoff) continue;
    const dest = train.ToLocation?.[0]?.LocationName;
    if (!DEST_SIGNATURES.includes(dest)) continue;
    const trainId = train.AdvertisedTrainIdent + " " + dest;
    if (existing.has(trainId + "|" + today)) continue;
    try {
      const tx = await contract.createMarket(
        trainId, today, Math.floor(deptMs / 1000) + 1800, BASE_GAS
      );
      await tx.wait();
      console.log("Created: " + trainId);
      existing.add(trainId + "|" + today);
      created++;
    } catch (err) {
      console.error("Failed to create " + trainId + ": " + err.message);
    }
  }
  console.log("Created " + created + " new markets");
}

async function resolveMarkets(contract, apiKey) {
  console.log("Resolving markets...");
  let count = 0;
  try { count = Number(await contract.marketCount()); } catch(e) { console.error('marketCount err: ' + e.message); return; }
  const now     = Math.floor(Date.now() / 1000);
  const settled2 = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => contract.markets(i + 1))
  );
  const allMkts = settled2.map((r, i) => r.status === 'fulfilled' ? { ...r.value, marketId: i + 1 } : null).filter(Boolean);
  const toResolve = allMkts
    .filter(m => Number(m.outcome) === Outcome.Unresolved && Number(m.closingTime) <= now);
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

const oracleJob = async () => {
  try {
    const apiKey          = process.env.TRAFIKVERKET_API_KEY;
    const privateKey      = process.env.TREASURY_PRIVATE_KEY;
    const rpcUrl          = process.env.RPC_URL          ?? "https://mainnet.base.org";
    const contractAddress = process.env.CONTRACT_ADDRESS ?? "0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9";
    if (!apiKey)     throw new Error("Missing TRAFIKVERKET_API_KEY");
    if (!privateKey) throw new Error("Missing TREASURY_PRIVATE_KEY");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
    console.log("TrainBets Oracle v2 — wallet: " + wallet.address);
    await createMarkets(contract, apiKey);
    await resolveMarkets(contract, apiKey);
    console.log("Done");
  } catch (err) {
    console.error("Oracle error:", err.message);
  }
};

export const handler = schedule("* * * * *", oracleJob);

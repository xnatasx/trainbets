// TrainBets Keeper — runs via GitHub Actions every 5 minutes
// Creates markets for today's departures and resolves expired ones
import { ethers } from "ethers";

const TV_API = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const DEST_SIGS = ["G", "M", "Son", "U"];
const DELAY_THRESHOLD = 5; // minutes
const Outcome = { Unresolved: 0, OnTime: 1, Delayed: 2 };

const ABI = [
  "function marketCount() view returns (uint256)",
  "function markets(uint256) view returns (string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 totalYes, uint256 totalNo)",
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
  const today = new Date().toISOString().slice(0, 10);
  const res = await tvFetch(apiKey, "TrainAnnouncement", {
    AND: [
      { EQ: { name: "ActivityType",             value: "Avgang"                      } },
      { EQ: { name: "LocationSignature",        value: "Cst"                         } },
      { IN: { name: "ToLocation.LocationName",  value: DEST_SIGS                     } },
      { GT: { name: "AdvertisedTimeAtLocation", value: today + "T00:00:00.000+01:00" } },
      { LT: { name: "AdvertisedTimeAtLocation", value: today + "T23:59:59.000+01:00" } },
    ],
  }, ["AdvertisedTrainIdent", "AdvertisedTimeAtLocation", "Canceled", "ToLocation"]);
  return res.TrainAnnouncement ?? [];
}

async function fetchArrival(apiKey, trainIdent, destSig, departureDate) {
  const res = await tvFetch(apiKey, "TrainAnnouncement", {
    AND: [
      { EQ:   { name: "ActivityType",               value: "Ankomst"            } },
      { EQ:   { name: "AdvertisedTrainIdent",       value: trainIdent           } },
      { EQ:   { name: "LocationSignature",          value: destSig              } },
      { LIKE: { name: "ScheduledDepartureDateTime", value: departureDate + "%"  } },
    ],
  }, ["TimeAtLocation", "AdvertisedTimeAtLocation", "Canceled"]);
  const ann = res.TrainAnnouncement?.[0];
  if (!ann) return { arrived: false, delayMinutes: 0, cancelled: false };
  const delay = ann.TimeAtLocation
    ? Math.round((new Date(ann.TimeAtLocation) - new Date(ann.AdvertisedTimeAtLocation)) / 60000)
    : 0;
  return { arrived: !!ann.TimeAtLocation, delayMinutes: delay, cancelled: ann.Canceled === true };
}

async function run() {
  const apiKey     = process.env.TRAFIKVERKET_API_KEY;
  const privateKey = process.env.KEEPER_PRIVATE_KEY;
  const rpcUrl     = process.env.RPC_URL          ?? "https://mainnet.base.org";
  const contractAddress = process.env.CONTRACT_ADDRESS ?? "0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9";

  if (!apiKey)     throw new Error("Missing TRAFIKVERKET_API_KEY");
  if (!privateKey) throw new Error("Missing KEEPER_PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, ABI, wallet);

  console.log(`[Keeper] Wallet: ${wallet.address}`);
  const today = new Date().toISOString().slice(0, 10);
  const now   = Math.floor(Date.now() / 1000);

  // — Load existing markets —
  const count = Number(await contract.marketCount());
  const mkts  = (await Promise.allSettled(
    Array.from({ length: count }, (_, i) => contract.markets(i + 1))
  )).map((r, i) => r.status === "fulfilled"
    ? { trainId: r.value.trainId, departureDate: r.value.departureDate,
        closingTime: Number(r.value.closingTime), outcome: Number(r.value.outcome),
        totalYes: r.value.totalYes, totalNo: r.value.totalNo, marketId: i + 1 }
    : null
  ).filter(Boolean);

  // — Create new markets —
  const trains  = await fetchDepartures(apiKey);
  console.log(`[Keeper] ${trains.length} departures from Trafikverket`);
  // Debug: print first 5 trains so we can see what ToLocation actually contains
  trains.slice(0, 5).forEach((t, i) =>
    console.log(`[Keeper] train[${i}]: ${t.AdvertisedTrainIdent} ${t.AdvertisedTimeAtLocation} ToLocation=${JSON.stringify(t.ToLocation)}`)
  );
  const existing = new Set(mkts.map(m => m.trainId + "|" + m.departureDate));
  const cutoff  = now + 8 * 3600; // 8h lookahead
  let created = 0;
  let skipped = { past: 0, future: 0, dest: 0, exists: 0 };

  for (const train of trains) {
    const deptMs = new Date(train.AdvertisedTimeAtLocation).getTime();
    const deptSec = deptMs / 1000;
    if (deptSec < now) { skipped.past++; continue; }
    if (deptSec > cutoff) { skipped.future++; continue; }
    const dest = train.ToLocation?.find(l => DEST_SIGS.includes(l.LocationName))?.LocationName;
    if (!dest) { skipped.dest++; continue; }
    const trainId = train.AdvertisedTrainIdent + " " + dest;
    if (existing.has(trainId + "|" + today)) { skipped.exists++; continue; }
    try {
      const tx = await contract.createMarket(trainId, today, Math.floor(deptSec) + 1800, GAS);
      await tx.wait();
      console.log(`[Keeper] Created: ${trainId}`);
      existing.add(trainId + "|" + today);
      created++;
    } catch (err) {
      console.error(`[Keeper] Create failed ${trainId}: ${err.message}`);
    }
  }
  console.log(`[Keeper] Skipped: past=${skipped.past} future=${skipped.future} wrongDest=${skipped.dest} alreadyExists=${skipped.exists}`);
  console.log(`[Keeper] Created ${created} markets`);

  // — Resolve expired markets —
  const toResolve = mkts.filter(m => m.outcome === Outcome.Unresolved && m.closingTime <= now);
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

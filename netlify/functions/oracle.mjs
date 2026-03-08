/**
 * TrainBets Oracle — v1 (Intercity Only)
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs as a Netlify scheduled function every 30 minutes.
 *
 * v1 scope: SJ intercity trains between major Swedish cities only.
 *           ~50-100 trains/day. Gas cost ~$3-5/month.
 * v2 scope: All trains in Sweden (coming soon, shown on site).
 *
 * Two jobs:
 *  1. CREATE MARKETS — fetch intercity departures for next 24h, create a
 *     market for each one not yet created. Bets close 1h before departure.
 *
 *  2. RESOLVE MARKETS — check unresolved markets whose closing time has
 *     passed, query actual arrival, and resolve on-chain.
 *     Delayed = >5 min late. Cancelled = Delayed.
 *
 * Environment variables (set in Netlify dashboard — never commit these):
 *   TRAFIKVERKET_API_KEY   — your Trafikverket open API key
 *   TREASURY_PRIVATE_KEY   — private key of treasury wallet
 *   CONTRACT_ADDRESS       — 0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9
 *   RPC_URL                — https://mainnet.base.org
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ethers } from "ethers";
import { schedule } from "@netlify/functions";

// ── Config ────────────────────────────────────────────────────────────────────

const TRAFIKVERKET_ENDPOINT    = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const DELAY_THRESHOLD_MINUTES  = 5;
const HOURS_AHEAD              = 24;
const BET_CLOSE_MINUTES_BEFORE = 60; // 1 hour before departure

/**
 * v1: Major intercity stations only.
 * Trafikverket LocationSignature codes for Sweden's biggest cities.
 * A market is only created if BOTH departure AND destination are in this set.
 */
const INTERCITY_STATIONS = new Set([
  "Cst",   // Stockholm Central
  "G",     // Goteborg Central
  "Ml",    // Malmo Central
  "U",     // Uppsala
  "Lp",    // Linkoping
  "Ka",    // Karlstad
  "Soc",   // Sodertälje C
  "Hu",    // Hassleholm
  "Kst",   // Kristianstad
  "Hs",    // Helsingborg
  "Nk",    // Norrkoping
  "Ob",    // Orebro
  "Va",    // Vasteras
  "Ga",    // Gavle
  "Sund",  // Sundsvall
  "A",     // Ostersund
  "Lul",   // Lulea
  "Um",    // Umea
  "Bo",    // Boras
  "Jo",    // Jonkoping
  "Kl",    // Kalmar
  "Vx",    // Vaxjo
]);

// Minimal ABI — only what the oracle needs
const CONTRACT_ABI = [
  "function createMarket(string trainId, string departureDate, uint256 closingTime) returns (uint256)",
  "function resolveMarket(uint256 marketId, uint8 outcome) external",
  "function marketCount() view returns (uint256)",
  "function markets(uint256) view returns (string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 poolOnTime, uint256 poolDelayed)",
];

const Outcome = { Unresolved: 0, OnTime: 1, Delayed: 2 };

// ── Trafikverket helpers ──────────────────────────────────────────────────────

async function queryTrafikverket(apiKey, xmlBody) {
  const response = await fetch(TRAFIKVERKET_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: xmlBody.replace("__API_KEY__", apiKey),
  });
  if (!response.ok) throw new Error(`Trafikverket API error: ${response.status}`);
  return response.json();
}

async function fetchIntercityDepartures(apiKey) {
  const now    = new Date();
  const future = new Date(now.getTime() + HOURS_AHEAD * 3600 * 1000);
  const from   = now.toISOString().slice(0, 19);
  const to     = future.toISOString().slice(0, 19);

  const xml = `
    <REQUEST>
      <LOGIN authenticationkey="__API_KEY__" />
      <QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="5000">
        <FILTER>
          <AND>
            <EQ name="ActivityType" value="Avgang" />
            <GT name="AdvertisedTimeAtLocation" value="${from}" />
            <LT name="AdvertisedTimeAtLocation" value="${to}" />
          </AND>
        </FILTER>
        <INCLUDE>AdvertisedTrainIdent</INCLUDE>
        <INCLUDE>AdvertisedTimeAtLocation</INCLUDE>
        <INCLUDE>LocationSignature</INCLUDE>
        <INCLUDE>ToLocation</INCLUDE>
        <INCLUDE>Canceled</INCLUDE>
      </QUERY>
    </REQUEST>`;

  const data = await queryTrafikverket(apiKey, xml);
  const all  = data?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement ?? [];

  return all.filter(dep => {
    const from = dep.LocationSignature ?? "";
    const to   = dep.ToLocation?.[0]?.LocationName ?? "";
    return INTERCITY_STATIONS.has(from) && INTERCITY_STATIONS.has(to);
  });
}

async function fetchArrivalStatus(apiKey, trainIdent, departureDate) {
  const xml = `
    <REQUEST>
      <LOGIN authenticationkey="__API_KEY__" />
      <QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="1">
        <FILTER>
          <AND>
            <EQ name="AdvertisedTrainIdent" value="${trainIdent}" />
            <EQ name="ActivityType" value="Ankomst" />
            <GT name="AdvertisedTimeAtLocation" value="${departureDate}T00:00:00" />
            <LT name="AdvertisedTimeAtLocation" value="${departureDate}T23:59:59" />
          </AND>
        </FILTER>
        <INCLUDE>AdvertisedTimeAtLocation</INCLUDE>
        <INCLUDE>TimeAtLocation</INCLUDE>
        <INCLUDE>Canceled</INCLUDE>
      </QUERY>
    </REQUEST>`;

  const data         = await queryTrafikverket(apiKey, xml);
  const announcement = data?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement?.[0];

  if (!announcement) return { arrived: false, delayMinutes: 0, cancelled: false };

  const cancelled  = announcement.Canceled === true;
  const advertised = new Date(announcement.AdvertisedTimeAtLocation);
  const actual     = announcement.TimeAtLocation ? new Date(announcement.TimeAtLocation) : null;

  if (!actual && !cancelled) return { arrived: false, delayMinutes: 0, cancelled: false };

  const delayMinutes = actual ? Math.round((actual - advertised) / 60000) : 0;
  return { arrived: true, delayMinutes, cancelled };
}

// ── Market helpers ────────────────────────────────────────────────────────────

function buildTrainId(dep) {
  const ident = dep.AdvertisedTrainIdent ?? "unknown";
  const from  = dep.LocationSignature ?? "";
  const to    = dep.ToLocation?.[0]?.LocationName ?? "";
  const time  = dep.AdvertisedTimeAtLocation?.slice(11, 16) ?? "";
  return `${ident} ${from}->${to} ${time}`;
}

async function loadExistingTrainIds(contract) {
  const count    = Number(await contract.marketCount());
  const existing = new Set();
  for (let i = 1; i <= count; i++) {
    const m = await contract.markets(i);
    existing.add(m.trainId);
  }
  return existing;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

async function createMarkets(contract, apiKey) {
  console.log("Fetching intercity departures...");
  const departures = await fetchIntercityDepartures(apiKey);
  console.log(`Found ${departures.length} intercity departures`);

  const existing = await loadExistingTrainIds(contract);
  let created = 0;

  for (const dep of departures) {
    const trainId = buildTrainId(dep);
    if (existing.has(trainId)) continue;

    const departureTime = new Date(dep.AdvertisedTimeAtLocation);
    const closingTime   = Math.floor(departureTime.getTime() / 1000) - (BET_CLOSE_MINUTES_BEFORE * 60);
    const departureDate = dep.AdvertisedTimeAtLocation.slice(0, 10);

    if (closingTime <= Math.floor(Date.now() / 1000)) continue;

    try {
      const tx = await contract.createMarket(trainId, departureDate, closingTime);
      await tx.wait();
      console.log(`Created: ${trainId}`);
      existing.add(trainId);
      created++;
    } catch (err) {
      console.error(`Failed to create ${trainId}: ${err.message}`);
    }
  }
  console.log(`Created ${created} new markets`);
}

async function resolveMarkets(contract, apiKey) {
  console.log("Resolving markets...");
  const count = Number(await contract.marketCount());
  const now   = Math.floor(Date.now() / 1000);
  let resolved = 0;

  for (let marketId = 1; marketId <= count; marketId++) {
    const m = await contract.markets(marketId);
    if (m.outcome !== BigInt(Outcome.Unresolved)) continue;
    if (Number(m.closingTime) > now) continue;

    const trainIdent = m.trainId.split(" ")[0];

    try {
      const { arrived, delayMinutes, cancelled } = await fetchArrivalStatus(
        apiKey, trainIdent, m.departureDate
      );

      if (!arrived && !cancelled) {
        console.log(`${m.trainId} — not yet arrived`);
        continue;
      }

      const isDelayed = cancelled || delayMinutes >= DELAY_THRESHOLD_MINUTES;
      const outcome   = isDelayed ? Outcome.Delayed : Outcome.OnTime;
      const label     = isDelayed
        ? `DELAYED ${cancelled ? "(cancelled)" : `+${delayMinutes}min`}`
        : `ON TIME (+${delayMinutes}min)`;

      const tx = await contract.resolveMarket(marketId, outcome);
      await tx.wait();
      console.log(`Resolved #${marketId} ${m.trainId} -> ${label}`);
      resolved++;
    } catch (err) {
      console.error(`Failed to resolve #${marketId}: ${err.message}`);
    }
  }
  console.log(`Resolved ${resolved} markets`);
}

// ── Netlify scheduled function entry point ────────────────────────────────────

const oracleJob = async () => {
  try {
    const apiKey          = process.env.TRAFIKVERKET_API_KEY;
    const privateKey      = process.env.TREASURY_PRIVATE_KEY;
    const rpcUrl          = process.env.RPC_URL || "https://mainnet.base.org";
    const contractAddress = process.env.CONTRACT_ADDRESS || "0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9";

    if (!apiKey)     throw new Error("Missing TRAFIKVERKET_API_KEY");
    if (!privateKey) throw new Error("Missing TREASURY_PRIVATE_KEY");

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

    console.log(`TrainBets Oracle — wallet: ${wallet.address}`);
    await createMarkets(contract, apiKey);
    await resolveMarkets(contract, apiKey);
    console.log("Done");
  } catch (err) {
    console.error("Oracle error:", err);
  }
};

// Runs every 30 minutes
export const handler = schedule("*/30 * * * *", oracleJob);

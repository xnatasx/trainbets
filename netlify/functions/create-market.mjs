import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9";
const CONTRACT_ABI = [
  "function marketCount() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 totalYes, uint256 totalNo))",
  "function createMarket(string calldata trainId, string calldata departureDate, uint256 closingTime) external returns (uint256)",
];
// NOTE: BASE_GAS is defined inside handler() — NOT at module scope.
// Top-level ethers calls would crash the module on load and cause Netlify to return an HTML error
// page instead of JSON, making every response appear as "Unexpected token '<'".
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Multiple RPC endpoints — tried in order, first working one is used.
// Matches the fallback list used in the frontend.
const RPC_URLS = [
  process.env.RPC_URL ?? "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base-rpc.publicnode.com",
  "https://rpc.ankr.com/base",
  "https://1rpc.io/base",
];

// Probe an RPC by calling marketCount() with a 4s timeout.
// getBlockNumber() can pass on a node that throttles eth_call, so we use a real contract call.
async function probeRpc(contract) {
  return Promise.race([
    contract.marketCount(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 4000)),
  ]);
}

async function getWalletAndContract(privateKey, contractAddress) {
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const wallet   = new ethers.Wallet(privateKey, provider);
      const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
      const count = Number(await probeRpc(contract));
      console.log(`[create-market] RPC: ${url} | wallet: ${wallet.address} | marketCount: ${count}`);
      return { wallet, contract, count };
    } catch (e) {
      console.warn(`[create-market] RPC ${url} failed: ${e.message}`);
    }
  }
  throw new Error("All RPC endpoints unavailable — please retry in a moment");
}

// Scan recent markets for {trainId, departureDate} across every RPC in the fallback list.
// The active contract's provider may start throttling eth_call after the initial probe +
// 200 getMarket calls; retrying on a fresh RPC keeps the lookup reliable without surfacing
// raw CALL_EXCEPTION / "missing revert data" errors to the user.
async function findMarketAcrossRpcs(contractAddress, trainId, departureDate, scanSize = 200) {
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const readOnly = new ethers.Contract(contractAddress, CONTRACT_ABI, provider);
      const cnt      = Number(await probeRpc(readOnly));
      const start    = Math.max(1, cnt - scanSize + 1);
      const results  = await Promise.allSettled(
        Array.from({ length: cnt - start + 1 }, (_, i) => readOnly.getMarket(start + i))
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "fulfilled") {
          const m = results[i].value;
          if (m.trainId === trainId && m.departureDate === departureDate) return start + i;
        }
      }
      return null; // scan completed, nothing matched
    } catch (e) {
      console.warn(`[create-market] findMarket RPC ${url} failed: ${e.message}`);
    }
  }
  throw new Error("All RPC endpoints unavailable — please retry in a moment");
}

// Ethers surfaces throttled/empty eth_call responses as CALL_EXCEPTION with null revert data.
// The raw message ("missing revert data ... code=CALL_EXCEPTION") is meaningless to end users,
// so translate those (and common network/timeout errors) into a single friendly sentence.
function friendlyError(err) {
  const msg  = err?.message ?? "";
  const code = err?.code;
  if (code === "CALL_EXCEPTION" && (err?.data == null || err?.data === "0x")) {
    return "RPC temporarily unavailable — please retry in a moment";
  }
  if (code === "NETWORK_ERROR" || code === "TIMEOUT" || /timeout|fetch failed|ECONN/i.test(msg)) {
    return "RPC temporarily unavailable — please retry in a moment";
  }
  return msg || "Unknown error";
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };

  try {
    const { trainId, departureDate, closingTime } = JSON.parse(event.body ?? "{}");
    if (!trainId || !departureDate || !closingTime) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing fields: trainId, departureDate, closingTime" }) };
    }
    if (Number(closingTime) <= Math.floor(Date.now() / 1000)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Market already closed (closingTime in the past)" }) };
    }

    // Define gas params here (inside handler) so ethers.parseUnits never runs at module load time.
    // A top-level ethers call makes Netlify return HTML on module crash instead of our JSON error.
    const BASE_GAS = {
      maxFeePerGas:         ethers.parseUnits("0.005", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
    };

    const privateKey      = process.env.TREASURY_PRIVATE_KEY;
    const contractAddress = process.env.CONTRACT_ADDRESS ?? CONTRACT_ADDRESS;
    if (!privateKey) throw new Error("Missing TREASURY_PRIVATE_KEY — set this env var in Netlify dashboard");

    const { contract, count: marketCount } = await getWalletAndContract(privateKey, contractAddress);

    // Check if market already exists — return immediately if so (idempotent).
    // Scan last 200 markets (matches frontend/oracle/keeper scan size).
    // count comes from the RPC probe in getWalletAndContract — no second call needed.
    const count     = marketCount;
    const scanStart = Math.max(1, count - 199);
    const settled   = await Promise.allSettled(
      Array.from({ length: count - scanStart + 1 }, (_, i) => contract.getMarket(scanStart + i))
    );
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === "fulfilled") {
        const m = settled[i].value;
        if (m.trainId === trainId && m.departureDate === departureDate) {
          const existingId = scanStart + i;
          console.log(`[create-market] already exists: ${trainId} ${departureDate} → marketId ${existingId}`);
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ marketId: existingId }) };
        }
      }
    }

    // Predict the new marketId via staticCall (no gas, instant).
    // Only catch CALL_EXCEPTION (contract revert) here — network errors are re-thrown
    // so the outer handler returns the real error rather than a misleading "closing time" message.
    let expectedId;
    try {
      expectedId = Number(await contract.createMarket.staticCall(
        trainId, departureDate, Number(closingTime)
      ));
    } catch (scErr) {
      if (scErr.code !== "CALL_EXCEPTION") throw scErr; // network/RPC error — bubble up with real message

      // Contract rejected — oracle may have just created this market; scan for it
      console.log(`[create-market] staticCall CALL_EXCEPTION (reason: ${scErr.reason ?? scErr.message}) — scanning for existing market...`);
      const mid = await findMarketAcrossRpcs(contractAddress, trainId, departureDate);
      if (mid !== null) {
        console.log(`[create-market] found after staticCall fail: marketId=${mid}`);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ marketId: mid }) };
      }
      throw new Error("Contract rejected market creation (closing time may have passed for this train)");
    }

    // Submit the real transaction — await submission but NOT mining (Base mines in ~2s)
    console.log(`[create-market] submitting: ${trainId} ${departureDate} closingTime=${closingTime} → expected marketId=${expectedId}`);
    try {
      await contract.createMarket(trainId, departureDate, Number(closingTime), BASE_GAS);
    } catch (txErr) {
      const isRace = txErr.code === "REPLACEMENT_UNDERPRICED"
        || txErr.code === "CALL_EXCEPTION"
        || txErr.message?.includes("replacement")
        || txErr.message?.includes("underpriced")
        || txErr.message?.includes("revert");
      if (!isRace) throw txErr;

      // Race with oracle: poll every 2s for up to 10s for the market to appear
      console.log(`[create-market] race condition (${txErr.code}) — polling for market...`);
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        const mid = await findMarketAcrossRpcs(contractAddress, trainId, departureDate);
        if (mid !== null) {
          console.log(`[create-market] found after ${(attempt + 1) * 2}s: marketId=${mid}`);
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ marketId: mid }) };
        }
      }
      throw new Error("Market creation is taking longer than expected — please retry in a moment");
    }

    console.log(`[create-market] submitted marketId=${expectedId}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ marketId: expectedId }) };

  } catch (err) {
    console.error("[create-market]", err.message, err.code ?? "");
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: friendlyError(err) }) };
  }
}

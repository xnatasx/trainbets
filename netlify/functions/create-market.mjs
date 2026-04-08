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

    const rpcUrl          = process.env.RPC_URL          ?? "https://mainnet.base.org";
    const privateKey      = process.env.TREASURY_PRIVATE_KEY;
    const contractAddress = process.env.CONTRACT_ADDRESS ?? CONTRACT_ADDRESS;
    if (!privateKey) throw new Error("Missing TREASURY_PRIVATE_KEY — set this env var in Netlify dashboard");

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

    // Check if market already exists — return immediately if so (idempotent)
    const count    = Number(await contract.marketCount());
    // Scan only the most recent 50 markets — covers ~2 days at current creation rate
    const scanStart = Math.max(1, count - 49);
    const settled  = await Promise.allSettled(
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

    // Helper: scan last N markets looking for this trainId+date
    async function findMarket(scanSize = 20) {
      const cnt = Number(await contract.marketCount());
      const start = Math.max(1, cnt - scanSize + 1);
      const results = await Promise.allSettled(
        Array.from({ length: cnt - start + 1 }, (_, i) => contract.getMarket(start + i))
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "fulfilled") {
          const m = results[i].value;
          if (m.trainId === trainId && m.departureDate === departureDate) {
            return start + i;
          }
        }
      }
      return null;
    }

    // Predict the new marketId via staticCall (no gas, instant).
    // If staticCall itself reverts (oracle created the market between the dedup scan above and now),
    // fall through to the poll loop below.
    let expectedId;
    try {
      expectedId = Number(await contract.createMarket.staticCall(
        trainId, departureDate, Number(closingTime)
      ));
    } catch (scErr) {
      // staticCall failed — market was likely just created by the oracle; scan for it
      console.log(`[create-market] staticCall reverted (${scErr.code}) — scanning for existing market...`);
      const mid = await findMarket(20);
      if (mid !== null) {
        console.log(`[create-market] found immediately after staticCall fail: marketId=${mid}`);
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
        const mid = await findMarket(20);
        if (mid !== null) {
          console.log(`[create-market] found after ${(attempt+1)*2}s: marketId=${mid}`);
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ marketId: mid }) };
        }
      }
      throw new Error("Market creation is taking longer than expected — please retry in a moment");
    }

    console.log(`[create-market] submitted marketId=${expectedId}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ marketId: expectedId }) };

  } catch (err) {
    console.error("[create-market]", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
}

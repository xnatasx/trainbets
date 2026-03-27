import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0xB54bCee43ACad2c99e59Bc89f19823181DA4ceF9";
const CONTRACT_ABI = [
  "function marketCount() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(string trainId, string departureDate, uint256 closingTime, uint8 outcome, uint256 totalYes, uint256 totalNo))",
  "function createMarket(string calldata trainId, string calldata departureDate, uint256 closingTime) external returns (uint256)",
];
const BASE_GAS = {
  maxFeePerGas:         ethers.parseUnits("0.005", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
};
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

    const rpcUrl          = process.env.RPC_URL          ?? "https://mainnet.base.org";
    const privateKey      = process.env.TREASURY_PRIVATE_KEY;
    const contractAddress = process.env.CONTRACT_ADDRESS ?? CONTRACT_ADDRESS;
    if (!privateKey) throw new Error("Missing TREASURY_PRIVATE_KEY");

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

    // Predict the new marketId via staticCall (no gas, instant)
    const expectedId = Number(await contract.createMarket.staticCall(
      trainId, departureDate, Number(closingTime)
    ));
    // Submit the real transaction — await submission but NOT mining (Base mines in ~2s)
    // By the time the user enters a bet amount and clicks Approve, it will be confirmed.
    console.log(`[create-market] submitting: ${trainId} ${departureDate} closingTime=${closingTime} → expected marketId=${expectedId}`);
    await contract.createMarket(trainId, departureDate, Number(closingTime), BASE_GAS);
    console.log(`[create-market] submitted marketId=${expectedId}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ marketId: expectedId }) };

  } catch (err) {
    console.error("[create-market]", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
}

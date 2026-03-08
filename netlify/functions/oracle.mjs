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








// Runs every 1 minute
export const handler = schedule("* * * * *", oracleJob);








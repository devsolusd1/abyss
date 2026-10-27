// Checks the chain layer against devnet by SIMULATION ONLY: nothing is signed or sent. It loads
// the built bundle (../vendor/chain.js), the very file the site ships.
//
//   npm run check
//   OWNER=<funded devnet address> npm run check

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
Chain.setNet({
  cluster: "devnet",
  rpcUrl: process.env.RPC_URL ?? "https://api.devnet.solana.com",
  program: process.env.PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK",
});
const OWNER = process.env.OWNER ?? "7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA";

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };

const config = await Chain.readConfig();
line(!!config, `config: admin ${config && Chain.short(config.admin)}, launches ${config?.launchesOpen ? "open" : "team only"}`);

const pools = await Chain.listPools();
line(pools.length > 0, `${pools.length} pool(s) on the program`);
const pool = pools[0];
console.log(`         ${pool.name} (${pool.symbol})  price ${pool.price.toExponential(4)} SOL  market cap ${pool.marketCap.toFixed(3)} SOL  `
  + `to graduation ${(pool.progress * 100).toFixed(2)}%  fee ${pool.feeBps / 100}%`);

const events = await Chain.history(pool.mint);
const trades = events.filter((e) => e.kind === "trade");
line(events.some((e) => e.kind === "launch") && trades.length >= 3, `history: ${events.length} events, ${trades.length} trades`);
const points = Chain.pricePoints(events, pool);
line(points.length === trades.length && points.every((p) => p.price > 0), `price points: ${points.map((p) => p.price.toExponential(3)).join(", ")}`);

const buy = await Chain.buildBuy({ pool, owner: OWNER, sol: 0.01 });
const buySim = await Chain.simulate(buy, OWNER);
line(buySim.ok, `buy 0.01 SOL -> ${Chain.tokens(buy.quote.tokensOut).toFixed(2)} tokens: ${buySim.ok ? "simulated cleanly" : buySim.error} (${buySim.units} units)`);

const wallet = await Chain.readWallet(OWNER, pool.mint);
if (wallet.tokens > 0n) {
  const sell = await Chain.buildSell({ pool, owner: OWNER, tokens: wallet.tokens / 10n });
  const sellSim = await Chain.simulate(sell, OWNER);
  line(sellSim.ok, `sell a tenth -> ${Chain.sol(sell.quote.solOut).toFixed(6)} SOL: ${sellSim.ok ? "simulated cleanly" : sellSim.error} (${sellSim.units} units)`);
}

// fee claims, on the first pool that owes something: the creator's signed by its creator, the platform's sent by OWNER
const owing = pools.find((p) => p.creatorFees > 0n) ?? null;
if (owing) {
  const claim = await Chain.buildClaim({ pool: owing, owner: owing.creator });
  const claimSim = await Chain.simulate(claim, owing.creator);
  line(claimSim.ok, `creator claims ${Chain.sol(claim.amount)} SOL from ${owing.name}: ${claimSim.ok ? "simulated cleanly" : claimSim.error} (${claimSim.units} units)`);
  const wrong = await Chain.simulate(await Chain.buildClaim({ pool: owing, owner: "11111111111111111111111111111112" }), OWNER);
  line(!wrong.ok, `someone else claiming the creator's fees is refused: ${wrong.error}`);
}
const owingT = pools.find((p) => p.treasuryFees > 0n) ?? null;
if (owingT) {
  const claimT = await Chain.buildClaim({ pool: owingT, owner: OWNER, creator: false });
  const claimTSim = await Chain.simulate(claimT, OWNER);
  line(claimTSim.ok, `platform's ${Chain.sol(claimT.amount)} SOL sent to the treasury: ${claimTSim.ok ? "simulated cleanly" : claimTSim.error} (${claimTSim.units} units)`);
}

const launch = await Chain.buildLaunch({ creator: OWNER, name: "Check", symbol: "CHK", uri: "", firstBuySol: 0.05 });
const launchSim = await Chain.simulate(launch, OWNER);
line(launchSim.ok, `launch with a first buy: ${launchSim.ok ? "simulated cleanly" : launchSim.error} (${launchSim.units} units)`);
if (!launchSim.ok) console.log(launchSim.logs.slice(-8).join("\n"));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

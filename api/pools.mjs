// /api/pools: every pool of the program, read from the node once for every visitor (server/pools.mjs).
import { handlePools } from "../server/pools.mjs";

export default { fetch: (request) => handlePools(request, process.env) };

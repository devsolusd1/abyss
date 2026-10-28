// /api/rpc: the site's JSON-RPC door to Solana (server/rpc.mjs).
import { handleRpc } from "../server/rpc.mjs";

export default { fetch: (request) => handleRpc(request, process.env) };

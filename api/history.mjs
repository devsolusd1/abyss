// /api/history: a pool's recent transactions for every visitor at once (server/history.mjs).
import { handleHistory } from "../server/history.mjs";

export default { fetch: (request) => handleHistory(request, process.env) };

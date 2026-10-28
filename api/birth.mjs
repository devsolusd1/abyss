// /api/birth: a coin's launch and first buyers, with where their SOL came from (server/birth.mjs).
import { handleBirth } from "../server/birth.mjs";

export default { fetch: (request) => handleBirth(request, process.env) };

// /api/price: SOL's price in US dollars, for the charts (server/price.mjs).
import { handlePrice } from "../server/price.mjs";

export default { fetch: (request) => handlePrice(request, process.env) };

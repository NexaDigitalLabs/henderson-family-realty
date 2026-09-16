// GET /api/market
// Local market statistics for the six SW Riverside County cities the site
// covers — read from the stored monthly copy.
//
// ⚠ THIS ENDPOINT MUST NEVER CALL A PAID API. It used to call RentCast on every
// cache miss and ran up an overage bill; the reason, and the monthly job that
// replaced it, are at the top of api/market-refresh.js. A miss here costs one
// free Blob read, so the cache below is only about speed.
//
// The response shape is unchanged from the live-call version, so index.html did
// not need to change. `asOf` is still RentCast's own date for each figure, and
// the page prints it — the site never claims to be fresher than it is.

import { json, methodGuard } from './_lib.js';
import { readLatest } from './_market-store.js';
import { displayableMarkets } from './_market-refresh.js';

const CACHE_SECONDS = 21600;   // 6 hours — the figures change once a month.
const STALE_SECONDS = 604800;  // Serve stale up to 7 days rather than show nothing.

export default async function handler(req, res) {
  if (!methodGuard(req, res, 'GET')) return;

  try {
    const latest = await readLatest();
    // Only this month's and last month's figures — see displayableMarkets().
    const markets = displayableMarkets(latest?.markets, new Date());
    if (!markets.length) {
      return json(res, {
        available: false,
        error: latest ? 'Market data is out of date.' : 'Market data has not been fetched yet.',
      }, { sMaxAge: 300, swr: 300 });
    }

    return json(res, {
      available: true,
      source: latest.source?.name,
      sourceUrl: latest.source?.url,
      note: 'Market temperature is derived from days on market, not vendor-supplied.',
      fetchedAt: latest.fetchedAt,
      markets,
    }, { sMaxAge: CACHE_SECONDS, swr: STALE_SECONDS });
  } catch (err) {
    return json(res, {
      available: false,
      error: 'Market data temporarily unavailable.',
      detail: String(err.message || err),
    }, { sMaxAge: 300, swr: 3600 });
  }
}

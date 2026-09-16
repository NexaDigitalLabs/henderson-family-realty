// Where the local market figures come from — RentCast, today.
//
// ⚠ Only the monthly job calls this (api/market-refresh.js). A page visit never
// does: api/market.js reads the stored copy. That split is the whole fix for the
// 2026-08/09 overage, when every visit that missed Vercel's edge cache spent six
// paid requests (see the note at the top of api/market-refresh.js).
//
// When live MLS data replaces RentCast, this is the file that changes: export the
// same SOURCE and fetchMarkets() shape and nothing else has to move. Check the
// MLS's rules on publishing aggregate market statistics before switching.

import { fetchJson } from './_lib.js';

export const SOURCE = { name: 'RentCast', url: 'https://www.rentcast.io/' };

// One primary zip per city. The card label reflects the exact zip reported, so
// the figure is never attributed to an area it wasn't measured in.
export const MARKETS = [
  { key: 'temecula',     city: 'Temecula',      zip: '92592' },
  { key: 'murrieta',     city: 'Murrieta',      zip: '92562' },
  { key: 'menifee',      city: 'Menifee',       zip: '92584' },
  { key: 'wildomar',     city: 'Wildomar',      zip: '92595' },
  { key: 'lakeelsinore', city: 'Lake Elsinore', zip: '92530' },
  { key: 'winchester',   city: 'Winchester',    zip: '92596' },
];

/** Classify the market from days-on-market. This is a derived heuristic, not a
 *  vendor-supplied figure — the UI labels it as such. Thresholds follow the
 *  common NAR-style reading of absorption pace. */
function marketTemp(dom) {
  if (!Number.isFinite(dom)) return null;
  if (dom < 30) return { label: "Seller's", tone: 'seller' };
  if (dom <= 45) return { label: 'Balanced', tone: 'balanced' };
  return { label: "Buyer's", tone: 'buyer' };
}

/** Year-over-year median change, computed from RentCast's own monthly history.
 *
 *  History keys are "YYYY-MM". We look for the month ~12 back, but tolerate a
 *  ±2 month gap: RentCast's history is not always dense, and requesting a
 *  12-month range returns 12 entries INCLUDING the current month — so the exact
 *  12-back month may legitimately be absent. Requiring an exact key match made
 *  this return null for every market.
 *
 *  Returns null when nothing within tolerance exists — we omit the figure
 *  rather than compare against an arbitrary month and call it "year over year". */
function yearOverYear(saleData) {
  const current = saleData?.medianPrice;
  const history = saleData?.history;
  if (!Number.isFinite(current) || !history) return null;

  const months = Object.keys(history).filter(k => /^\d{4}-\d{2}$/.test(k)).sort();
  if (months.length < 2) return null;

  const monthIndex = key => {
    const [y, m] = key.split('-').map(Number);
    return y * 12 + (m - 1);
  };

  const latest = months[months.length - 1];
  const targetIdx = monthIndex(latest) - 12;

  // Closest available month to the 12-back target, within 2 months.
  let best = null, bestDist = Infinity;
  for (const key of months) {
    if (key === latest) continue;
    const price = history[key]?.medianPrice;
    if (!Number.isFinite(price) || price === 0) continue;
    const dist = Math.abs(monthIndex(key) - targetIdx);
    if (dist < bestDist) { bestDist = dist; best = { key, price }; }
  }

  if (!best || bestDist > 2) return null;

  return {
    percent: +(((current - best.price) / best.price) * 100).toFixed(1),
    comparedTo: best.key,
    monthsBack: monthIndex(latest) - monthIndex(best.key),
  };
}

async function fetchMarket({ key, city, zip }, apiKey) {
  // 24 months, not 12: a 12-month range returns 12 entries *including* the
  // current month, so the month we need for a year-over-year comparison falls
  // outside it. Same request cost either way.
  const url = `https://api.rentcast.io/v1/markets`
            + `?zipCode=${zip}&dataType=Sale&historyRange=24`;

  const data = await fetchJson(url, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
  });

  const sale = data?.saleData;
  if (!sale) throw new Error(`No saleData for ${zip}`);

  const dom = sale.medianDaysOnMarket ?? sale.averageDaysOnMarket;
  const yoy = yearOverYear(sale);

  return {
    key, city, zip,
    medianPrice:   Number.isFinite(sale.medianPrice) ? Math.round(sale.medianPrice) : null,
    pricePerSqFt:  Number.isFinite(sale.medianPricePerSquareFoot)
                     ? Math.round(sale.medianPricePerSquareFoot) : null,
    daysOnMarket:  Number.isFinite(dom) ? Math.round(dom) : null,
    activeListings: Number.isFinite(sale.totalListings) ? sale.totalListings : null,
    newListings:   Number.isFinite(sale.newListings) ? sale.newListings : null,
    yoyPercent:    yoy ? yoy.percent : null,
    yoyComparedTo: yoy ? yoy.comparedTo : null,
    yoyMonthsBack: yoy ? yoy.monthsBack : null,
    temp:          marketTemp(dom),
    asOf:          sale.lastUpdatedDate || null,
  };
}

/** Fetch the given markets (all of them when `keys` is omitted) once each.
 *  Costs one paid request per market asked for. Returns what succeeded and the
 *  keys of what did not; never throws for a single failed zip. */
export async function fetchMarkets(apiKey, keys) {
  const wanted = keys ? MARKETS.filter(m => keys.includes(m.key)) : MARKETS;
  const settled = await Promise.allSettled(wanted.map(m => fetchMarket(m, apiKey)));
  const markets = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') markets.push(r.value);
    else failed.push({ key: wanted[i].key, reason: String(r.reason?.message || r.reason) });
  });
  return { markets, failed };
}

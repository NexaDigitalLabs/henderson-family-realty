// GET /api/rates
// Live mortgage + market rates from FRED (Federal Reserve Bank of St. Louis).
//
// Why FRED: it is free, authoritative, citable, and generously rate-limited
// (120 req/min). MORTGAGE30US / MORTGAGE15US are Freddie Mac's Primary Mortgage
// Market Survey — the actual industry benchmark, published every Thursday.
//
// One FRED key replaces the old client-side Alpha Vantage key entirely
// (that key was public, capped at 25 calls/day, and polled every 5 minutes —
// a single visitor exhausted the quota for everyone).
//
// NOTE ON 5/1 ARM: Freddie Mac discontinued the 5/1 ARM series (MORTGAGE5US) in
// November 2022. There is no free authoritative feed for it, so we do not
// publish one — the site shows a payment calculator driven by the live 30-year
// rate instead. Never invent a rate on a licensed agent's site.

import { json, fetchJson, methodGuard } from './_lib.js';

const FRED = 'https://api.stlouisfed.org/fred/series/observations';

const SERIES = {
  rate30: 'MORTGAGE30US', // 30-Yr Fixed Rate Mortgage Average (Freddie Mac PMMS, weekly)
  rate15: 'MORTGAGE15US', // 15-Yr Fixed Rate Mortgage Average (Freddie Mac PMMS, weekly)
  sp500:  'SP500',        // S&P 500 index close (daily, trading days only)
  us10y:  'DGS10',        // 10-Yr Treasury constant maturity — drives mortgage pricing
};

/** Pull the most recent valid observations for a series.
 *  FRED emits "." for holidays and non-reporting days, so filter those out. */
async function series(id, key) {
  const url = `${FRED}?series_id=${id}&api_key=${key}&file_type=json`
            + `&sort_order=desc&limit=12`;
  const data = await fetchJson(url);
  const points = (data.observations || [])
    .filter(o => o.value && o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .filter(o => Number.isFinite(o.value));

  if (!points.length) return null;

  const [latest, prior] = points;
  return {
    value: latest.value,
    date: latest.date,
    // Absolute change for rates (percentage points), percent change for indices.
    change: prior ? +(latest.value - prior.value).toFixed(3) : null,
    changePct: prior && prior.value !== 0
      ? +(((latest.value - prior.value) / prior.value) * 100).toFixed(2)
      : null,
    priorDate: prior ? prior.date : null,
  };
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, 'GET')) return;

  const key = process.env.FRED_API_KEY;
  if (!key) {
    // Degrade honestly rather than shipping stale numbers dressed up as live.
    return json(res, {
      available: false,
      error: 'FRED_API_KEY is not configured. See SETUP.md.',
    }, { sMaxAge: 60, swr: 60 });
  }

  try {
    const entries = Object.entries(SERIES);
    const results = await Promise.allSettled(
      entries.map(([, id]) => series(id, key))
    );

    const out = {};
    results.forEach((r, i) => {
      const name = entries[i][0];
      out[name] = r.status === 'fulfilled' ? r.value : null;
    });

    // If every series failed, treat it as an outage instead of a partial success.
    if (Object.values(out).every(v => v === null)) {
      throw new Error('All FRED series failed');
    }

    return json(res, {
      available: true,
      source: 'Freddie Mac PMMS / S&P Dow Jones / U.S. Treasury, via FRED',
      sourceUrl: 'https://fred.stlouisfed.org/',
      fetchedAt: new Date().toISOString(),
      ...out,
    }, {
      // PMMS updates weekly, SP500/DGS10 daily. 6h edge cache is plenty fresh
      // and keeps origin calls to ~4/day.
      sMaxAge: 21600,
      swr: 172800,
    });
  } catch (err) {
    return json(res, {
      available: false,
      error: 'Upstream rate data temporarily unavailable.',
      detail: String(err.message || err),
    }, { sMaxAge: 120, swr: 600 });
  }
}

// GET /api/market-refresh — the monthly market pull. Called by Vercel Cron only.
//
// WHY THIS EXISTS — READ BEFORE MOVING A RENTCAST CALL BACK INTO A PAGE REQUEST:
// Until 2026-09-16 /api/market called RentCast itself, six paid requests per
// refresh, and relied on a 4-day edge cache to keep that near 45 a month. It made
// 301 in the month to Sep 11 and ran up an overage bill. Vercel's CDN cache is
// segmented by region and best-effort — a response requested about once a day
// "may be evicted" — and every deployment empties it. A cache header can never
// cap a paid API. So the site now pulls on a clock, stores the result, and every
// visit reads the stored copy.
//
// The schedule in vercel.json runs this daily; the rules in _market-refresh.js
// make it pull only on the first successful run of each calendar month.
//
// Needs, in Vercel → Settings → Environment Variables (Production):
//   CRON_SECRET          — Vercel sends it as "Authorization: Bearer …"
//   RENTCAST_API_KEY     — used here and nowhere else
//   BLOB_READ_WRITE_TOKEN — added by Vercel when the Blob store is connected
// Run it by hand with:  vercel crons run /api/market-refresh

import { timingSafeEqual } from 'node:crypto';
import { SOURCE, MARKETS, fetchMarkets } from './_market-source.js';
import * as store from './_market-store.js';
import { refreshMarkets } from './_market-refresh.js';

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  // No secret configured means nobody is authorized — never an open endpoint
  // that spends money for whoever finds it.
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });

  try {
    const { status, body } = await refreshMarkets({
      now: new Date(),
      store,
      fetchMarkets,
      apiKey: process.env.RENTCAST_API_KEY,
      source: SOURCE,
      marketKeys: MARKETS.map(m => m.key),
    });
    console.log('market refresh', JSON.stringify(body));
    return send(res, status, body);
  } catch (err) {
    console.error('market refresh failed', err);
    return send(res, 500, { refreshed: false, reason: String(err?.message || err) });
  }
}

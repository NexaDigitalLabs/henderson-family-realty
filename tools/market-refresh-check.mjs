// Proves the monthly market pull's rules without spending a RentCast request:
// drives api/_market-refresh.js against an in-memory store and a stand-in
// RentCast that counts what would have been paid for. No network, no keys.
//
//   node tools/market-refresh-check.mjs            # expect 13/13
//   node tools/market-refresh-check.mjs --broken   # claims never refuse: the
//                                                  # duplicate scenario must go red
//
// Run it after any change to _market-refresh.js — and when the MLS source
// replaces RentCast. Every guard here was shown red with the guard removed
// (2026-09-16); a check that has never failed proves nothing.
import { fileURLToPath, pathToFileURL } from 'node:url';

const modPath = process.argv.slice(2).find(a => !a.startsWith('--'))
  ?? fileURLToPath(new URL('../api/_market-refresh.js', import.meta.url));
const broken = process.argv.includes('--broken');
const { refreshMarkets, MAX_ATTEMPTS, displayableMarkets } = await import(pathToFileURL(modPath).href);

const KEYS = ['temecula', 'murrieta', 'menifee', 'wildomar', 'lakeelsinore', 'winchester'];
const HOUR = 3600e3;

function makeStore() {
  const files = new Map(); // path -> { body, at }
  let clock = 0;
  const tick = () => new Promise(r => setTimeout(r, 1)); // force interleaving
  return {
    files,
    setClock: t => { clock = t; },
    async readLatest() { await tick(); const f = files.get('latest'); return f ? JSON.parse(f.body) : null; },
    async writeLatest(d) { await tick(); files.set('latest', { body: JSON.stringify(d), at: clock }); },
    async claimAge(month, n, now) { await tick(); const f = files.get(`claim:${month}-${n}`); return f ? now - f.at : null; },
    async createClaim(month, n, info) {
      await tick();
      const p = `claim:${month}-${n}`;
      if (files.has(p) && !broken) return false;
      files.set(p, { body: JSON.stringify(info), at: clock });
      return true;
    },
  };
}

function makeRentCast(plan) {
  // plan: 'ok' | 'fail' | array of keys that fail
  const rc = { requests: 0, mode: plan };
  rc.fetchMarkets = async (apiKey, keys = KEYS) => {
    await new Promise(r => setTimeout(r, 5));
    rc.asked = keys;
    rc.requests += keys.length; // one paid request per market asked for, success or not
    if (rc.mode === 'fail') throw new Error('RentCast is down');
    const failing = Array.isArray(rc.mode) ? rc.mode : [];
    return {
      markets: keys.filter(k => !failing.includes(k)).map(k => ({ key: k, medianPrice: 700000, asOf: 'now' })),
      failed: keys.filter(k => failing.includes(k)).map(k => ({ key: k, reason: '500' })),
    };
  };
  return rc;
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); }

async function run(store, rc, date, apiKey = 'k') {
  const now = new Date(date);
  store.setClock(now.getTime());
  return refreshMarkets({ now, store, fetchMarkets: rc.fetchMarkets, apiKey, source: { name: 'RentCast' }, marketKeys: KEYS });
}

// 1. First run of a month pulls once and stores it.
{
  const s = makeStore(), rc = makeRentCast('ok');
  const r = await run(s, rc, '2026-09-16T17:00:00Z');
  check('first run pulls and stores', r.body.refreshed === true && rc.requests === 6 && JSON.parse(s.files.get('latest').body).month === '2026-09', `requests=${rc.requests}`);
  // 2. Every later run that month costs nothing.
  for (const d of ['2026-09-17T15:00:00Z', '2026-09-30T15:00:00Z']) await run(s, rc, d);
  check('later runs in the same month spend nothing', rc.requests === 6, `requests=${rc.requests}`);
  // 3. The next month pulls again, once.
  await run(s, rc, '2026-10-01T15:10:00Z');
  await run(s, rc, '2026-10-02T15:10:00Z');
  check('next month pulls exactly once', rc.requests === 12, `requests=${rc.requests}`);
}

// 4. The same run delivered twice at once pulls once.
{
  const s = makeStore(), rc = makeRentCast('ok');
  const now = '2026-10-01T15:00:00Z';
  await Promise.all([run(s, rc, now), run(s, rc, now), run(s, rc, now)]);
  check('three simultaneous deliveries pull once', rc.requests === 6, `requests=${rc.requests}`);
}

// 5. A missing key spends nothing and uses up no attempt.
{
  const s = makeStore(), rc = makeRentCast('ok');
  const r = await run(s, rc, '2026-10-01T15:00:00Z', '');
  const claims = [...s.files.keys()].filter(k => k.startsWith('claim:')).length;
  check('missing key: 503, no request, no claim', r.status === 503 && rc.requests === 0 && claims === 0, `status=${r.status} requests=${rc.requests} claims=${claims}`);
}

// 6. RentCast down: retried next day, never the same day, capped at MAX_ATTEMPTS.
{
  const s = makeStore(), rc = makeRentCast('fail');
  const base = Date.parse('2026-10-01T15:00:00Z');
  await run(s, rc, new Date(base).toISOString());
  await run(s, rc, new Date(base + 2 * HOUR).toISOString()); // same day
  check('failed pull is not retried the same day', rc.requests === 6, `requests=${rc.requests}`);
  for (let day = 1; day <= 10; day++) await run(s, rc, new Date(base + day * 24 * HOUR).toISOString());
  check(`failures stop after ${MAX_ATTEMPTS} attempts (≤ ${MAX_ATTEMPTS * 6} requests)`, rc.requests === MAX_ATTEMPTS * 6, `requests=${rc.requests}`);
  check('nothing stored when every market failed', !s.files.has('latest'), '');
}

// 7. A market that fails keeps last month's figures.
{
  const s = makeStore(), rc = makeRentCast('ok');
  await run(s, rc, '2026-09-16T17:00:00Z');
  rc.mode = ['menifee'];
  const r = await run(s, rc, '2026-10-01T15:00:00Z');
  const stored = JSON.parse(s.files.get('latest').body);
  const keys = stored.markets.map(m => m.key);
  check('a failed market is carried over, in page order', r.body.refreshed && keys.join() === KEYS.join() && stored.carriedOver.join() === 'menifee', keys.join());
}

// 8. A partial pull is finished the next day by asking only for what failed.
{
  const s = makeStore(), rc = makeRentCast(['menifee', 'wildomar']);
  const base = Date.parse('2026-10-01T15:00:00Z');
  await run(s, rc, new Date(base).toISOString());               // 6 asked, 2 fail
  rc.mode = 'ok';
  await run(s, rc, new Date(base + 2 * HOUR).toISOString());    // same day: nothing
  const r = await run(s, rc, new Date(base + 24 * HOUR).toISOString()); // retry
  const stored = JSON.parse(s.files.get('latest').body);
  check('retry asks only for the failed markets', rc.requests === 8 && rc.asked.join() === 'menifee,wildomar' && r.body.refreshed, `requests=${rc.requests} asked=${rc.asked}`);
  await run(s, rc, new Date(base + 48 * HOUR).toISOString());
  check('month complete after the retry; next run spends nothing', rc.requests === 8 && stored.carriedOver.length === 0 && stored.markets.length === 6, `requests=${rc.requests} carried=${stored.carriedOver}`);
}

// 9. A figure older than last month is never carried: it drops off the page.
{
  const s = makeStore(), rc = makeRentCast('ok');
  await run(s, rc, '2026-07-15T15:00:00Z');          // July pull
  rc.mode = ['menifee'];
  await run(s, rc, '2026-09-01T15:00:00Z');          // August missed entirely
  const stored = JSON.parse(s.files.get('latest').body);
  const keys = stored.markets.map(m => m.key);
  check('a two-month-old figure is dropped, not shown as current', !keys.includes('menifee') && keys.length === 5 && stored.carriedOver.join() === 'menifee', keys.join());
}

// 10. The page shows nothing older than last month, even when every pull fails.
{
  const s = makeStore(), rc = makeRentCast('ok');
  await run(s, rc, '2026-10-01T15:00:00Z');                  // October stored
  rc.mode = 'fail';
  for (let d = 1; d <= 45; d++) await run(s, rc, new Date(Date.parse('2026-11-01T15:00:00Z') + d * 24 * HOUR).toISOString());
  const stored = JSON.parse(s.files.get('latest').body).markets;
  const inNov = displayableMarkets(stored, new Date('2026-11-20T12:00:00Z')).length;
  const inDec = displayableMarkets(stored, new Date('2026-12-02T12:00:00Z')).length;
  check('October figures show through November, not in December', inNov === 6 && inDec === 0, `nov=${inNov} dec=${inDec} requests=${rc.requests}`);
}

let failed = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`); if (!r.ok) failed++; }
console.log(`${results.length - failed}/${results.length}${broken ? '  [broken store]' : ''}`);
process.exit(failed ? 1 : 0);

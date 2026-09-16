// The once-a-month rules, kept apart from the HTTP handler so they can be run
// against a stand-in store and a stand-in RentCast without spending anything.

import { randomUUID } from 'node:crypto';

/** Attempts allowed in one calendar month, and the wait before a retry. The
 *  job runs daily, so a failed pull is retried the next day, at most twice more:
 *  the worst month costs 3 × 6 = 18 requests, the normal month 6. A retry asks
 *  only for the markets that failed, so it usually costs less. */
export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 20 * 60 * 60 * 1000;

export const monthKey = date => date.toISOString().slice(0, 7);

const previousMonthKey = date =>
  monthKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));

/** The markets fit to show at `now`: pulled this month or last, never older.
 *  Enforced where the page reads, not only where the job writes — a month in
 *  which every pull fails writes nothing, and without this the page would go on
 *  presenting the last stored figures as current for as long as RentCast stays
 *  down. */
export function displayableMarkets(markets, now) {
  const recent = new Set([monthKey(now), previousMonthKey(now)]);
  return (markets ?? []).filter(m => recent.has(m.pulledMonth));
}

/**
 * Pull the market figures that this month does not have yet.
 *
 * Vercel's cron delivery is best effort: a run can be missed, and the same run
 * can arrive twice. So nothing here trusts the schedule —
 *   - a month whose every market is stored is left alone (duplicates cost nothing);
 *   - a pull starts only after creating that attempt's claim, which a second
 *     copy of the run cannot also create;
 *   - an attempt claimed in the last 20 hours is still running or just failed,
 *     and is not repeated today;
 *   - a retry asks only for the markets that failed;
 *   - after MAX_ATTEMPTS the month is given up on.
 *
 * A market that fails keeps last month's figures for one month and no longer.
 * The page prints one "as of" date — the newest — so an older figure left in
 * place indefinitely would read as current. Past a month, the card falls back
 * to its reference estimate, which the page labels as such.
 */
export async function refreshMarkets({ now, store, fetchMarkets, apiKey, source, marketKeys }) {
  const month = monthKey(now);
  const latest = await store.readLatest({ fresh: true });
  const thisMonth = latest?.month === month;

  const pending = thisMonth ? (latest.carriedOver ?? []) : marketKeys;
  if (!pending.length) {
    return { status: 200, body: { refreshed: false, month, reason: 'This month is already stored.' } };
  }

  // Before claiming, so a missing key does not use up an attempt.
  if (!apiKey) {
    return { status: 503, body: { refreshed: false, month, reason: 'RENTCAST_API_KEY is not configured.' } };
  }

  let attempt = null;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const age = await store.claimAge(month, n, now.getTime());
    if (age === null) {
      const claim = { runId: randomUUID(), startedAt: now.toISOString(), pending };
      if (!(await store.createClaim(month, n, claim))) {
        return { status: 200, body: { refreshed: false, month, reason: `Attempt ${n} was claimed by another run.` } };
      }
      attempt = n;
      break;
    }
    if (age < RETRY_AFTER_MS) {
      return { status: 200, body: { refreshed: false, month, reason: `Attempt ${n} started less than 20 hours ago.` } };
    }
  }
  if (attempt === null) {
    return { status: 200, body: { refreshed: false, month, reason: `All ${MAX_ATTEMPTS} attempts for ${month} are used.` } };
  }

  let fetched;
  try {
    fetched = await fetchMarkets(apiKey, pending);
  } catch (err) {
    return { status: 502, body: { refreshed: false, month, attempt, reason: String(err?.message || err) } };
  }

  if (!fetched.markets.length) {
    return { status: 502, body: { refreshed: false, month, attempt, reason: 'Every market asked for failed.', failed: fetched.failed } };
  }

  const fresh = new Map(fetched.markets.map(m => [m.key, { ...m, pulledMonth: month }]));
  const keepable = new Set([month, previousMonthKey(now)]);
  const markets = [];
  const carriedOver = [];
  for (const key of marketKeys) {
    if (fresh.has(key)) { markets.push(fresh.get(key)); continue; }
    const prior = latest?.markets?.find(m => m.key === key);
    const stillPending = pending.includes(key);
    if (prior && keepable.has(prior.pulledMonth)) {
      markets.push(prior);
      if (stillPending) carriedOver.push(key);
    } else if (stillPending) {
      carriedOver.push(key); // nothing recent enough to show; retried next day
    }
  }

  await store.writeLatest({ month, fetchedAt: now.toISOString(), source, markets, carriedOver });

  return {
    status: 200,
    body: {
      refreshed: true, month, attempt,
      asked: pending.length,
      fetched: fetched.markets.length,
      carriedOver,
      failed: fetched.failed,
    },
  };
}

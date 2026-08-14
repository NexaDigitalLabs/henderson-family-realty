// Shared helpers for the Henderson Family Realty API functions.

/** Standard JSON response with CDN caching.
 *  sMaxAge   — seconds Vercel's edge cache serves this before revalidating.
 *  swr       — seconds it may keep serving a stale copy while refreshing behind the scenes.
 *  Caching at the edge is what keeps us inside the upstream providers' rate limits:
 *  thousands of visitors collapse into a single origin request per window. */
export function json(res, body, { sMaxAge = 3600, swr = 86400, status = 200 } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`);
  res.status(status).send(JSON.stringify(body));
}

/** fetch() with a hard timeout so a hanging upstream can't pin the function open. */
export async function fetchJson(url, { timeoutMs = 8000, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${new URL(url).host}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Reject anything that isn't the expected HTTP verb. */
export function methodGuard(req, res, method) {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  json(res, { error: 'Method not allowed' }, { sMaxAge: 0, swr: 0, status: 405 });
  return false;
}

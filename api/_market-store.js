// The stored copy of the market figures, in Vercel Blob (a private store).
//
// Two kinds of file:
//   market/latest.json            — what the site shows; overwritten by each pull
//   market/claims/YYYY-MM-N.json  — one per pull attempt in a month; never
//                                   overwritten, which is what makes it a lock
//
// The SDK reads BLOB_READ_WRITE_TOKEN, which Vercel adds to the project when the
// store is connected to it.

import { BlobNotFoundError, get, head, put } from '@vercel/blob';

const LATEST = 'market/latest.json';
const claimPath = (month, n) => `market/claims/${month}-${n}.json`;

export async function readLatest({ fresh = false } = {}) {
  // `fresh` skips Blob's own CDN copy: the monthly job must see the file as it
  // is, not as it was up to an hour ago.
  const result = await get(LATEST, { access: 'private', useCache: !fresh });
  if (!result || result.statusCode !== 200) return null;
  return JSON.parse(await new Response(result.stream).text());
}

export async function writeLatest(data) {
  await put(LATEST, JSON.stringify(data), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 3600,
  });
}

/** How long ago attempt N of this month was claimed, in ms — or null if never. */
export async function claimAge(month, n, now = Date.now()) {
  try {
    const meta = await head(claimPath(month, n));
    return now - new Date(meta.uploadedAt).getTime();
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

/** Create attempt N's claim. True if this call created it, false if another run
 *  did — `allowOverwrite: false` makes the create refuse an existing file. */
export async function createClaim(month, n, info) {
  try {
    await put(claimPath(month, n), JSON.stringify(info), {
      access: 'private',
      allowOverwrite: false,
      contentType: 'application/json',
    });
    return true;
  } catch (err) {
    // The SDK's error for "already exists" is not a class of its own, so read
    // the claim back. If its runId is ours, our write landed and only the reply
    // was lost — the SDK's retry is what was refused — so the claim is ours.
    const existing = await get(claimPath(month, n), { access: 'private', useCache: false });
    if (!existing || existing.statusCode !== 200) throw err;
    const body = JSON.parse(await new Response(existing.stream).text());
    return body.runId === info.runId;
  }
}

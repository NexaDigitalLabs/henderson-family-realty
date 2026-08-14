# Henderson Family Realty — Setup

Everything below is required to get the site fully live. Items marked
**REQUIRED** will visibly degrade the site if skipped (gracefully — nothing
breaks, but features stay dark).

---

## 1. Environment variables (Vercel)

Add these in **Vercel → Project → Settings → Environment Variables**, for the
Production, Preview, and Development environments.

| Variable | Required | Where to get it | What breaks without it |
|---|---|---|---|
| `RESEND_API_KEY` | **REQUIRED** | [resend.com](https://resend.com) → API Keys | Contact form returns an error telling people to call instead |
| `LEAD_TO_EMAIL` | optional | Your inbox | Defaults to `adam@hfr.homes` |
| `LEAD_FROM_EMAIL` | optional | Must be on a Resend-verified domain | Defaults to `Henderson Family Realty <website@nexadigitallabs.ai>` |
| `FRED_API_KEY` | **REQUIRED** | [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html) — free, instant | Mortgage rate cards show "Unavailable" |
| `RENTCAST_API_KEY` | **REQUIRED** | [rentcast.io](https://www.rentcast.io/api) — free tier | Home value cards keep their fallback numbers and say so |

### Sending domain — decided, not a to-do

Resend verifies **domains**, not individual addresses. Once a domain is verified,
every address on it can send with no further setup.

`hfr.homes` is **deliberately not verified**: adding a second domain costs
**$20/month** on the current Resend plan, and that was judged not worth it yet
(decision made 2026-08-11). So the contact form sends from the already-verified
**`nexadigitallabs.ai`** instead — this is the code default, no env var needed.

The tradeoff is purely cosmetic. Leads land in Adam's inbox, not a client's, and
`reply_to` is set to the lead's own address — so hitting reply reaches the right
person regardless of which domain sent the message.

If you later decide the $20/mo is worth a branded sender: Resend → Domains →
Add Domain → `hfr.homes`, add the MX + SPF + DKIM records at your registrar, then
set `LEAD_FROM_EMAIL=Henderson Family Realty <website@hfr.homes>`.

### Rotate the old Alpha Vantage key

The previous build had this key hardcoded in public JavaScript:
`SZMNQYDTGKAL3CSQ`. It has been removed from the codebase, but it was publicly
visible for as long as the site was live. **Revoke it at alphavantage.co.**
Nothing uses Alpha Vantage anymore — FRED replaced it.

---

## 2. Hero background video **REQUIRED**

The old hero was a YouTube iframe. YouTube always begins adaptive streaming at
a low rendition (~144–360p) and steps up over several seconds — and that
low-res frame was being stretched to cover the viewport. That was the blur.

Five files. Two encode tiers, because **the video plays on phones too** — they
just get a lighter 720p cut. The tier is chosen in JS at load time.

```
video/hero.webm          ~2-4 MB    1080p, desktop
video/hero.mp4           ~4-6 MB    1080p, desktop (Safari)
video/hero-mobile.webm   ~0.8-1.5 MB  720p, phones
video/hero-mobile.mp4    ~1-2 MB      720p, phones (Safari)
images/hero-poster.webp  ~60 KB     placeholder committed; replace it
```

Only two cases stay poster-only, and both are explicit user requests:
`Save-Data` (metered connection) and `prefers-reduced-motion`.

### Target size: 3–8 MB total. Not 48 MB, and not 128 MB.

Two reasons a big file is the wrong instinct here:

1. **The video is heavily darkened.** The overlay on top of it runs
   `rgba(8,10,15,0.82)` → `0.55`. Compression artifacts are invisible under
   that, so you can encode far more aggressively than seems reasonable.
2. **Load time.** A 48 MB hero is several seconds of blank or frozen poster on
   any connection that isn't fast home wifi — which is most of the mobile
   traffic a local realty site gets. Small file = the video is simply *there*.

> Bandwidth is **not** the constraint here: this team is on Vercel **Pro**
> (1 TB/month included), not Hobby (100 GB). An earlier version of this doc
> warned about exhausting a 100 GB cap — that was wrong for this account. The
> size guidance stands, but the reason is the visitor's experience, not the bill.

The poster is what actually eliminates the blur — it paints instantly at full
sharpness while the video loads behind it.

### Converting camera footage to MP4 first

If your source is a `.MOV`, `.MTS`, or anything else that isn't already MP4,
convert it with the local wrapper rather than an online service — browser
converters cap free uploads well below the size of raw footage, and there is
no reason to upload gigabytes to a stranger to do work your own machine does
in minutes:

```powershell
tools\Convert-Video.ps1 _source\GX010042.MOV
tools\Convert-Video.ps1 _source\GX010042.MOV -MaxWidth 1920 -Fast   # big files
tools\Convert-Video.ps1 _source\clip.MOV -Start 00:02:15 -Duration 15
```

`-Fast` uses this machine's Intel Quick Sync hardware encoder — several times
quicker, slightly larger output for the same quality. `Get-Help` on the script
lists every option. It lives in `tools/`, which `.vercelignore` excludes, so it
never ships to the site.

### Encode commands

**The short version:** `tools\Build-HeroVideo.ps1` produces all five assets
straight from the raw `.MOV`. You only decide where the loop starts.

```powershell
tools\Build-HeroVideo.ps1 "_source\Branded Video.mov" -Start 99 -Duration 12 -Seamless
```

That is the command that produced what is currently live.

**`-Seamless` is not optional for moving footage.** A drone or handheld camera
is never back where it started, so a straight cut from the last frame to the
first always jumps. `-Seamless` grabs an extra `-Crossfade` seconds and
dissolves the tail back over the head, making the loop point a repeat of one
frame. Measured on this footage, it took the visible discontinuity at the seam
from 54.4 down to 11.9 — against 11.0 for two ordinary adjacent frames. In
other words, the restart became indistinguishable from normal playback.

**Sizing is a budget, not a quality dial.** `-TargetMB` (default 3.5) drives a
two-pass encode, so output lands within a few percent of the number you ask
for no matter how hard the footage is. CRF cannot do that — the same CRF gave
2.5 MB on a static test clip and 25 MB on this drone shot. The budget is **per
file**: a visitor gets the WebM (Chrome/Edge/Firefox) *or* the MP4 (Safari),
never both.

Default width is **1600, not 1920**, on purpose. At a fixed byte budget fewer
pixels each get more bits; at 3.5 MB this footage showed visible blocking at
1920 and none at 1600. The video is scaled to cover the viewport under a dark
overlay, so the nominal resolution drop is invisible.

The manual commands below are the older fixed-CRF recipe, kept for reference.
They are not what the script runs any more.

Cut a **10–15 second seamless loop** from your source first, then:

```bash
# ── DESKTOP: 1080p ───────────────────────────────────────────────
ffmpeg -i source.mp4 -t 15 -an -vf scale=1920:-2 \
  -pix_fmt yuv420p -c:v libvpx-vp9 -crf 33 -b:v 0 -row-mt 1 video/hero.webm

ffmpeg -i source.mp4 -t 15 -an -vf scale=1920:-2 \
  -c:v libx264 -crf 27 -preset slow -pix_fmt yuv420p \
  -movflags +faststart video/hero.mp4

# ── MOBILE: 720p, higher CRF (it's behind a dark overlay on a small screen) ──
ffmpeg -i source.mp4 -t 15 -an -vf scale=1280:-2 \
  -pix_fmt yuv420p -c:v libvpx-vp9 -crf 37 -b:v 0 -row-mt 1 video/hero-mobile.webm

ffmpeg -i source.mp4 -t 15 -an -vf scale=1280:-2 \
  -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p \
  -movflags +faststart video/hero-mobile.mp4

# ── POSTER: MUST be frame 1, so the handoff to playback is invisible ──
ffmpeg -i video/hero.mp4 -frames:v 1 -c:v libwebp -quality 82 images/hero-poster.webp
```

Check the output sizes. Over budget? Raise the CRF by 2 and re-run — higher CRF
means smaller file. `-an` strips audio, which the muted hero would never play.

`-movflags +faststart` on the MP4s matters: it moves the metadata index to the
front of the file so playback can begin while the rest is still downloading.
Without it Safari waits for the whole file.

**Why frame 1 for the poster:** the browser paints the poster through the same
element that later plays the video. If the poster is a different frame, you get
a visible jump at playback. Same frame = invisible handoff.

### Where the video does NOT load

Only two cases, and both are the user explicitly asking for less:
- Browsers reporting **`Save-Data`** (user is on a metered connection)
- Users with **"reduce motion"** enabled in their OS

In both, the poster shows and **no video file is requested at all** — verified.

**Phones DO get the video.** They load `hero-mobile.*` at 720p, roughly a third
the weight of the desktop file. An earlier version of this site skipped video on
mobile entirely, which meant most visitors never saw the thing the hero was built
around. If you want to go back to poster-only on phones, the check lives in
`initHeroVideo()` in `index.html`.

Note the browser fetches **only one file per tier** — it takes the first source
it can decode (WebM in Chrome/Firefox/Edge, MP4 in Safari) and never downloads
the other. The two formats cost nothing extra in bandwidth.

---

## 3. Social share image (recommended)

Create `images/og-cover.jpg` at **1200×630**. Every page references it for
Facebook/Instagram/LinkedIn/iMessage previews. Without it, shares render as a
blank grey box. A photo of Adam or a Temecula skyline with the logo works well.

```bash
ffmpeg -i your-photo.jpg -vf "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630" -q:v 3 images/og-cover.jpg
```

---

## 4. Domains — already correct, don't "fix" this

Two domains are in play and they do different jobs. This trips people up:

| Domain | Role | Status |
|---|---|---|
| **hendersonfamilyrealty.com** | The **website**. Aliased to the Vercel project; apex already 301s to `www`. | ✅ Working |
| **hfr.homes** | **Email only** — has Microsoft 365 MX records, so `adam@hfr.homes` is a real mailbox. The web root is a registrar parking page. | ✅ Intentional |

All canonical URLs, OG tags, `sitemap.xml`, `robots.txt`, and JSON-LD point at
`https://www.hendersonfamilyrealty.com`. All `mailto:` links and the schema
`email` field point at `adam@hfr.homes`. **Both are correct — do not "unify" them.**

An earlier draft of this site used `hfr.homes` for canonical URLs, which pointed
Google at a parked domain that serves none of the content. That is fixed; if you
ever see `https://hfr.homes` in an `href`, `canonical`, or `og:url`, it's a
regression.

---

## 5. After deploying

1. **Submit the sitemap** — Google Search Console → Sitemaps → `sitemap.xml`.
2. **Test the contact form for real.** Submit it and confirm the email arrives.
   This is the one thing that must not be assumed working.
3. **Validate structured data** at
   [search.google.com/test/rich-results](https://search.google.com/test/rich-results).
   The Buyer FAQ on `/buy` is eligible for FAQ rich results.
4. **Set up Google Business Profile** if it isn't already — for a local agent
   it drives more traffic than the website itself.

---

## 6. Data sources and their limits

### `/api/rates` — FRED (Federal Reserve Bank of St. Louis)
- `MORTGAGE30US`, `MORTGAGE15US` — Freddie Mac Primary Mortgage Market Survey,
  published weekly on Thursdays. This is the industry benchmark.
- `SP500`, `DGS10` — daily.
- Limit is 120 req/min; edge-cached 6 hours, so origin sees ~4 calls/day.

> **Note on the 5/1 ARM:** Freddie Mac discontinued that series in November
> 2022. There is no free authoritative feed for it, so the site no longer
> publishes one — the third card shows the 10-Year Treasury (which actually
> drives mortgage pricing) and a payment calculator sits below. Publishing an
> invented ARM rate on a licensed agent's site is not worth the exposure.

### `/api/market` — RentCast
**The free tier is 50 requests per month.** This endpoint spends 6 per refresh
(one per zip), and is edge-cached for **4 days** — about 45 requests/month,
just inside the limit.

`CACHE_SECONDS` in `api/market.js` is the dial. If you upgrade your RentCast
plan, lower it. **Do not lower it on the free tier** or the data will go dark
partway through each month.

Median prices don't move day to day, so a 4-day cache costs nothing in
accuracy. The response always carries the true upstream `asOf` date, and the
page prints it — the site never claims to be fresher than it is.

---

## 7. Known gaps / next steps

**The search bar still sends visitors to Zillow.** Every buyer who searches is
handed to whichever Zillow Premier Agent is paying for that zip — a direct
competitor. The fix is an **IDX feed from CRMLS** (~$50–100/mo via iHomefinder,
IDX Broker, or Realtyna). As a licensed agent you're entitled to one. That
would also replace RentCast with real MLS data and remove the rate-limit
constraint entirely. This is the highest-ROI remaining change.

**Nav and footer are duplicated across six files.** They have already drifted
once. If the page count grows, move to a static site generator (Astro or
Eleventy) so there's one nav to edit.

**Brokerage compliance.** A fair-housing and license disclosure block was added
to every footer. Confirm the exact wording and whether a physical brokerage
address is required with Coldwell Banker Associated Brokers Realty — their
requirements govern, not this file.

**Testimonials.** The "5★ Client Rated" credential has no reviews behind it on
the page. Real named testimonials would do more for conversion than any other
content addition, and `Review` schema could earn star ratings in search results.

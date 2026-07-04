# Tokubai — eBay Deal Scanner

Scan live eBay listings, read the market from current asking prices, and spot items priced below it — worth buying or flipping. Everything runs in your browser; your keys and data never touch anyone's server except eBay's (via your own proxy).

## Setup (about 5 minutes, all free)

### 1. Get eBay API keys
1. Create a developer account at [developer.ebay.com](https://developer.ebay.com) (free, instant for personal use).
2. Go to **Your Account → Application Keysets** and create a **Production** keyset (not Sandbox — Sandbox has no real listings).
3. You need two values:
   - **App ID (Client ID)** — looks like `YourApp-PRD-xxxxxxxxx-xxxxxxxx`
   - **Cert ID (Client Secret)** — looks like `PRD-xxxxxxxxxxxx-xxxx-...`

### 2. Deploy the CORS proxy
Browsers block direct calls to eBay's API, so Tokubai needs a tiny relay you own:

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan is plenty).
2. **Workers & Pages → Create → Worker** — give it any name, hit **Deploy**.
3. Click **Edit code**, delete the sample, paste in the entire contents of [`worker.js`](worker.js), hit **Deploy**.
4. Copy your worker's URL, e.g. `https://tokubai-proxy.yourname.workers.dev`.
   Opening it in a browser should show *"This is the Tokubai CORS proxy — it is working."*

### 3. Connect Tokubai
1. Open Tokubai → **Settings**.
2. Paste the Client ID, Client Secret, and your worker URL.
3. Click **Test connection** — you should see *"Connected ✓"*.

> **Serve the app over http(s), not `file://`.** Any static server works:
> `python -m http.server` or `npx serve` in this folder, or host it on GitHub Pages / Cloudflare Pages.

## Troubleshooting

| Message | Cause / fix |
|---|---|
| *Couldn't reach your proxy* | Proxy URL is wrong, or the worker isn't deployed. Open the worker URL directly — you should see the "it is working" message. |
| *eBay rejected the credentials (401)* | Client ID or Secret is wrong, or you used the **Sandbox** keyset. It must be **Production**. |
| *Token request failed (403)* | New keysets sometimes need you to accept the API license at developer.ebay.com first. |
| *Rate limit hit (429)* | The free tier allows ~5,000 calls/day. Wait, or reduce auto-refresh frequency. |
| Shipping shows "varies" everywhere | eBay didn't return shipping for your region — check the Marketplace setting matches where you live. |

## Features

- **Deal score** — each listing is scored against the market median built from comparable Buy It Now listings (auctions are excluded from the read because bids sit low until the end).
- **Profit estimate** — median resale minus your fee % and outbound shipping (set in Settings), minus the buy price.
- **Watchlist** — track listings, re-check all prices in parallel, see what moved, get **desktop notifications** on price drops, auto-refresh on a timer while the tab is open.
- **Deal alerts** — save any search with a target price (suggested from the market read); every refresh scans the *newest* listings for that query and pings you when something lists at or under your target. Manage alerts in the Watchlist tab.
- **Multi-query dashboard** — every deal alert renders as a live newest-first column on one screen; under-target rows are highlighted.
- **Auction sniping** — set a 🎯 target on any watched auction; the "ending soon" panel surfaces auctions closing within your window with bids still under target. Add items directly by item ID.
- **Profit calculator** — per listing: target resale price, final value fee, payment processing (% + fixed), promoted-listing %, and your shipping — live profit and ROI with a fee breakdown.
- **Sold comps (optional)** — with eBay's gated Marketplace Insights API enabled on your keyset, scores and badges switch from asking prices to real SOLD medians, plus a sell-through (moves fast/slow) read and side-by-side sold-comp compare. Settings → "Check sold-data access" probes your keyset; without access everything degrades to asking prices.
- **Filters** — min/max price, category, condition (incl. open box / refurbished / for parts), BIN/auction, item location (domestic-only), free-shipping-only, seller quality (min feedback % + volume), exclude-keywords, and a "hidden gems" toggle (short-titled listings that are often underpriced). Search supports `under $300` phrasing and eBay's `-word` exclusions. One-click reset; on phones the panel collapses behind a Filters button.
- **Dynamic refinements** — the same Brand/Model/Size/etc. chips as eBay's own left rail (powered by eBay's refinement engine), with live match counts; combine them freely on top of everything above. Sorts include eBay's native Best match alongside deal score, total cost, newest, ending soonest, and seller rating.
- **Hide listings & block sellers** — ✕ on any card removes junk from all future scans; "block" next to a seller name bans everything they list. Both undoable, both excluded from alert checks too.
- **Installable & offline** — install it as an app from the browser menu; the shell loads offline thanks to a service worker.
- **CSV export** — results and watchlist, with scores and profit columns.
- **Backup / restore** — everything lives in `localStorage`; export a JSON backup from Settings before clearing browser data.
- **Shareable searches** — the URL carries your query; bookmark it or send it.
- Theme toggle (auto / light / dark), `/` to focus search.

## Hosting the app (needed for phone push & install)

Web Push and installing Tokubai as an app both require **HTTPS** — a local `python -m http.server` works on your desktop (`localhost` is allowed), but your phone needs a real URL. The zero-effort option is GitHub Pages, since this repo is already on GitHub:

1. Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
   (Or from a terminal: `gh api repos/steven4team-cmd/Tokubai/pages -X POST -f "source[branch]=main" -f "source[path]=/"`)
2. After a minute the app is live at `https://steven4team-cmd.github.io/Tokubai/` — open it on your phone, install it (browser menu → *Add to Home Screen / Install app*), and enable push from Settings there.

Note: the page (like the repo) is public, but that's fine — your keys live only in each browser's localStorage and in your worker's secrets, never in the hosted files.

## 24/7 new-listing tracker (server-side)

The worker doubles as a background deal tracker: a Cloudflare **cron trigger** re-runs your saved searches every 2 minutes, compares each *newly listed* item against a rolling **median going rate** (fixed-price comps, your filters applied), and notifies you — app closed, laptop shut.

### One-time setup

1. **Redeploy** the latest [`worker.js`](worker.js) over your existing worker (the proxy behavior is unchanged).
2. **KV**: dash → Storage & Databases → KV → create a namespace (any name) → worker → Settings → Bindings → add binding, variable name **`TRACKER`**.
3. **Secrets** (worker → Settings → Variables & secrets): `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `ADMIN_TOKEN` (any long random string). Run `node webpush-keys.js` locally and add `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`; set `VAPID_SUBJECT` (e.g. `mailto:you@example.com`) as a plain variable. Optional: `NTFY_TOPIC` (a unique topic name) for phone alerts via the free [ntfy](https://ntfy.sh) app.
4. **Cron**: worker → Settings → Triggers → Cron Triggers → `*/2 * * * *`.
5. **In the app**: Settings → *24/7 server tracker* → paste the same admin token → **Sync alerts to server** → **Enable push here** → **Test notification**.

### How it works (and the budget math)

- Each alert you sync becomes a tracker: keyword + category/condition/price filters + exclude-words, with an **absolute ceiling** and/or a **% below going rate** threshold.
- Every cron tick: one `sort=newlyListed` search per tracker; genuinely-new items are detected via a `listingDate` watermark plus a small ring of recent item IDs. The going rate is the **median** total (price + shipping) of ~100 fixed-price comps, cached for 6 hours.
- Budget: ~720 polls/day per tracker + ~4 baseline calls, against eBay's ~5,000/day — the worker caps you at 8 trackers. KV is written **only when state changes**, staying inside the free tier's ~1,000 writes/day.
- **Data rule:** KV holds only tracker configs, bare item IDs, watermark timestamps, and median *numbers*. Listing content is fetched live each poll, used for the notification, and discarded. "Last poll" in Status only advances when state changes — use *Test notification* or the `/api/run` endpoint to verify liveness.
- Notifications are modular (`notify()` in worker.js): Web Push (VAPID/RFC 8291, works on desktop + Android; iOS needs the PWA installed) and ntfy.sh ship now; an email/SMS channel is a one-function add.

## Node client (server-side)

[`ebay-client.js`](ebay-client.js) is a zero-dependency Node 18+ module for calling the Browse API from scripts or a backend — same API, no browser and no proxy needed.

```bash
cp .env.example .env     # then fill in your keyset — .env is gitignored
node ebay-client.js "lego death star" 300
```

```js
import { searchItems } from "./ebay-client.js";
const { total, items } = await searchItems("gaming laptop", {
  minPrice: 200, maxPrice: 900, condition: "USED", sort: "newlyListed",
});
// items: [{ id, title, price: { value, currency }, condition, url, imageUrl }]
```

- OAuth client-credentials flow with the token cached and reused until ~5 minutes before its 2-hour expiry; concurrent callers share one token request, and a 401 triggers exactly one fresh-token retry.
- `EBAY_BASE_URL` in `.env` switches between production (`https://api.ebay.com`) and sandbox (`https://api.sandbox.ebay.com`).
- Credentials live only in `.env` (gitignored); `.env.example` has the placeholders.

## Privacy & data rule

Keys and data are stored in your browser's `localStorage` only. Calls go browser → your worker → eBay. The worker forwards only to `api.ebay.com` and stores nothing.

**eBay listing data is never persisted.** Watchlists, alerts, and saved searches store only your query text/filters, bare eBay item IDs, and prices you observed. Titles, images, sellers, and other listing content are re-fetched live on every view and held in memory only.

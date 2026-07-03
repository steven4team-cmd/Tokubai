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
- **Filters** — min/max price, category, condition, listing type; search supports `under $300` phrasing and eBay's `-word` exclusions (e.g. `iphone 13 -cracked -parts`).
- **Hide listings & block sellers** — ✕ on any card removes junk from all future scans; "block" next to a seller name bans everything they list. Both undoable, both excluded from alert checks too.
- **Installable & offline** — install it as an app from the browser menu; the shell loads offline thanks to a service worker.
- **CSV export** — results and watchlist, with scores and profit columns.
- **Backup / restore** — everything lives in `localStorage`; export a JSON backup from Settings before clearing browser data.
- **Shareable searches** — the URL carries your query; bookmark it or send it.
- Theme toggle (auto / light / dark), `/` to focus search.

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

## Privacy

Keys and data are stored in your browser's `localStorage` only. Calls go browser → your worker → eBay. The worker forwards only to `api.ebay.com` and stores nothing.

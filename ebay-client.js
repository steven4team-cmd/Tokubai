/* ============================================================
   Tokubai — server-side eBay Browse API client
   Node 18+, zero dependencies. Credentials come from .env
   (see .env.example) — never hardcoded, never committed.

   Usage as a module:
     import { searchItems, getAppToken } from "./ebay-client.js";
     const { total, items } = await searchItems("lego death star", { maxPrice: 300 });

   Usage from the terminal:
     node ebay-client.js "lego death star" 300
   ============================================================ */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ---------- tiny .env loader (no dotenv dependency) ---------- */
function loadEnv(file = ".env") {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(path.join(dir, file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      // real environment variables win over .env values
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = raw.replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* no .env file — rely on actual environment variables */ }
}
loadEnv();

const BASE_URL = (process.env.EBAY_BASE_URL || "https://api.ebay.com").replace(/\/+$/, "");
const MARKETPLACE = process.env.EBAY_MARKETPLACE || "EBAY_US";

function credentials() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET. Copy .env.example to .env and fill in your Production keyset."
    );
  }
  return { id, secret };
}

/* ============================================================
   OAuth client-credentials flow, with caching.
   Tokens last ~2h; we reuse until 5 minutes before expiry and
   share one in-flight request across concurrent callers.
   ============================================================ */
const EARLY_REFRESH_MS = 5 * 60 * 1000;
let cached = { token: null, exp: 0 };
let inFlight = null;

export async function getAppToken() {
  if (cached.token && Date.now() < cached.exp - EARLY_REFRESH_MS) return cached.token;
  if (!inFlight) inFlight = fetchToken().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchToken() {
  const { id, secret } = credentials();
  const res = await fetch(`${BASE_URL}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`eBay token request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 7200) * 1000 };
  return cached.token;
}

/* ============================================================
   searchItems(query, filters)
   filters (all optional):
     minPrice, maxPrice  — numbers; builds eBay's price:[lo..hi] filter
     currency            — priceCurrency for the range (default USD)
     condition           — "NEW" | "USED" | "UNSPECIFIED"
     limit               — results per page (default 50, max 200)
     offset              — for pagination
     sort                — e.g. "newlyListed", "price", "-price"
   Returns { total, items: [{ id, title, price, condition, url, imageUrl }] }
   ============================================================ */
export async function searchItems(query, filters = {}) {
  if (!query || !String(query).trim()) throw new Error("searchItems: query is required");

  const params = new URLSearchParams();
  params.set("q", String(query).trim());
  params.set("limit", String(filters.limit || 50));
  if (filters.offset) params.set("offset", String(filters.offset));
  if (filters.sort) params.set("sort", filters.sort);

  const f = [];
  const lo = filters.minPrice, hi = filters.maxPrice;
  if (lo != null && hi != null) f.push(`price:[${lo}..${hi}]`);
  else if (lo != null) f.push(`price:[${lo}]`);
  else if (hi != null) f.push(`price:[..${hi}]`);
  if (lo != null || hi != null) f.push(`priceCurrency:${filters.currency || "USD"}`);
  if (filters.condition) f.push(`conditions:{${filters.condition}}`);
  if (f.length) params.set("filter", f.join(","));

  const data = await browseGET(`/buy/browse/v1/item_summary/search?${params}`);
  return {
    total: data.total || 0,
    items: (data.itemSummaries || []).map(parseItem),
  };
}

function parseItem(it) {
  return {
    id: it.itemId,
    title: it.title || "",
    price: it.price ? { value: parseFloat(it.price.value), currency: it.price.currency } : null,
    condition: it.condition || null,
    url: it.itemWebUrl || null,
    imageUrl:
      (it.image && it.image.imageUrl) ||
      (it.thumbnailImages && it.thumbnailImages[0] && it.thumbnailImages[0].imageUrl) ||
      null,
  };
}

async function browseGET(pathname, retried) {
  const token = await getAppToken();
  const res = await fetch(BASE_URL + pathname, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
    },
  });
  if (res.status === 401 && !retried) {
    cached = { token: null, exp: 0 }; // token died early — fetch a fresh one, retry once
    return browseGET(pathname, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`eBay API error (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/* ---------- CLI: node ebay-client.js "search terms" [maxPrice] ---------- */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [query, maxPrice] = process.argv.slice(2);
  if (!query) {
    console.log('Usage: node ebay-client.js "search terms" [maxPrice]');
    process.exit(1);
  }
  try {
    const { total, items } = await searchItems(query, maxPrice ? { maxPrice: parseFloat(maxPrice) } : {});
    console.log(`${total.toLocaleString()} matches — showing ${items.length}:\n`);
    for (const it of items) {
      console.log(`- ${it.title}`);
      console.log(`  ${it.price ? `${it.price.value.toFixed(2)} ${it.price.currency}` : "no price"} · ${it.condition || "condition n/a"}`);
      console.log(`  ${it.url}\n`);
    }
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

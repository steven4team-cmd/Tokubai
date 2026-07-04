/* ============================================================
   Tokubai — app logic
   eBay Browse API via your CORS proxy · everything stored locally
   ============================================================ */
"use strict";

/* ---------- tiny helpers ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { storageBroken(); } };

// storage self-test — when localStorage is blocked or resetting, EVERYTHING
// looks broken (settings/watchlist/alerts vanish). Detect it and say so.
let storageOK = true;
try {
  localStorage.setItem("ff_probe", "1");
  storageOK = localStorage.getItem("ff_probe") === "1";
  localStorage.removeItem("ff_probe");
} catch { storageOK = false; }

let _storageWarned = false;
function storageBroken() {
  storageOK = false;
  if (_storageWarned) return;
  _storageWarned = true;
  showStatus("⚠ This browser is blocking local storage — settings, watchlist, and alerts CANNOT be saved. Common causes: private/incognito window, blocked cookies/site data, or opening the app as a file:// page. Fix that first; nothing will persist until you do.", "err");
}

const K = { settings: "ff_settings", token: "ff_token", watch: "ff_watch", recent: "ff_recent", hidden: "ff_hidden", theme: "ff_theme", notify: "ff_notify", auto: "ff_auto", alerts: "ff_alerts", sellers: "ff_sellers", snipe: "ff_snipe", insights: "ff_insights", wsort: "ff_wsort", view: "ff_view" };

const DEFAULTS = { clientId: "", clientSecret: "", proxy: "", market: "EBAY_US", feePct: 13.25, shipOut: 5, procPct: 2.9, procFixed: 0.3, promoPct: 0, adminToken: "" };
let settings = { ...DEFAULTS, ...lsGet(K.settings, {}) };

const money = (v, cur) => {
  if (v == null || isNaN(v)) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", maximumFractionDigits: 2 }).format(v); }
  catch { return "$" + Number(v).toFixed(2); }
};

/* ---------- state ---------- */
let results = [];            // normalized listings from the last scan
let market = null;           // { median, count, currency }
let lastQuery = null;        // { q, params } for Load more
let nextOffset = 0;
let totalAvail = 0;          // eBay's total match count for the last query
let isScanning = false;      // prevents concurrent scans
let pendingRefine = false;   // a filter changed mid-scan — re-run when done
// eBay's own refinement engine (Brand, Model, Size…) — session only
let aspects = [];            // latest aspect distributions for the current query
let dominantCat = null;      // category eBay says the query belongs to
let aspectSel = {};          // aspect name → Set of selected values
const PAGE = 60;
const FALLBACK_IMG = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="#eef1ee"/><path d="M42 48 56 34h14a5 5 0 0 1 5 5v14L61 67a4 4 0 0 1-5.6 0L42 53.6a4 4 0 0 1 0-5.6Z" fill="#c9cfca"/></svg>`);

/* DATA RULE: eBay listing content (titles, images, sellers, conditions, URLs,
   end times) is NEVER persisted — localStorage holds only query text, bare
   item IDs, and prices we ourselves observed. Live details stay in this
   session-only map and vanish when the tab closes. */
const liveInfo = new Map(); // itemId → freshly fetched listing details

function legacyIdOf(id) {
  const m = String(id).match(/^v1\|(\d+)\|/);
  return m ? m[1] : (/^\d+$/.test(String(id)) ? String(id) : null);
}
function itemUrlFromId(id) {
  const l = legacyIdOf(id);
  return l ? "https://www.ebay.com/itm/" + l : "#";
}
function stripWatchItem(w) {
  return {
    id: w.id, savedAt: w.savedAt, savedTotal: w.savedTotal,
    lastTotal: w.lastTotal != null ? w.lastTotal : w.total,
    checkedAt: w.checkedAt || null,
    ended: w.ended ? true : undefined,
    target: w.target,
    hist: Array.isArray(w.hist) ? w.hist : [],
  };
}

/* ============================================================
   SETTINGS
   ============================================================ */
function loadSettingsForm() {
  $("#sClientId").value = settings.clientId;
  $("#sClientSecret").value = settings.clientSecret;
  $("#sProxy").value = settings.proxy;
  $("#sMarket").value = settings.market;
  $("#sFee").value = settings.feePct;
  $("#sShipOut").value = settings.shipOut;
  $("#sProc").value = settings.procPct;
  $("#sProcFixed").value = settings.procFixed;
  $("#sPromo").value = settings.promoPct;
  $("#sAdminToken").value = settings.adminToken;
}
function readSettingsForm() {
  return {
    clientId: $("#sClientId").value.trim(),
    clientSecret: $("#sClientSecret").value.trim(),
    proxy: $("#sProxy").value.trim().replace(/\/+$/, ""),
    market: $("#sMarket").value,
    feePct: clamp(parseFloat($("#sFee").value) || 0, 0, 50),
    shipOut: Math.max(0, parseFloat($("#sShipOut").value) || 0),
    procPct: clamp(parseFloat($("#sProc").value) || 0, 0, 20),
    procFixed: Math.max(0, parseFloat($("#sProcFixed").value) || 0),
    promoPct: clamp(parseFloat($("#sPromo").value) || 0, 0, 30),
    adminToken: $("#sAdminToken").value.trim(),
  };
}
function settingsReady() { return !!(settings.clientId && settings.clientSecret && settings.proxy); }

function setInlineStatus(msg, cls) {
  const el = $("#settingsStatus");
  el.textContent = msg;
  el.className = "status-inline" + (cls ? " " + cls : "");
}

$("#saveSettings").addEventListener("click", () => {
  settings = readSettingsForm();
  lsSet(K.settings, settings);
  localStorage.removeItem(K.token); // credentials may have changed
  setInlineStatus(storageOK ? "Saved ✓" : "Saved for this session only — storage is blocked in this browser!", storageOK ? "ok" : "err");
  $("#setupNudge").hidden = settingsReady();
});

// auto-save as you type — a missed Save click should never lose your keys
let _settingsSaveT = null;
$$("#tab-settings input, #tab-settings select").forEach((el) => el.addEventListener("input", () => {
  clearTimeout(_settingsSaveT);
  _settingsSaveT = setTimeout(() => {
    const before = settings;
    settings = readSettingsForm();
    if (settings.clientId !== before.clientId || settings.clientSecret !== before.clientSecret) {
      localStorage.removeItem(K.token); // credentials changed — force a fresh token
    }
    lsSet(K.settings, settings);
    setInlineStatus("Auto-saved ✓", "ok");
    $("#setupNudge").hidden = settingsReady();
  }, 700);
}));

$("#testSettings").addEventListener("click", async () => {
  settings = readSettingsForm();
  lsSet(K.settings, settings);
  localStorage.removeItem(K.token);
  if (!settingsReady()) { setInlineStatus("Fill in Client ID, Secret, and proxy URL first.", "err"); return; }
  setInlineStatus("Testing — getting a token…");
  try {
    await getToken();
    setInlineStatus("Testing — running a 1-item search…");
    await ebayGET("/buy/browse/v1/item_summary/search?q=lego&limit=1");
    setInlineStatus("Connected ✓ — eBay answered. You're ready to scan.", "ok");
    $("#setupNudge").hidden = true;
  } catch (e) {
    setInlineStatus(friendlyError(e), "err");
  }
});

/* ============================================================
   EBAY API (through the user's CORS proxy)
   ============================================================ */
const proxied = (url) => `${settings.proxy}/?url=${encodeURIComponent(url)}`;

let tokenInFlight = null; // parallel requests share one token fetch instead of stampeding
async function getToken() {
  const cached = lsGet(K.token, null);
  if (cached && cached.exp > Date.now() + 5 * 60 * 1000) return cached.token;
  if (!tokenInFlight) tokenInFlight = fetchToken().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

async function fetchToken() {
  const res = await fetch(proxied("https://api.ebay.com/identity/v1/oauth2/token"), {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(settings.clientId + ":" + settings.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  }).catch(() => { throw new Error("PROXY_DOWN"); });

  if (res.status === 401 || res.status === 403) throw new Error("BAD_KEYS");
  if (!res.ok) throw new Error("TOKEN_" + res.status);
  const data = await res.json();
  lsSet(K.token, { token: data.access_token, exp: Date.now() + (data.expires_in || 7200) * 1000 });
  return data.access_token;
}

// short-lived response cache — flipping a filter back and forth, or re-running
// the same search, answers from memory instead of burning another API call
const apiCache = new Map(); // path → { t, data }
const API_CACHE_MS = 90 * 1000;

async function ebayGET(path, noCache) {
  if (!noCache) {
    const hit = apiCache.get(path);
    if (hit && Date.now() - hit.t < API_CACHE_MS) return hit.data;
  }
  const token = await getToken();
  const res = await fetch(proxied("https://api.ebay.com" + path), {
    headers: {
      "Authorization": "Bearer " + token,
      "X-EBAY-C-MARKETPLACE-ID": settings.market || "EBAY_US",
      // ship-to context — without it eBay omits shippingOptions and totals show "varies"
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=" + encodeURIComponent("country=" + marketCountry()),
    },
  }).catch(() => { throw new Error("PROXY_DOWN"); });
  if (res.status === 401) { localStorage.removeItem(K.token); throw new Error("BAD_KEYS"); }
  if (res.status === 429) throw new Error("RATE_LIMIT");
  if (!res.ok) throw new Error("API_" + res.status);
  const data = await res.json();
  if (!noCache) {
    apiCache.set(path, { t: Date.now(), data });
    if (apiCache.size > 60) apiCache.delete(apiCache.keys().next().value); // oldest out
  }
  return data;
}

function friendlyError(e) {
  const m = String(e && e.message || e);
  if (m === "PROXY_DOWN") return "Couldn't reach your proxy. Check the proxy URL in Settings and that the worker is deployed.";
  if (m === "BAD_KEYS") return "eBay rejected the credentials (401). Re-check Client ID and Client Secret — they must be the Production keyset.";
  if (m === "RATE_LIMIT") return "eBay rate limit hit (429). Wait a bit — the free tier allows ~5,000 calls per day.";
  if (m.startsWith("TOKEN_")) return "Token request failed (" + m.slice(6) + "). Verify the keyset is Production and the proxy forwards POST requests.";
  if (m.startsWith("API_")) return "eBay returned an error (" + m.slice(4) + "). Try a simpler search, or retry in a minute.";
  return "Something went wrong: " + m;
}

/* ============================================================
   QUERY PARSING + SEARCH
   ============================================================ */
function parseQuery(raw) {
  let q = raw.trim();
  let max = null;
  const m = q.match(/^(.*?)\s+(?:under|below|less than)\s*\$?\s*(\d+(?:\.\d+)?)\s*$/i);
  if (m) { q = m[1].trim(); max = parseFloat(m[2]); }
  return { q, max };
}

function buildSearchPath(q, offset) {
  const p = new URLSearchParams();
  const excl = $("#fExclude").value.trim();
  const exq = excl ? " " + excl.split(/[,\s]+/).filter(Boolean).map((w) => "-" + w).join(" ") : "";
  p.set("q", q + exq); // eBay supports -word exclusions natively
  p.set("limit", String(PAGE));
  p.set("offset", String(offset || 0));
  p.set("fieldgroups", "ASPECT_REFINEMENTS"); // ask for eBay's dynamic filter data

  // dynamic aspect refinements — eBay's left-rail filters, applied server-side
  const selNames = Object.keys(aspectSel).filter((n) => aspectSel[n] && aspectSel[n].size);
  if (dominantCat && selNames.length) {
    p.set("aspect_filter", `categoryId:${dominantCat},` +
      selNames.map((n) => `${n}:{${[...aspectSel[n]].join("|")}}`).join(","));
  }

  const cat = $("#fCat").value;
  if (cat) p.set("category_ids", cat);

  const filters = [];
  const fMin = parseFloat($("#fMin").value);
  const fMax = parseFloat($("#fMax").value);
  let lo = !isNaN(fMin) && fMin > 0 ? fMin : null;
  let hi = !isNaN(fMax) && fMax > 0 ? fMax : null;
  if (lo != null && hi != null && lo > hi) { const t = lo; lo = hi; hi = t; }
  if (lo != null && hi != null) filters.push(`price:[${lo}..${hi}]`);
  else if (lo != null) filters.push(`price:[${lo}]`);
  else if (hi != null) filters.push(`price:[..${hi}]`);
  if (lo != null || hi != null) filters.push(`priceCurrency:${marketCurrency()}`);
  const cond = $("#fCond").value;
  // numeric values are eBay condition IDs (1500 open box, 2000s refurb, 7000 parts)
  if (cond) filters.push(/^\d/.test(cond) ? `conditionIds:{${cond}}` : `conditions:{${cond}}`);
  const type = $("#fType").value;
  if (type) filters.push(`buyingOptions:{${type}}`);
  if ($("#fLoc").value === "domestic") filters.push(`itemLocationCountry:${marketCountry()}`);
  if ($("#fFreeShip").checked) filters.push("maxDeliveryCost:0");
  if (filters.length) p.set("filter", filters.join(","));

  if ($("#fSort").value === "newest") p.set("sort", "newlyListed");
  if ($("#fSort").value === "ending") p.set("sort", "endingSoonest");

  return "/buy/browse/v1/item_summary/search?" + p.toString();
}

function marketCurrency() {
  return { EBAY_US: "USD", EBAY_GB: "GBP", EBAY_CA: "CAD", EBAY_DE: "EUR", EBAY_AU: "AUD" }[settings.market] || "USD";
}
function marketCountry() {
  return { EBAY_US: "US", EBAY_GB: "GB", EBAY_CA: "CA", EBAY_DE: "DE", EBAY_AU: "AU" }[settings.market] || "US";
}

function normalize(it) {
  const bid = it.currentBidPrice ? parseFloat(it.currentBidPrice.value) : null;
  const ask = it.price ? parseFloat(it.price.value) : null;
  const price = bid != null ? bid : ask;
  const currency = (it.currentBidPrice || it.price || {}).currency || marketCurrency();

  let shipping = null, shippingKnown = false;
  const so = it.shippingOptions && it.shippingOptions[0];
  if (so && so.shippingCost && so.shippingCost.value != null) {
    shipping = parseFloat(so.shippingCost.value);
    shippingKnown = true;
  }
  const total = price != null ? price + (shippingKnown ? shipping : 0) : null;

  const isAuction = (it.buyingOptions || []).includes("AUCTION") && bid != null;
  return {
    id: it.itemId,
    title: it.title || "(untitled listing)",
    url: it.itemWebUrl || "#",
    img: (it.image && it.image.imageUrl) || (it.thumbnailImages && it.thumbnailImages[0] && it.thumbnailImages[0].imageUrl) || FALLBACK_IMG,
    price, shipping, shippingKnown, total, currency,
    condition: it.condition || "",
    isAuction,
    isBIN: (it.buyingOptions || []).includes("FIXED_PRICE"),
    endAt: it.itemEndDate ? Date.parse(it.itemEndDate) : null,
    listedAt: it.itemCreationDate ? Date.parse(it.itemCreationDate) : 0,
    seller: {
      name: (it.seller && it.seller.username) || "",
      pct: it.seller && it.seller.feedbackPercentage ? parseFloat(it.seller.feedbackPercentage) : null,
      n: (it.seller && it.seller.feedbackScore) || 0,
    },
  };
}

/* ============================================================
   SOLD COMPS — eBay Marketplace Insights (gated API)
   Access is probed, never assumed; everything degrades to live
   asking prices when the keyset isn't approved. Sold data lives
   in session memory only (data rule).
   ============================================================ */
let insightsOK = lsGet(K.insights, null); // null = never probed, true/false = probe verdict
let soldStats = null; // { median, count, soldTotal, samples } for the current scan

async function probeInsights() {
  try {
    await ebayGET("/buy/marketplace_insights/v1_beta/item_sales/search?q=test&limit=1", true);
    insightsOK = true;
  } catch (e) {
    const m = String(e && e.message || "");
    if (m === "API_403" || m === "API_404") insightsOK = false; // keyset not provisioned
    else throw e; // proxy/keys/network problem — no verdict
  }
  lsSet(K.insights, insightsOK);
  return insightsOK;
}

async function fetchSoldStats(q) {
  if (insightsOK !== true) return null;
  try {
    const p = new URLSearchParams({ q, limit: "100" });
    const data = await ebayGET("/buy/marketplace_insights/v1_beta/item_sales/search?" + p);
    const sales = data.itemSales || [];
    const prices = sales
      .map((s) => s.lastSoldPrice && parseFloat(s.lastSoldPrice.value))
      .filter((v) => v != null && !isNaN(v))
      .sort((a, b) => a - b);
    if (prices.length < 4) return null;
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    return { median, count: prices.length, soldTotal: data.total || prices.length, samples: sales.slice(0, 10) };
  } catch (e) {
    const m = String(e && e.message || "");
    if (m === "API_403") { insightsOK = false; lsSet(K.insights, false); } // access revoked
    return null;
  }
}

function openComps(id) {
  const x = results.find((r) => r.id === id);
  if (!x || !soldStats) return;
  $("#compsInfo").innerHTML =
    `<b>${esc(x.title.length > 70 ? x.title.slice(0, 70) + "…" : x.title)}</b><br>` +
    `Asking <b>${money(x.total, x.currency)}</b> vs sold median <b>${money(soldStats.median, x.currency)}</b> across ${soldStats.count} recent sales.`;
  $("#compsRows").innerHTML = soldStats.samples.map((s) => {
    const v = s.lastSoldPrice ? parseFloat(s.lastSoldPrice.value) : null;
    return `<div class="comps-row">
      <span class="comps-title">${esc(s.title || "")}</span>
      <span class="comps-price">${v != null ? money(v, s.lastSoldPrice.currency) : "—"}</span>
      <span class="comps-date">${s.lastSoldDate ? new Date(s.lastSoldDate).toLocaleDateString() : ""}</span>
    </div>`;
  }).join("") || `<div class="dim">No individual comps returned for this query.</div>`;
  $("#compsDlg").showModal();
}

$("#checkInsights").addEventListener("click", async () => {
  const el = $("#insightsStatus");
  const put = (msg, cls) => { el.textContent = msg; el.className = "status-inline" + (cls ? " " + cls : ""); };
  settings = readSettingsForm();
  lsSet(K.settings, settings);
  if (!settingsReady()) { put("Fill in the eBay API settings above first.", "err"); return; }
  put("Probing Marketplace Insights…");
  try {
    const ok = await probeInsights();
    put(ok
      ? "Access confirmed ✓ — deal scores and badges now use real SOLD prices."
      : "Not enabled on this keyset. Marketplace Insights is limited-release: apply at developer.ebay.com → Application Growth Check (or contact eBay Developer Support) and request the Marketplace Insights API for pricing research. Until then the app scores against live asking prices.",
      ok ? "ok" : "err");
  } catch (e) {
    put(friendlyError(e), "err");
  }
});

/* ============================================================
   MARKET READ + DEAL SCORE
   ============================================================ */
function computeMarket(list) {
  // auctions sit artificially low until the final hours — read the market
  // from Buy It Now listings when there are enough of them
  const priced = list.filter((x) => x.total != null);
  const bin = priced.filter((x) => !x.isAuction);
  const pool = bin.length >= 6 ? bin : priced;

  // mixed currencies can't be averaged as raw numbers — keep the dominant one
  const byCur = {};
  pool.forEach((x) => { byCur[x.currency] = (byCur[x.currency] || 0) + 1; });
  const domCur = Object.keys(byCur).sort((a, b) => byCur[b] - byCur[a])[0];

  const totals = pool.filter((x) => x.currency === domCur).map((x) => x.total).sort((a, b) => a - b);
  if (totals.length < 6) return null;
  const mid = Math.floor(totals.length / 2);
  const median = totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
  const p25 = totals[Math.floor(totals.length * 0.25)];
  const p75 = totals[Math.floor(totals.length * 0.75)];
  return { median, p25, p75, count: totals.length, currency: domCur };
}

const COND_W = (c) => {
  c = (c || "").toLowerCase();
  if (c.includes("new")) return 1;
  if (c.includes("open box") || c.includes("refurb")) return 0.8;
  if (c.includes("parts") || c.includes("not working")) return 0.2;
  if (c) return 0.6; // used / pre-owned
  return 0.5;
};

function scoreListing(x, mkt) {
  // real sold prices (Marketplace Insights) beat asking prices when available
  const ref = soldStats ? soldStats.median : (mkt ? mkt.median : null);
  const depth = soldStats ? soldStats.count : (mkt ? mkt.count : 0);
  if (ref == null || x.total == null) return null;
  const discount = (ref - x.total) / ref;
  const dN = clamp(discount / 0.45, 0, 1);
  const pctN = x.seller.pct != null ? clamp((x.seller.pct - 95) / 5, 0, 1) : 0.4;
  const volN = clamp(x.seller.n / 500, 0, 1);
  const sN = 0.6 * pctN + 0.4 * volN;
  const score = Math.round(100 * (0.62 * dN + 0.22 * sN + 0.16 * COND_W(x.condition)));
  const tier = score >= 78 ? "hot" : score >= 62 ? "great" : score >= 48 ? "good" : "fair";
  const hot = discount >= 0.3 && depth >= 8;
  let profit = null;
  if (depth >= 8 && !x.isAuction) {
    const net = ref * (1 - settings.feePct / 100) - settings.shipOut - x.total;
    if (net > 0) profit = net;
  }
  return { score, tier, hot, discount, profit, soldBased: !!soldStats };
}

/* ============================================================
   RENDERING
   ============================================================ */
function sparkSVG(hist, cur) {
  const pts = (hist || []).filter((h) => h && h.v != null);
  if (pts.length < 2) return "";
  const vs = pts.map((h) => h.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const W = 120, H = 26, P = 2;
  const line = pts.map((h, i) => {
    const x = P + (i / (pts.length - 1)) * (W - 2 * P);
    const y = H - P - ((h.v - min) / span) * (H - 2 * P);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const dir = vs[vs.length - 1] < vs[0] ? "down" : vs[vs.length - 1] > vs[0] ? "up" : "flat";
  return `<div class="spark-wrap" title="${pts.length} price checks · low ${money(min, cur)} · high ${money(max, cur)}"><svg class="spark ${dir}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${line}" fill="none" vector-effect="non-scaling-stroke"/></svg></div>`;
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

function timeLeft(ts) {
  if (!ts) return "";
  const ms = ts - Date.now();
  if (ms <= 0) return "ended";
  const h = Math.floor(ms / 36e5), d = Math.floor(h / 24);
  if (d >= 1) return d + "d " + (h % 24) + "h left";
  const m = Math.floor((ms % 36e5) / 6e4);
  return h + "h " + m + "m left";
}

function cardHTML(x, sc, opts) {
  const o = opts || {};
  const watched = isWatched(x.id);
  const endingSoon = x.endAt && x.endAt - Date.now() < 36e5 * 6 && x.endAt > Date.now();
  const tierLabel = { hot: "HOT", great: "GREAT", good: "GOOD", fair: "FAIR" };

  return `
  <article class="lcard${sc && sc.hot ? " hot" : ""}${o.ended ? " ended" : ""}${o.pending ? " pending" : ""}" data-id="${esc(x.id)}">
    <div class="imgbox">
      <img src="${esc(x.img)}" alt="" loading="lazy" onerror="this.src='${FALLBACK_IMG}'" />
      ${sc ? `<span class="tag-score t-${sc.tier}" title="Deal score ${sc.score}/100 — ${Math.round(sc.discount * 100)}% vs ${sc.soldBased ? "SOLD" : "asking"} median">⛁ ${sc.score} ${tierLabel[sc.tier]}</span>` : ""}
      ${o.watch ? "" : `<button class="hide-btn" data-hide="${esc(x.id)}" title="Hide this listing from future scans" aria-label="Hide listing">✕</button>`}
    </div>
    <div class="body">
      <div class="badges">
        ${o.ended ? `<span class="badge gone">ENDED</span>` : ""}
        ${!o.watch && x.listedAt && Date.now() - x.listedAt < 48 * 36e5 ? `<span class="badge fresh">⚡ listed ${timeAgo(x.listedAt)}</span>` : ""}
        ${x.condition ? `<span class="badge">${esc(x.condition)}</span>` : ""}
        ${x.isAuction ? `<span class="badge auction">AUCTION · bid</span>` : (x.isBIN ? `<span class="badge">BUY IT NOW</span>` : "")}
        ${endingSoon ? `<span class="badge ending">⏱ ${timeLeft(x.endAt)}</span>` : (x.isAuction && x.endAt && !o.ended ? `<span class="badge">${timeLeft(x.endAt)}</span>` : "")}
      </div>
      <h3><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></h3>
      <div class="ledger">
        <div class="row"><span class="lbl">${x.isAuction ? "current bid" : "item"}</span><span class="dots"></span><span class="val">${money(x.price, x.currency)}</span></div>
        <div class="row"><span class="lbl">shipping</span><span class="dots"></span><span class="val">${x.shippingKnown ? (x.shipping === 0 ? "FREE" : money(x.shipping, x.currency)) : "varies"}</span></div>
        <div class="row total"><span class="lbl">total</span><span class="dots"></span><span class="val">${money(x.total, x.currency)}${x.shippingKnown ? "" : "†"}</span></div>
      </div>
      ${sc && sc.discount > 0.02 ? (sc.soldBased
        ? `<div class="below sold"><b>${Math.round(sc.discount * 100)}% below</b> SOLD median ${money(soldStats.median, x.currency)} <button class="linklike comps-link" data-comps="${esc(x.id)}">comps</button></div>`
        : `<div class="below"><b>${Math.round(sc.discount * 100)}% below</b> market median ${money(marketRef().median, x.currency)}</div>`) : ""}
      ${sc && sc.profit != null ? `<div class="profit">≈ +${money(sc.profit, x.currency)} est. profit if flipped at market</div>` : ""}
      ${o.hist ? sparkSVG(o.hist, x.currency) : ""}
      ${o.delta != null ? `<div class="delta ${o.delta < 0 ? "down" : "up"}">${o.delta < 0 ? "▼" : "▲"} ${money(Math.abs(o.delta), x.currency)} since saved</div>` : ""}
      ${x.seller.name ? `<div class="seller">Seller <b>${esc(x.seller.name)}</b>${x.seller.pct != null ? ` · ${x.seller.pct}% (${x.seller.n.toLocaleString()})` : ""}${!o.watch ? ` <button class="block-btn" data-block="${esc(x.seller.name)}" title="Never show this seller again">block</button>` : ""}</div>` : ""}
      ${o.checked ? `<div class="checked">↻ checked ${timeAgo(o.checked)}</div>` : ""}
    </div>
    <div class="actions">
      <a class="btn ghost" href="${esc(x.url)}" target="_blank" rel="noopener" title="Open on eBay">eBay ↗</a>
      ${!o.watch && x.total != null ? `<button class="btn ghost" data-calc="${esc(x.id)}" title="Profit calculator">$ Profit</button>` : ""}
      ${o.watch ? `<button class="btn ghost" data-target="${esc(x.id)}" title="Set a snipe target price">🎯 ${o.target != null ? money(o.target, x.currency) : "Target"}</button>` : ""}
      <button class="btn ghost watch-btn${watched ? " on" : ""}" data-watch="${esc(x.id)}">${watched ? "★ Watching" : "☆ Watch"}</button>
    </div>
  </article>`;
}

let _marketRef = null;
function marketRef() { return _marketRef || { median: 0 }; }

function renderResults() {
  _marketRef = market;
  const grid = $("#results");
  const sortBy = $("#fSort").value;
  let scored = results.map((x) => ({ x, sc: scoreListing(x, market) }));

  // view-only filters (applied client-side, results stay intact)
  const sq = $("#fSeller").value;
  if (sq) {
    const [minPct, minN] = sq.split("|").map(Number);
    scored = scored.filter(({ x }) => x.seller.pct != null && x.seller.pct >= minPct && x.seller.n >= minN);
  }
  if ($("#fGems").checked) scored = scored.filter(({ x }) => x.title.length <= 40);

  if (sortBy !== "match") scored.sort((a, b) => { // "match" keeps eBay's own relevance order
    if (sortBy === "totalAsc") return (a.x.total ?? 1e12) - (b.x.total ?? 1e12);
    if (sortBy === "newest") return (b.x.listedAt || 0) - (a.x.listedAt || 0);
    if (sortBy === "ending") return (a.x.endAt || 9e15) - (b.x.endAt || 9e15);
    if (sortBy === "seller") return ((b.x.seller.pct || 0) - (a.x.seller.pct || 0)) || (b.x.seller.n - a.x.seller.n);
    return ((b.sc && b.sc.score) || -1) - ((a.sc && a.sc.score) || -1);
  });

  grid.innerHTML = scored.map(({ x, sc }) => cardHTML(x, sc)).join("") ||
    (results.length ? `<div class="filtered-note">All ${results.length} results are hidden by the Seller quality / Hidden gems view filters — loosen them to see listings again.</div>` : "");
  $("#emptyState").hidden = results.length > 0;
  $("#exportBtn").hidden = results.length === 0;

  const strip = $("#marketStrip");
  const shown = `showing ${scored.length}${totalAvail > scored.length ? ` of ${totalAvail.toLocaleString()}` : ""}`;
  if (market || soldStats) {
    const cur = (market && market.currency) || (results[0] && results[0].currency) || marketCurrency();
    const refMedian = soldStats ? soldStats.median : market.median;
    const dealLine = refMedian * 0.7;
    const hotCount = scored.filter((s) => s.sc && s.sc.hot).length;
    // sell-through: recent sales vs live supply — rough demand read
    const st = soldStats && totalAvail ? soldStats.soldTotal / (soldStats.soldTotal + totalAvail) : null;
    strip.innerHTML =
      (soldStats
        ? `<span>SOLD median:</span> <b>${money(soldStats.median, cur)}</b> <span class="dim">${soldStats.count} recent sales</span>`
        : "") +
      (market
        ? `<span>${soldStats ? "Asking" : "Market read"}:</span> <b>${money(market.median, cur)}</b> <span class="dim">median · typical ${money(market.p25, cur)}–${money(market.p75, cur)} · ${market.count} comparables</span>`
        : "") +
      (st != null
        ? `<span class="${st > 0.55 ? "flag" : "dim"}">sell-through ${(st * 100).toFixed(0)}%${st > 0.55 ? " · moves fast 🔥" : st < 0.3 ? " · slow mover 🐌" : ""}</span>`
        : "") +
      `<span class="flag">${hotCount > 0 ? `🔥 ${hotCount} flagged below ${money(dealLine, cur)}` : `deals flag below ${money(dealLine, cur)}`}</span>` +
      `<span class="dim">${shown} · † total excludes unknown shipping</span>` +
      `<button class="strip-btn" id="mkAlert" title="Save a deal alert for this search">🔔 alert me on new deals</button>`;
    strip.hidden = false;
  } else {
    strip.innerHTML = results.length
      ? `<span class="dim">Not enough comparable listings to read the market — showing raw results without scores (${shown}).</span>`
      : "";
    strip.hidden = results.length === 0;
  }
}

/* ---------- dynamic aspect refinements (eBay's left-rail filters) ---------- */
function renderAspects() {
  const box = $("#aspects");
  const anySel = Object.keys(aspectSel).some((n) => aspectSel[n] && aspectSel[n].size);
  if (!aspects.length && !anySel) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = aspects.map((a) => {
    const name = a.localizedAspectName;
    const sel = aspectSel[name] || new Set();
    // values containing filter-syntax separators can't be round-tripped safely
    const vals = (a.aspectValueDistributions || []).filter((v) => !/[,{}|]/.test(v.localizedAspectValue || "")).slice(0, 8);
    if (!vals.length) return "";
    return `<div class="aspect-group"><span class="aspect-name">${esc(name)}</span>` +
      vals.map((v) => `<button class="chip aspect${sel.has(v.localizedAspectValue) ? " on" : ""}" data-aspect="${esc(name)}" data-value="${esc(v.localizedAspectValue)}">${esc(v.localizedAspectValue)}${v.matchCount != null ? ` <span class="cnt">${v.matchCount.toLocaleString()}</span>` : ""}</button>`).join("") +
      `</div>`;
  }).join("") +
  (anySel ? `<button class="chip chip-x" data-clearaspects>✕ clear refinements</button>` : "");
}

$("#aspects").addEventListener("click", (e) => {
  if (!lastQuery) return;
  if (e.target.closest("[data-clearaspects]")) {
    aspectSel = {};
    runScan(lastQuery.raw, false, true);
    return;
  }
  const b = e.target.closest("[data-aspect]");
  if (!b) return;
  const n = b.dataset.aspect, v = b.dataset.value;
  aspectSel[n] = aspectSel[n] || new Set();
  if (aspectSel[n].has(v)) aspectSel[n].delete(v); else aspectSel[n].add(v);
  runScan(lastQuery.raw, false, true);
});

/* ---------- toast (with optional undo) ---------- */
let toastTimer = null, toastAction = null;
function toast(msg, actionLabel, onAction) {
  $("#toastMsg").textContent = msg;
  const act = $("#toastAct");
  toastAction = onAction || null;
  act.hidden = !actionLabel;
  if (actionLabel) act.textContent = actionLabel;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; toastAction = null; }, 6000);
}
$("#toastAct").addEventListener("click", () => {
  clearTimeout(toastTimer);
  $("#toast").hidden = true;
  if (toastAction) toastAction();
  toastAction = null;
});

/* ---------- status helpers ---------- */
function showStatus(msg, cls) {
  const el = $("#status");
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.className = "status" + (cls ? " " + cls : "");
  el.hidden = false;
}

/* ============================================================
   SCAN FLOW
   ============================================================ */
async function runScan(rawQuery, append, keepFilters) {
  if (isScanning) return;
  const { q, max } = parseQuery(rawQuery);
  if (!q) return;
  if (!settingsReady()) {
    showStatus("Connect your eBay API key first — open Settings (top right). Setup takes about five minutes.", "err");
    switchTab("settings");
    return;
  }
  // only apply "under $X" to the filter on a fresh search — re-scans
  // (filter changes, Load more) must not clobber what the user set
  if (max != null && !keepFilters) $("#fMax").value = max;

  const btn = $("#scanBtn");
  const moreBtn = $("#moreBtn");
  isScanning = true;
  btn.disabled = true;
  moreBtn.disabled = true;
  showStatus(append ? "Loading more…" : `Scanning eBay for “${q}”…`, "busy");
  $(".hero").classList.add("compact"); // results deserve the screen space now
  if (!append) {
    nextOffset = 0;
    results = [];
    market = null;
    soldStats = null; // don't score a new query against the old query's sold comps
    totalAvail = 0;
    if (!keepFilters) { aspectSel = {}; dominantCat = null; aspects = []; renderAspects(); } // new query, new refinements
    $("#results").innerHTML = '<div class="skel"></div>'.repeat(8);
    $("#emptyState").hidden = true;
    $("#marketStrip").hidden = true;
  }

  try {
    const data = await ebayGET(buildSearchPath(q, nextOffset));
    const items = (data.itemSummaries || []).map(normalize).filter((x) => x.price != null);
    results = append ? results.concat(items) : items;
    // de-dupe by id, drop hidden listings and blocked sellers
    const seen = new Set();
    const hiddenSet = new Set(getHidden());
    const blockedSet = new Set(getBlocked());
    results = results.filter((x) => !hiddenSet.has(x.id) && !blockedSet.has(x.seller.name) && (seen.has(x.id) ? false : (seen.add(x.id), true)));

    market = computeMarket(results);
    lastQuery = { raw: rawQuery, q };
    totalAvail = data.total || 0;
    if (!append && data.refinement) {
      dominantCat = data.refinement.dominantCategoryId || dominantCat;
      aspects = (data.refinement.aspectDistributions || []).slice(0, 6);
      renderAspects();
    }
    if (!append) soldStats = await fetchSoldStats(q); // null unless Insights access confirmed
    nextOffset += PAGE;
    $("#moreBtn").hidden = !(data.total && nextOffset < Math.min(data.total, 600));

    renderResults();
    showStatus(results.length ? null : `No live listings matched “${q}” with these filters. Loosen the filters or reword the search.`);
    if (!append && !keepFilters) pushRecent(rawQuery);
    // make the scan shareable/bookmarkable (throws on file://, where it can't work)
    if (!append) {
      document.title = `${q} — Tokubai`;
      try { history.replaceState(null, "", "?q=" + encodeURIComponent(rawQuery)); } catch { /* noop */ }
    }
  } catch (e) {
    if (!append) { results = []; renderResults(); }
    showStatus(friendlyError(e), "err");
  } finally {
    isScanning = false;
    btn.disabled = false;
    moreBtn.disabled = false;
    // a filter changed while we were scanning — apply it now
    if (pendingRefine && lastQuery) { pendingRefine = false; runScan(lastQuery.raw, false, true); }
  }
}

$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); runScan($("#q").value, false); });
$("#moreBtn").addEventListener("click", () => lastQuery && runScan(lastQuery.raw, true, true));
["fMin", "fMax", "fCat", "fCond", "fType", "fExclude", "fLoc", "fFreeShip"].forEach((id) => $("#" + id).addEventListener("change", () => {
  if (!lastQuery) return;
  if (isScanning) { pendingRefine = true; return; } // don't drop it — apply after the scan
  runScan(lastQuery.raw, false, true);
}));
// view-only filters — re-render without another API call
["fSeller", "fGems"].forEach((id) => $("#" + id).addEventListener("change", () => results.length && renderResults()));

$("#resetFilters").addEventListener("click", () => {
  ["fMin", "fMax", "fExclude"].forEach((id) => { $("#" + id).value = ""; });
  ["fCat", "fCond", "fType", "fLoc", "fSeller"].forEach((id) => { $("#" + id).value = ""; });
  $("#fFreeShip").checked = false;
  $("#fGems").checked = false;
  aspectSel = {};
  if (lastQuery) runScan(lastQuery.raw, false, true);
  else renderAspects();
});

// on small screens the filter panel collapses behind this toggle
$("#filtersToggle").addEventListener("click", () => $("#filters").classList.toggle("open"));

/* ---------- grid ↔ list view ---------- */
function applyView(v) {
  document.body.classList.toggle("listview", v === "list");
  $("#viewToggle").innerHTML = v === "list" ? "⊞ Grid" : "≡ List";
}
$("#viewToggle").addEventListener("click", () => {
  const v = document.body.classList.contains("listview") ? "grid" : "list";
  lsSet(K.view, v);
  applyView(v);
});

/* ---------- back to top ---------- */
window.addEventListener("scroll", () => { $("#toTop").hidden = window.scrollY < 900; }, { passive: true });
$("#toTop").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
$("#fSort").addEventListener("change", () => results.length && renderResults());

/* ---------- recent searches ---------- */
function pushRecent(qr) {
  let r = lsGet(K.recent, []);
  r = [qr, ...r.filter((x) => x.toLowerCase() !== qr.toLowerCase())].slice(0, 8);
  lsSet(K.recent, r);
  renderRecent();
}
function renderRecent() {
  const r = lsGet(K.recent, []);
  $("#recentChips").innerHTML = r.map((x) => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join("") +
    (r.length ? `<button class="chip chip-x" data-clearrecent title="Clear recent searches">✕ clear</button>` : "");
}
$("#recentChips").addEventListener("click", (e) => {
  if (e.target.closest("[data-clearrecent]")) { lsSet(K.recent, []); renderRecent(); return; }
  const b = e.target.closest("[data-q]");
  if (b) { $("#q").value = b.dataset.q; runScan(b.dataset.q, false); }
});
$$(".eg").forEach((b) => b.addEventListener("click", () => { $("#q").value = b.dataset.eg; switchTab("search"); runScan(b.dataset.eg, false); }));

/* ============================================================
   WATCHLIST
   ============================================================ */
function getWatch() { return lsGet(K.watch, []); }

// isWatched runs once per rendered card — memoize instead of re-parsing
// localStorage 60+ times per render
let _watchIds = null;
function watchIdsInvalidate() { _watchIds = null; }
function isWatched(id) {
  if (!_watchIds) _watchIds = new Set(getWatch().map((w) => w.id));
  return _watchIds.has(id);
}

function toggleWatch(id) {
  let list = getWatch();
  if (list.some((w) => w.id === id)) {
    list = list.filter((w) => w.id !== id);
  } else {
    const x = results.find((r) => r.id === id) || liveInfo.get(id);
    if (!x) return;
    liveInfo.set(id, x); // display details stay in memory only (data rule)
    list.unshift({ id: x.id, savedAt: Date.now(), savedTotal: x.total, lastTotal: x.total, checkedAt: null, hist: x.total != null ? [{ t: Date.now(), v: x.total }] : [] });
    if (list.length > 60) list = list.slice(0, 60);
  }
  lsSet(K.watch, list);
  watchIdsInvalidate();
  updateWatchCount();
  renderWatch();
  // refresh any matching button in results
  $$(`[data-watch="${CSS.escape(id)}"]`).forEach((b) => {
    const on = isWatched(id);
    b.classList.toggle("on", on);
    b.textContent = on ? "★ Watching" : "☆ Watch";
  });
}

document.addEventListener("click", (e) => {
  const h = e.target.closest("[data-hide]");
  if (h) { hideListing(h.dataset.hide); return; }
  const bl = e.target.closest("[data-block]");
  if (bl) { blockSeller(bl.dataset.block); return; }
  const pc = e.target.closest("[data-calc]");
  if (pc) { openCalc(pc.dataset.calc); return; }
  const cp = e.target.closest("[data-comps]");
  if (cp) { openComps(cp.dataset.comps); return; }
  const tg = e.target.closest("[data-target]");
  if (tg) { openTargetDialog(tg.dataset.target); return; }
  const ar = e.target.closest("[data-runalert]");
  if (ar) { runAlertSearch(ar.dataset.runalert); return; }
  const ae = e.target.closest("[data-editalert]");
  if (ae) { editAlert(ae.dataset.editalert); return; }
  const ad = e.target.closest("[data-delalert]");
  if (ad) { deleteAlert(ad.dataset.delalert); return; }
  const w = e.target.closest("[data-watch]");
  if (w) toggleWatch(w.dataset.watch);
});

/* ---------- hidden listings ---------- */
function getHidden() { return lsGet(K.hidden, []); }
function updateHiddenCount() { const el = $("#hiddenCount"); if (el) el.textContent = getHidden().length; }
function hideListing(id) {
  const item = results.find((x) => x.id === id);
  const hidden = getHidden();
  if (!hidden.includes(id)) hidden.unshift(id);
  lsSet(K.hidden, hidden.slice(0, 500));
  results = results.filter((x) => x.id !== id);
  market = computeMarket(results); // scores shift when a comparable disappears
  renderResults();
  updateHiddenCount();
  toast("Listing hidden — it won't appear in future scans.", "Undo", () => {
    lsSet(K.hidden, getHidden().filter((h) => h !== id));
    updateHiddenCount();
    if (item && !results.some((x) => x.id === id)) {
      results.push(item);
      market = computeMarket(results);
      renderResults();
    }
  });
}
$("#clearHidden").addEventListener("click", () => {
  lsSet(K.hidden, []);
  updateHiddenCount();
  setInlineStatus("Hidden listings cleared — they'll show up in scans again.", "ok");
});

/* ---------- blocked sellers ---------- */
function getBlocked() { return lsGet(K.sellers, []); }
function updateBlockedCount() { const el = $("#blockedCount"); if (el) el.textContent = getBlocked().length; }
function blockSeller(name) {
  if (!name) return;
  const b = getBlocked();
  if (!b.includes(name)) b.unshift(name);
  lsSet(K.sellers, b.slice(0, 200));
  const removed = results.filter((x) => x.seller.name === name);
  results = results.filter((x) => x.seller.name !== name);
  market = computeMarket(results);
  renderResults();
  updateBlockedCount();
  toast(`Blocked “${name}” — ${removed.length} listing${removed.length === 1 ? "" : "s"} removed from all future scans.`, "Undo", () => {
    lsSet(K.sellers, getBlocked().filter((s) => s !== name));
    updateBlockedCount();
    results = results.concat(removed.filter((r) => !results.some((x) => x.id === r.id)));
    market = computeMarket(results);
    renderResults();
  });
}
$("#clearBlocked").addEventListener("click", () => {
  lsSet(K.sellers, []);
  updateBlockedCount();
  setInlineStatus("Blocked sellers cleared — their listings will show up again.", "ok");
});

function updateWatchCount() {
  const n = getWatch().length;
  const el = $("#watchCount");
  el.textContent = n;
  el.hidden = n === 0;
}

function watchDelta(x) {
  return x.checkedAt != null && x.savedTotal != null && x.lastTotal != null && x.lastTotal !== x.savedTotal
    ? x.lastTotal - x.savedTotal : null;
}

// merge a persisted watch entry (ids + prices only) with live session details
function watchDisplay(w) {
  const info = liveInfo.get(w.id);
  const d = info ? { ...info } : {
    id: w.id,
    title: `Item ${legacyIdOf(w.id) || w.id} — refresh prices to load details`,
    url: itemUrlFromId(w.id), img: FALLBACK_IMG,
    price: w.lastTotal, shipping: null, shippingKnown: false,
    currency: marketCurrency(), condition: "", isAuction: false, isBIN: false,
    endAt: null, listedAt: 0, seller: { name: "", pct: null, n: 0 },
  };
  d.total = w.lastTotal != null ? w.lastTotal : d.total;
  d.pending = !info;
  return d;
}

function renderWatch() {
  const list = getWatch().slice();
  const grid = $("#watchGrid");
  _marketRef = null; // watch cards don't show market lines

  const endOf = (w) => { const i = liveInfo.get(w.id); return (i && i.endAt) || 9e15; };
  const sortBy = $("#watchSort").value;
  if (sortBy === "drop") list.sort((a, b) => (watchDelta(a) ?? 0) - (watchDelta(b) ?? 0)); // biggest drop first
  else if (sortBy === "total") list.sort((a, b) => (a.lastTotal ?? 1e12) - (b.lastTotal ?? 1e12));
  else if (sortBy === "ending") list.sort((a, b) => endOf(a) - endOf(b));
  // "saved" = stored order (newest saved first) — no sort needed

  grid.innerHTML = list.map((w) => {
    const d = watchDisplay(w);
    return cardHTML(d, null,
      { delta: watchDelta(w), ended: !!w.ended, watch: true, checked: w.checkedAt, hist: w.hist, target: w.target, pending: d.pending });
  }).join("");
  $("#watchEmpty").hidden = list.length > 0;
  renderSnipe();

  const summary = $("#watchSummary");
  summary.hidden = list.length === 0;
  if (list.length) {
    const live = list.filter((w) => !w.ended);
    const dropped = list.filter((w) => (watchDelta(w) ?? 0) < 0).length;
    const buyAll = live.reduce((s, w) => s + (w.lastTotal || 0), 0);
    const first = liveInfo.get(list[0] && list[0].id);
    const cur = (first && first.currency) || marketCurrency();
    summary.innerHTML =
      `<b>${list.length}</b> watched · <b>${live.length}</b> live` +
      ` · <b>${dropped}</b> dropped since saved` +
      ` · buy-all total <b>${money(buyAll, cur)}</b>`;
  }
}
$("#watchSort").addEventListener("change", () => { lsSet(K.wsort, $("#watchSort").value); renderWatch(); });

// snipe countdowns go stale fast — tick them while the watch tab is visible
setInterval(() => { if (!$("#tab-watch").hidden) renderSnipe(); }, 30000);

/* ---------- auction snipe panel (ending soon, under target) ---------- */
function renderSnipe() {
  const box = $("#snipeBox");
  if (!box) return;
  const winMin = parseInt(lsGet(K.snipe, "60"), 10) || 60;
  $("#snipeWin").value = String(winMin);
  const now = Date.now();
  const rows = [];
  for (const w of getWatch()) {
    if (w.ended) continue;
    const info = liveInfo.get(w.id); // end times are live-only (data rule)
    if (!info || !info.isAuction || !info.endAt) continue;
    const msLeft = info.endAt - now;
    if (msLeft <= 0 || msLeft > winMin * 60000) continue;
    const under = w.target != null && w.lastTotal != null ? w.lastTotal <= w.target : null;
    rows.push({ w, info, msLeft, under });
  }
  rows.sort((a, b) => a.msLeft - b.msLeft);
  box.hidden = rows.length === 0;
  $("#snipeRows").innerHTML = rows.map(({ w, info, under }) => `
    <div class="alert-row snipe-row${under ? " under" : ""}">
      <span class="snipe-time">⏱ ${timeLeft(info.endAt)}</span>
      <a class="snipe-link" href="${esc(info.url)}" target="_blank" rel="noopener">${esc(info.title)}</a>
      <span class="alert-meta">bid ${money(w.lastTotal, info.currency)}${w.target != null ? ` · target ${money(w.target, info.currency)}` : ""}</span>
      ${under ? `<span class="badge ending">UNDER TARGET</span>` : ""}
    </div>`).join("");
}

function showWatchStatus(msg, cls) {
  const el = $("#watchStatus");
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.className = "status" + (cls ? " " + cls : "");
  el.hidden = false;
}

let isRefreshing = false;

async function refreshWatchPrices(auto) {
  if (isRefreshing) return;
  const list = getWatch();
  if (!list.length) return;
  if (!settingsReady()) { if (!auto) showWatchStatus("Connect your eBay API key in Settings first.", "err"); return; }
  isRefreshing = true;
  const btn = $("#refreshWatch");
  btn.disabled = true;

  const live = list.filter((w) => !w.ended); // don't burn API calls on dead listings
  const queue = live.slice();
  let done = 0, gone = 0, fatal = null;
  const drops = [];

  // small worker pool: ~4 requests in flight instead of one-at-a-time
  async function worker() {
    while (queue.length && !fatal) {
      const w = queue.shift();
      try {
        const it = await ebayGET("/buy/browse/v1/item/" + encodeURIComponent(w.id), true); // always live, never cached
        const fresh = normalize({ ...it, itemId: w.id, itemWebUrl: it.itemWebUrl || itemUrlFromId(w.id) });
        liveInfo.set(w.id, fresh); // session-only details (data rule)
        const prev = w.lastTotal != null ? w.lastTotal : w.savedTotal;
        w.lastTotal = fresh.total != null ? fresh.total : w.lastTotal;
        w.checkedAt = Date.now();
        // price history for the sparkline — our own observed prices only
        if (w.lastTotal != null) {
          if (!w.hist || !w.hist.length) w.hist = w.savedTotal != null ? [{ t: w.savedAt || Date.now(), v: w.savedTotal }] : [];
          const lastPt = w.hist[w.hist.length - 1];
          if (!lastPt || lastPt.v !== w.lastTotal || w.hist.length < 2) w.hist.push({ t: Date.now(), v: w.lastTotal });
          if (w.hist.length > 60) w.hist = w.hist.slice(-60);
        }
        // ended listings can still answer with 200 — catch them by end date
        if (fresh.endAt && fresh.endAt < Date.now()) { w.ended = true; gone++; }
        else if (fresh.total != null && prev != null && fresh.total < prev - 0.005) {
          drops.push(`${fresh.title.length > 48 ? fresh.title.slice(0, 48) + "…" : fresh.title} — now ${money(fresh.total, fresh.currency)} (was ${money(prev, fresh.currency)})`);
        }
      } catch (err) {
        const m = String(err && err.message || "");
        if (m === "API_404" || m === "API_410") { w.ended = true; gone++; w.checkedAt = Date.now(); }
        else if (m === "RATE_LIMIT" || m === "BAD_KEYS" || m === "PROXY_DOWN") fatal = err;
        // anything else: skip this item, keep checking the rest
      }
      showWatchStatus(`Re-checking prices… ${++done} of ${live.length}`, "busy");
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  // merge into a fresh read — the user may have watched/unwatched mid-refresh
  const cur = getWatch();
  for (const w of list) {
    const m = cur.find((x) => x.id === w.id);
    if (m) Object.assign(m, w);
  }
  lsSet(K.watch, cur);
  watchIdsInvalidate();
  renderWatch();
  btn.disabled = false;
  isRefreshing = false;
  if (fatal) { showWatchStatus(friendlyError(fatal), "err"); return; }
  showWatchStatus(
    `Done — ${done} checked` +
    (gone ? `, ${gone} no longer live (sold or ended)` : "") +
    (drops.length ? `, 🔻 ${drops.length} price drop${drops.length === 1 ? "" : "s"}` : "") +
    ". ▼ green means the price dropped.", "ok");
  notifyDrops(drops);
}

$("#refreshWatch").addEventListener("click", async () => {
  await refreshWatchPrices(false);
  await checkDealAlerts(false);
});

/* ---------- price-drop notifications ---------- */
let notifyOn = lsGet(K.notify, false);

function paintNotifyBtn() {
  const btn = $("#notifyBtn");
  btn.textContent = notifyOn ? "🔔 Alerts on" : "🔕 Alerts off";
  btn.classList.toggle("on", notifyOn);
}

$("#notifyBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) { showWatchStatus("This browser doesn't support desktop notifications.", "err"); return; }
  if (!notifyOn) {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { showWatchStatus("Notifications are blocked — allow them for this site in your browser settings.", "err"); return; }
  }
  notifyOn = !notifyOn;
  lsSet(K.notify, notifyOn);
  paintNotifyBtn();
  showWatchStatus(notifyOn
    ? "You'll get a desktop alert when a refresh finds a price drop. Pair with auto-refresh and leave this tab open."
    : "Price alerts off.", "ok");
});

function pushNote(title, lines, tag) {
  if (!lines.length || !notifyOn) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, {
      body: lines.slice(0, 4).join("\n") + (lines.length > 4 ? `\n…and ${lines.length - 4} more` : ""),
      tag, // replaces the previous note of this kind instead of stacking
    });
  } catch { /* some platforms need a service worker for this — shown in-app anyway */ }
}
function notifyDrops(drops) {
  pushNote(`Tokubai — ${drops.length} price drop${drops.length === 1 ? "" : "s"} 🔻`, drops, "tokubai-drops");
}

/* ---------- auto-refresh ---------- */
let autoTimer = null;

function setupAutoRefresh() {
  clearInterval(autoTimer);
  const mins = parseInt(lsGet(K.auto, "0"), 10) || 0;
  $("#autoRefresh").value = String(mins);
  if (mins > 0) {
    autoTimer = setInterval(async () => {
      if (getWatch().some((w) => !w.ended)) await refreshWatchPrices(true);
      await checkDealAlerts(true);
      if (!$("#tab-dash").hidden) renderDashboard(true); // keep visible columns live too
    }, mins * 60 * 1000);
  }
}

$("#autoRefresh").addEventListener("change", (e) => {
  lsSet(K.auto, e.target.value);
  setupAutoRefresh();
  const mins = parseInt(e.target.value, 10) || 0;
  showWatchStatus(mins
    ? `Auto-refresh every ${mins} minutes while this tab stays open. Turn on 🔔 Alerts to get notified of drops.`
    : "Auto-refresh off.", "ok");
});

$("#clearEnded").addEventListener("click", () => {
  const list = getWatch();
  const keep = list.filter((w) => !w.ended);
  const removed = list.length - keep.length;
  if (!removed) { showWatchStatus("No ended listings to remove — refresh prices first to detect them.", ""); return; }
  lsSet(K.watch, keep);
  watchIdsInvalidate();
  updateWatchCount();
  renderWatch();
  showWatchStatus(`Removed ${removed} ended listing${removed === 1 ? "" : "s"}.`, "ok");
});

/* ============================================================
   DEAL ALERTS — watch a search, get pinged under your price
   ============================================================ */
let isCheckingAlerts = false;

function getAlerts() { return lsGet(K.alerts, []); }

function renderAlerts() {
  const alerts = getAlerts();
  $("#alertsBox").hidden = alerts.length === 0;
  $("#alertRows").innerHTML = alerts.map((a) => `
    <div class="alert-row">
      <button class="alert-run" data-runalert="${esc(a.id)}" title="Run this search now, newest first">🔔 <b>${esc(a.q)}</b> — ${alertCondText(a)}</button>
      <span class="alert-meta">${a.target == null && !a.every ? "server-checked · " : ""}${a.lastRunAt ? `checked ${timeAgo(a.lastRunAt)}` : "not checked yet"}${a.hits ? ` · ${a.hits} found so far` : ""}</span>
      <button class="alert-del" data-editalert="${esc(a.id)}" aria-label="Edit target price" title="Edit target price">✎</button>
      <button class="alert-del" data-delalert="${esc(a.id)}" aria-label="Delete this alert" title="Delete alert">✕</button>
    </div>`).join("");
}

const alertDlg = $("#alertDlg");
let dlgCtx = null; // what the open dialog is editing/creating

function alertCondText(a) {
  if (a.every) return "every new listing";
  const bits = [];
  if (a.target != null) bits.push(`at or under ${money(a.target, a.currency)}`);
  if (a.pctBelow != null) bits.push(`${a.pctBelow}%+ below going rate`);
  return bits.join(" or ") || "—";
}

function openAlertDialog(ctx) {
  dlgCtx = ctx;
  $("#alertDlgTitle").textContent = ctx.mode === "edit" ? "Edit deal alert" : "New deal alert";
  $("#alertDlgInfo").innerHTML = ctx.info;
  $("#alertQ").value = ctx.q || "";
  $("#alertTarget").value = ctx.suggested != null ? ctx.suggested : "";
  $("#alertPct").value = ctx.pct != null ? ctx.pct : "";
  $("#alertEvery").checked = !!ctx.every;
  $("#alertQRow").hidden = ctx.mode === "watchtarget";
  $("#alertPctRow").hidden = ctx.mode === "watchtarget"; // snipe targets are absolute only
  $("#alertEveryRow").hidden = ctx.mode === "watchtarget";
  $("#alertSnap").checked = false;
  $("#alertSnapRow").hidden = ctx.mode !== "edit";
  alertDlg.returnValue = "";
  alertDlg.showModal();
  $("#alertTarget").select();
}

alertDlg.addEventListener("close", () => {
  const ctx = dlgCtx;
  dlgCtx = null;
  if (!ctx || alertDlg.returnValue !== "save") return;
  const tRaw = $("#alertTarget").value.trim();
  const pRaw = $("#alertPct").value.trim();
  const target = tRaw === "" ? null : parseFloat(tRaw);
  const pct = pRaw === "" ? null : clamp(parseFloat(pRaw) || 0, 1, 90);

  if (ctx.mode === "watchtarget") {
    if (target == null || isNaN(target) || target < 0) return;
    const list = getWatch();
    const w = list.find((x) => x.id === ctx.id);
    if (!w) return;
    w.target = target > 0 ? target : undefined; // 0 clears the target
    lsSet(K.watch, list);
    renderWatch();
    showWatchStatus(w.target != null ? `Snipe target set at ${money(w.target, (liveInfo.get(w.id) || {}).currency)}.` : "Snipe target cleared.", "ok");
    return;
  }

  const every = $("#alertEvery").checked;
  const qNew = $("#alertQ").value.trim();
  const hasTarget = target != null && !isNaN(target) && target > 0;
  const hasPct = pct != null && pct > 0;
  if (!qNew) { showStatus("Alert not saved — the search phrase can't be empty.", "err"); return; }
  if (!hasTarget && !hasPct && !every) { showStatus("Alert not saved — set a price, a % below going rate, or tick “every new listing”.", "err"); return; }

  if (ctx.mode === "edit") {
    const alerts = getAlerts();
    const a = alerts.find((x) => x.id === ctx.id);
    if (!a) return;
    const qChanged = qNew.toLowerCase() !== a.q.toLowerCase();
    a.q = qNew;
    a.target = hasTarget ? target : null;
    a.pctBelow = hasPct ? pct : null;
    a.every = every || undefined;
    if ($("#alertSnap").checked) {
      a.cat = $("#fCat").value || null;
      a.cond = $("#fCond").value || null;
      a.min = parseFloat($("#fMin").value) || null;
      a.max = parseFloat($("#fMax").value) || null;
      a.excl = $("#fExclude").value.trim();
    }
    if (qChanged || $("#alertSnap").checked) a.seen = []; // different search — forget old ids, re-seed
    lsSet(K.alerts, alerts);
    renderAlerts();
    showWatchStatus(`Alert updated — “${a.q}” now flags listings ${alertCondText(a)}.`, "ok");
    if (!a.seen.length) checkAlert(a, true).then(() => persistAlertSeed(a)).catch(() => { /* seeds on next check */ });
    return;
  }

  // snapshot the current filter panel so the tracker compares like with like
  const a = {
    id: String(Date.now()), q: qNew,
    target: hasTarget ? target : null,
    pctBelow: hasPct ? pct : null,
    every: every || undefined,
    currency: ctx.currency,
    cat: $("#fCat").value || null,
    cond: $("#fCond").value || null,
    min: parseFloat($("#fMin").value) || null,
    max: parseFloat($("#fMax").value) || null,
    excl: $("#fExclude").value.trim(),
    createdAt: Date.now(), lastRunAt: null, seen: [], hits: 0,
  };
  lsSet(K.alerts, [a, ...getAlerts().filter((x) => x.q.toLowerCase() !== a.q.toLowerCase())].slice(0, 20));
  renderAlerts();
  showStatus(
    `Alert saved — new “${a.q}” listings ${alertCondText(a)} get flagged on every refresh. Sync to the server in Settings for 24/7 alerts.` +
    (notifyOn ? "" : " Turn on 🔔 Alerts in the Watchlist tab for desktop pings."), "ok");
  // seed with what's listed right now, so only genuinely NEW listings ping
  checkAlert(a, true).then(() => persistAlertSeed(a)).catch(() => { /* seeds on the next check instead */ });
});

// merge one alert's seed/counters into current storage — never overwrite the
// whole list with a stale copy (the user may have added/deleted alerts meanwhile)
function persistAlertSeed(a) {
  const cur = getAlerts();
  const m = cur.find((x) => x.id === a.id);
  if (!m) return; // deleted while we were seeding
  m.seen = a.seen;
  m.lastRunAt = a.lastRunAt;
  m.hits = a.hits;
  lsSet(K.alerts, cur);
  renderAlerts();
}

function createAlertFromScan() {
  if (!lastQuery) return;
  const cur = market ? market.currency : marketCurrency();
  openAlertDialog({
    mode: "create",
    q: lastQuery.q,
    currency: cur,
    suggested: soldStats ? Math.round(soldStats.median * 0.75) : market ? Math.round(market.median * 0.75) : parseFloat($("#fMax").value) || "",
    info: `Watching for new <b>“${esc(lastQuery.q)}”</b> listings.` +
      (market ? ` Market median is <b>${money(market.median, cur)}</b> — a good target sits below it.` : "") +
      ` Your current filters (category, condition, price range, excluded words) are saved with the alert so it compares like with like.`,
  });
}

function editAlert(id) {
  const a = getAlerts().find((x) => x.id === id);
  if (!a) return;
  openAlertDialog({
    mode: "edit",
    id: a.id,
    q: a.q,
    suggested: a.target,
    pct: a.pctBelow,
    every: a.every,
    info: `Editing the alert for <b>“${esc(a.q)}”</b> (currently ${alertCondText(a)}).`,
  });
}

async function checkAlert(a, seed) {
  if (a.target == null && !a.every) return []; // %-below-going-rate alerts are evaluated by the server tracker
  const p = new URLSearchParams();
  const excl = (a.excl || "").split(/[,\s]+/).filter(Boolean).map((w) => "-" + w).join(" ");
  p.set("q", a.q + (excl ? " " + excl : ""));
  p.set("limit", "50");
  p.set("sort", "newlyListed");
  if (a.cat) p.set("category_ids", a.cat);
  if (a.target != null) p.set("filter", `price:[..${a.target}],priceCurrency:${a.currency}`);
  const data = await ebayGET("/buy/browse/v1/item_summary/search?" + p.toString(), true);
  const hiddenSet = new Set(getHidden());
  const blockedSet = new Set(getBlocked());
  const items = (data.itemSummaries || []).map(normalize)
    .filter((x) => x.price != null && !hiddenSet.has(x.id) && !blockedSet.has(x.seller.name));
  const seen = new Set(a.seen || []);
  const matches = [];
  for (const x of items) {
    const total = x.shippingKnown ? x.total : x.price; // shipping unknown → judge by item price
    if (!a.every && (total == null || total > a.target)) continue;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    if (!seed) matches.push(x);
  }
  a.seen = Array.from(seen).slice(-400);
  a.lastRunAt = Date.now();
  if (!seed && matches.length) a.hits = (a.hits || 0) + matches.length;
  return matches;
}

async function checkDealAlerts(auto) {
  if (isCheckingAlerts) return;
  const alerts = getAlerts();
  if (!alerts.length || !settingsReady()) return;
  isCheckingAlerts = true;
  // stay quiet when a watch-refresh summary is on screen — don't stomp it
  const quiet = auto || getWatch().length > 0;
  if (!quiet) showWatchStatus(`Checking ${alerts.length} deal alert${alerts.length === 1 ? "" : "s"}…`, "busy");
  const found = [];
  for (const a of alerts) {
    try {
      (await checkAlert(a, false)).forEach((x) => found.push({ a, x }));
    } catch (err) {
      const m = String(err && err.message || "");
      if (m === "RATE_LIMIT" || m === "BAD_KEYS" || m === "PROXY_DOWN") break; // fatal — stop here
    }
  }
  // merge into a fresh read — the user may have edited/deleted alerts mid-check
  const cur = getAlerts();
  for (const a of alerts) {
    const m = cur.find((x) => x.id === a.id);
    if (m) { m.seen = a.seen; m.lastRunAt = a.lastRunAt; m.hits = a.hits; }
  }
  lsSet(K.alerts, cur);
  renderAlerts();
  isCheckingAlerts = false;
  if (found.length) {
    const lines = found.map(({ a, x }) =>
      `${x.title.length > 44 ? x.title.slice(0, 44) + "…" : x.title} — ${money(x.shippingKnown ? x.total : x.price, x.currency)}${a.target != null ? ` (target ${money(a.target, a.currency)})` : " (new listing)"}`);
    showWatchStatus(`🔔 ${found.length} new listing${found.length === 1 ? "" : "s"} under target! Click the alert to see them, newest first.`, "ok");
    pushNote(`Tokubai — ${found.length} new deal${found.length === 1 ? "" : "s"} under your target 🔔`, lines, "tokubai-alerts");
  } else if (!quiet) {
    showWatchStatus("Alerts checked — nothing new under target yet.", "ok");
  }
}

function runAlertSearch(id) {
  const a = getAlerts().find((x) => x.id === id);
  if (!a) return;
  $("#q").value = a.q;
  aspectSel = {}; dominantCat = null; // refinements belong to the previous query
  // restore the alert's snapshotted filters so the view matches what the tracker checks
  $("#fCat").value = a.cat || "";
  $("#fCond").value = a.cond || "";
  $("#fMin").value = a.min != null ? a.min : "";
  $("#fMax").value = a.target != null ? a.target : (a.max != null ? a.max : "");
  $("#fExclude").value = a.excl || "";
  $("#fSort").value = "newest";
  switchTab("search");
  runScan(a.q, false, true);
}

function deleteAlert(id) {
  lsSet(K.alerts, getAlerts().filter((x) => x.id !== id));
  renderAlerts();
  showWatchStatus("Alert deleted.", "ok");
}

function openTargetDialog(id) {
  const w = getWatch().find((x) => x.id === id);
  if (!w) return;
  const info = liveInfo.get(id);
  openAlertDialog({
    mode: "watchtarget",
    id,
    suggested: w.target != null ? w.target : (w.lastTotal != null ? Math.round(w.lastTotal * 0.9 * 100) / 100 : ""),
    info: `Snipe target for <b>${esc(info ? info.title : "item " + (legacyIdOf(id) || id))}</b>. Auctions ending soon get flagged UNDER TARGET while the bid is at or below this. Enter 0 to clear.`,
  });
}

$("#marketStrip").addEventListener("click", (e) => { if (e.target.closest("#mkAlert")) createAlertFromScan(); });

/* ============================================================
   24/7 SERVER TRACKER — talks to the worker's admin API
   ============================================================ */
function trackerLine(msg, cls) {
  const el = $("#trackerLine");
  el.textContent = msg;
  el.className = "status-inline" + (cls ? " " + cls : "");
}

function unb64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function workerAPI(method, path, body) {
  settings = readSettingsForm();
  lsSet(K.settings, settings);
  if (!settings.proxy) throw new Error("Set the worker/proxy URL in the eBay API section first.");
  if (!settings.adminToken) throw new Error("Enter the worker admin token first (must match the ADMIN_TOKEN secret).");
  const res = await fetch(settings.proxy + path, {
    method,
    headers: { "Authorization": "Bearer " + settings.adminToken, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error("Couldn't reach the worker — check the URL and that the latest worker.js is deployed."); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Worker error " + res.status);
  return data;
}

$("#syncTrackers").addEventListener("click", async () => {
  try {
    const alerts = getAlerts();
    if (!alerts.length) { trackerLine("No deal alerts to sync — save one from the market strip after a scan.", "err"); return; }
    trackerLine("Syncing…");
    // config only: keyword + filters + thresholds — never listing data
    const r = await workerAPI("PUT", "/api/trackers", alerts.map((a) => ({
      id: a.id, q: a.q,
      ceiling: a.target != null ? a.target : null,
      pctBelow: a.pctBelow != null ? a.pctBelow : null,
      every: !!a.every,
      categoryId: a.cat || null, condition: a.cond || null,
      minPrice: a.min != null ? a.min : null, maxPrice: a.max != null ? a.max : null,
      exclude: a.excl || "", currency: a.currency || "USD", enabled: true,
    })));
    trackerLine(`Synced ${r.count} tracker${r.count === 1 ? "" : "s"} ✓${r.capped ? " (capped at 8 to protect the API budget)" : ""} — the worker polls them on every cron tick.`, "ok");
  } catch (e) { trackerLine(e.message, "err"); }
});

$("#pushEnable").addEventListener("click", async () => {
  try {
    settings = readSettingsForm(); // pick up a just-typed worker URL/token without requiring Save first
    lsSet(K.settings, settings);
    if (!settings.proxy) throw new Error("Set the worker/proxy URL in the eBay API section first.");
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser doesn't support Web Push. On iPhone, install the app to the home screen first.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications are blocked for this site — allow them in browser settings.");
    trackerLine("Subscribing this device…");
    const reg = await navigator.serviceWorker.ready;
    const vapid = await fetch(settings.proxy + "/api/vapid").then((r) => r.json()).catch(() => null);
    if (!vapid || !vapid.publicKey) throw new Error("Worker has no VAPID keys — run `node webpush-keys.js` and add the two secrets (see README).");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(vapid.publicKey) });
    const r = await workerAPI("POST", "/api/push/subscribe", sub.toJSON());
    trackerLine(`Push enabled on this device ✓ (${r.devices} device${r.devices === 1 ? "" : "s"} registered). Hit “Test notification” to confirm delivery.`, "ok");
  } catch (e) { trackerLine(e.message, "err"); }
});

$("#testNotify").addEventListener("click", async () => {
  try {
    trackerLine("Sending test…");
    const r = await workerAPI("POST", "/api/test-notify");
    const ok = r.results.some((s) => s.endsWith("ok"));
    trackerLine(r.results.length
      ? "Test sent → " + r.results.join(", ")
      : "No channels configured — enable push here or set the NTFY_TOPIC variable on the worker.", ok ? "ok" : "err");
  } catch (e) { trackerLine(e.message, "err"); }
});

$("#trackerStatus").addEventListener("click", async () => {
  try {
    trackerLine("Fetching status…");
    const s = await workerAPI("GET", "/api/status");
    const per = s.trackers.map((t) => `“${t.q}” ${t.baselineMedian != null ? "going ~" + money(t.baselineMedian) : (t.pctBelow != null ? "baseline pending" : "ceiling only")}`);
    trackerLine(
      `${s.trackers.length} tracker${s.trackers.length === 1 ? "" : "s"} · ` +
      `last poll ${s.lastRunAt ? timeAgo(Date.parse(s.lastRunAt)) : "never — is the cron trigger added?"} · ` +
      `${s.pushDevices} push device${s.pushDevices === 1 ? "" : "s"} · ntfy ${s.ntfy ? "on" : "off"} · ` +
      `≈${s.estCallsPerDay.toLocaleString()} eBay calls/day at 2-min polling` +
      (per.length ? " · " + per.join(" · ") : ""), "ok");
  } catch (e) { trackerLine(e.message, "err"); }
});

/* ============================================================
   PROFIT CALCULATOR — per listing, fees + processing + promoted
   ============================================================ */
let calcItem = null;

function openCalc(id) {
  const x = results.find((r) => r.id === id) || liveInfo.get(id);
  if (!x || x.total == null) return;
  calcItem = x;
  $("#calcInfo").innerHTML = `<b>${esc(x.title.length > 60 ? x.title.slice(0, 60) + "…" : x.title)}</b><br>Buy total (item + shipping): <b>${money(x.total, x.currency)}</b>${x.shippingKnown ? "" : " (shipping unknown — item price only)"}`;
  $("#calcResale").value = soldStats ? soldStats.median.toFixed(2) : market ? market.median.toFixed(2) : "";
  $("#calcFee").value = settings.feePct;
  $("#calcProc").value = settings.procPct;
  $("#calcProcFixed").value = settings.procFixed;
  $("#calcPromo").value = settings.promoPct;
  $("#calcShip").value = settings.shipOut;
  recalcProfit();
  $("#calcDlg").showModal();
  $("#calcResale").select();
}

function recalcProfit() {
  const x = calcItem;
  if (!x) return;
  const resale = parseFloat($("#calcResale").value) || 0;
  const fvf = resale * ((parseFloat($("#calcFee").value) || 0) / 100);
  const promo = resale * ((parseFloat($("#calcPromo").value) || 0) / 100);
  const proc = resale * ((parseFloat($("#calcProc").value) || 0) / 100) + (parseFloat($("#calcProcFixed").value) || 0);
  const ship = parseFloat($("#calcShip").value) || 0;
  const profit = resale - fvf - promo - proc - ship - x.total;
  const roi = x.total > 0 ? (profit / x.total) * 100 : 0;
  const el = $("#calcProfit");
  el.textContent = money(profit, x.currency);
  el.className = "calc-big " + (profit >= 0 ? "pos" : "neg");
  $("#calcRoi").textContent = (roi >= 0 ? "+" : "") + roi.toFixed(1) + "% ROI";
  $("#calcBreakdown").textContent =
    `Fees: ${money(fvf + promo + proc, x.currency)} (FVF ${money(fvf, x.currency)} + promoted ${money(promo, x.currency)} + processing ${money(proc, x.currency)}) · shipping ${money(ship, x.currency)} · cost ${money(x.total, x.currency)}`;
}
$("#calcDlg").addEventListener("input", recalcProfit);

/* ============================================================
   WATCH BY ITEM ID
   ============================================================ */
$("#addById").addEventListener("click", () => {
  if (!settingsReady()) { showWatchStatus("Connect your eBay API key in Settings first.", "err"); return; }
  $("#idInput").value = "";
  $("#idDlg").showModal();
});

$("#idDlg").addEventListener("close", async () => {
  if ($("#idDlg").returnValue !== "save") return;
  let id = $("#idInput").value.trim();
  if (!id) return;
  if (/^\d+$/.test(id)) id = `v1|${id}|0`; // plain listing number → API format
  if (isWatched(id)) { showWatchStatus("That item is already on your watchlist.", ""); return; }
  showWatchStatus("Fetching listing…", "busy");
  try {
    const it = await ebayGET("/buy/browse/v1/item/" + encodeURIComponent(id), true);
    const fresh = normalize({ ...it, itemId: id, itemWebUrl: it.itemWebUrl || itemUrlFromId(id) });
    liveInfo.set(id, fresh);
    const list = getWatch();
    list.unshift({ id, savedAt: Date.now(), savedTotal: fresh.total, lastTotal: fresh.total, checkedAt: Date.now(), hist: fresh.total != null ? [{ t: Date.now(), v: fresh.total }] : [] });
    lsSet(K.watch, list.slice(0, 60));
    watchIdsInvalidate();
    updateWatchCount();
    renderWatch();
    showWatchStatus(`Added “${fresh.title.length > 60 ? fresh.title.slice(0, 60) + "…" : fresh.title}” to the watchlist.`, "ok");
  } catch (e) {
    const m = String(e && e.message || "");
    showWatchStatus(m === "API_404" || m === "API_400" ? "No live listing found for that item ID." : friendlyError(e), "err");
  }
});

$("#snipeWin").addEventListener("change", (e) => { lsSet(K.snipe, e.target.value); renderSnipe(); });

/* ============================================================
   MULTI-QUERY DASHBOARD — every deal alert as a live column
   ============================================================ */
const dashData = new Map(); // alertId → normalized items (session only — data rule)

function dashColHTML(a, items) {
  return `<div class="dash-col">
    <div class="dash-head" data-runalert="${esc(a.id)}" role="button" title="Open this search, newest first"><b>${esc(a.q)}</b><span class="dim">${alertCondText(a)}</span></div>
    ${items
      ? (items.map((x) => {
          const t = x.shippingKnown ? x.total : x.price;
          const under = t != null && a.target != null && t <= a.target;
          return `<a class="dash-row${under ? " under" : ""}" href="${esc(x.url)}" target="_blank" rel="noopener">
            <span class="dash-title">${esc(x.title)}</span>
            <span class="dash-price">${money(t, x.currency)}</span>
            <span class="dash-age">${x.listedAt ? timeAgo(x.listedAt) : ""}</span>
          </a>`;
        }).join("") || `<div class="dim dash-none">nothing live right now</div>`)
      : `<div class="skel dash-skel"></div>`}
  </div>`;
}

async function renderDashboard(force) {
  const alerts = getAlerts();
  $("#dashEmpty").hidden = alerts.length > 0;
  $("#refreshDash").hidden = alerts.length === 0;
  const grid = $("#dashGrid");
  grid.innerHTML = alerts.map((a) => dashColHTML(a, dashData.get(a.id))).join("");
  if (!alerts.length) return;
  if (!settingsReady()) { $("#dashStatus").textContent = "Connect your eBay API key in Settings first."; $("#dashStatus").className = "status err"; $("#dashStatus").hidden = false; return; }
  $("#dashStatus").hidden = true;
  const hiddenSet = new Set(getHidden());
  const blockedSet = new Set(getBlocked());
  for (const a of alerts) {
    if (!force && dashData.has(a.id)) continue;
    try {
      // same query shape as the alert check: excludes + category applied
      const excl = (a.excl || "").split(/[,\s]+/).filter(Boolean).map((w) => "-" + w).join(" ");
      const p = new URLSearchParams({ q: a.q + (excl ? " " + excl : ""), limit: "12", sort: "newlyListed" });
      if (a.cat) p.set("category_ids", a.cat);
      const data = await ebayGET("/buy/browse/v1/item_summary/search?" + p, !!force);
      dashData.set(a.id, (data.itemSummaries || []).map(normalize)
        .filter((x) => x.price != null && !hiddenSet.has(x.id) && !blockedSet.has(x.seller.name)));
      grid.innerHTML = alerts.map((al) => dashColHTML(al, dashData.get(al.id))).join("");
    } catch (e) {
      $("#dashStatus").textContent = friendlyError(e);
      $("#dashStatus").className = "status err";
      $("#dashStatus").hidden = false;
      break;
    }
  }
}
$("#refreshDash").addEventListener("click", () => renderDashboard(true));

/* ============================================================
   CSV EXPORT
   ============================================================ */
function csvCell(v) {
  v = String(v == null ? "" : v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function downloadCSV(rows, name) {
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("#exportBtn").addEventListener("click", () => {
  if (!results.length) return;
  const rows = [["Title", "Price", "Shipping", "Total", "Currency", "Condition", "Type", "Deal score", "% below median", "Est. profit", "Seller", "Feedback %", "Ends", "URL"]];
  for (const x of results) {
    const sc = scoreListing(x, market);
    rows.push([
      x.title, x.price, x.shippingKnown ? x.shipping : "", x.total, x.currency,
      x.condition, x.isAuction ? "Auction" : "Buy It Now",
      sc ? sc.score : "", sc ? Math.round(sc.discount * 100) : "",
      sc && sc.profit != null ? sc.profit.toFixed(2) : "",
      x.seller.name, x.seller.pct != null ? x.seller.pct : "",
      x.endAt ? new Date(x.endAt).toISOString() : "", x.url,
    ]);
  }
  const slug = lastQuery ? lastQuery.q.replace(/\W+/g, "-").slice(0, 40) : "results";
  downloadCSV(rows, `tokubai-scan-${slug}.csv`);
});

$("#exportWatch").addEventListener("click", () => {
  const list = getWatch();
  if (!list.length) { showWatchStatus("Nothing to export yet — watch some listings first.", "err"); return; }
  const rows = [["Title", "Saved total", "Current total", "Change", "Currency", "Condition", "Status", "Saved on", "Last checked", "Seller", "URL"]];
  for (const x of list) {
    const info = liveInfo.get(x.id); // details are live-only (data rule)
    const cur = x.lastTotal;
    rows.push([
      info ? info.title : "item " + (legacyIdOf(x.id) || x.id), x.savedTotal, cur,
      x.savedTotal != null && cur != null ? (cur - x.savedTotal).toFixed(2) : "",
      info ? info.currency : "", info ? info.condition : "", x.ended ? "Ended" : "Live",
      x.savedAt ? new Date(x.savedAt).toISOString() : "",
      x.checkedAt ? new Date(x.checkedAt).toISOString() : "",
      (info && info.seller && info.seller.name) || "", info ? info.url : itemUrlFromId(x.id),
    ]);
  }
  downloadCSV(rows, "tokubai-watchlist.csv");
});

/* ============================================================
   THEME
   ============================================================ */
let theme = lsGet(K.theme, "auto");
function applyTheme(t) {
  document.documentElement.classList.toggle("light", t === "light");
  document.documentElement.classList.toggle("dark", t === "dark");
  const btn = $("#themeBtn");
  btn.textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
  btn.title = `Theme: ${t} (click to change)`;
}
$("#themeBtn").addEventListener("click", () => {
  theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  lsSet(K.theme, theme);
  applyTheme(theme);
});

/* ============================================================
   BACKUP / RESTORE
   ============================================================ */
$("#exportData").addEventListener("click", () => {
  const payload = {
    app: "tokubai", version: 1, exportedAt: new Date().toISOString(),
    settings, watch: getWatch(), recent: lsGet(K.recent, []), hidden: getHidden(), alerts: getAlerts(), sellers: getBlocked(),
    prefs: { theme: lsGet(K.theme, "auto"), notify: lsGet(K.notify, false), auto: lsGet(K.auto, "0"), snipe: lsGet(K.snipe, "60"), wsort: lsGet(K.wsort, "saved") },
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  a.download = "tokubai-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
  setInlineStatus("Backup downloaded — it contains your API keys, keep it private.", "ok");
});

$("#importData").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = ""; // allow re-picking the same file
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== "tokubai") throw new Error("that file isn't a Tokubai backup");
    if (data.settings && typeof data.settings === "object") {
      settings = { ...DEFAULTS, ...data.settings };
      lsSet(K.settings, settings);
      localStorage.removeItem(K.token);
    }
    if (Array.isArray(data.watch)) { lsSet(K.watch, data.watch.map(stripWatchItem)); watchIdsInvalidate(); } // old backups may hold listing content — strip it (data rule)
    if (Array.isArray(data.recent)) lsSet(K.recent, data.recent);
    if (Array.isArray(data.hidden)) lsSet(K.hidden, data.hidden);
    if (Array.isArray(data.alerts)) lsSet(K.alerts, data.alerts);
    if (Array.isArray(data.sellers)) lsSet(K.sellers, data.sellers);
    if (data.prefs && typeof data.prefs === "object") {
      if (data.prefs.theme) { theme = data.prefs.theme; lsSet(K.theme, theme); applyTheme(theme); }
      if (data.prefs.notify != null) { notifyOn = !!data.prefs.notify; lsSet(K.notify, notifyOn); paintNotifyBtn(); }
      if (data.prefs.auto != null) { lsSet(K.auto, String(data.prefs.auto)); setupAutoRefresh(); }
      if (data.prefs.snipe != null) lsSet(K.snipe, String(data.prefs.snipe));
      if (data.prefs.wsort) { lsSet(K.wsort, data.prefs.wsort); $("#watchSort").value = data.prefs.wsort; }
    }
    loadSettingsForm();
    renderRecent();
    updateWatchCount();
    renderWatch();
    updateHiddenCount();
    updateBlockedCount();
    renderAlerts();
    $("#setupNudge").hidden = settingsReady();
    setInlineStatus("Backup imported ✓ — settings, watchlist, alerts, and recents restored.", "ok");
  } catch (err) {
    setInlineStatus("Import failed — " + (err && err.message ? err.message : "invalid file") + ".", "err");
  }
});

/* ============================================================
   TABS + INIT
   ============================================================ */
function switchTab(name) {
  $$(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("on", on);
    t.setAttribute("aria-selected", on);
  });
  $("#tab-search").hidden = name !== "search";
  $("#tab-dash").hidden = name !== "dash";
  $("#tab-watch").hidden = name !== "watch";
  $("#tab-settings").hidden = name !== "settings";
  if (name === "dash") renderDashboard(false);
  if (name === "watch") {
    renderWatch();
    renderAlerts();
    // details are never persisted (data rule) — hydrate live on first visit
    if (settingsReady() && getWatch().some((w) => !w.ended && !liveInfo.has(w.id))) refreshWatchPrices(true);
  }
  if (name === "settings") loadSettingsForm();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("#brandHome").addEventListener("click", (e) => { e.preventDefault(); switchTab("search"); document.title = "Tokubai — eBay Deal Scanner"; });
$("#goSettings") && $("#goSettings").addEventListener("click", () => switchTab("settings"));

// keyboard shortcuts: "/" focuses search, "r" re-runs/refreshes the current view
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "/") {
    e.preventDefault();
    switchTab("search");
    $("#q").focus();
    $("#q").select();
  } else if (e.key === "r") {
    e.preventDefault();
    if (!$("#tab-watch").hidden) { refreshWatchPrices(false); checkDealAlerts(false); }
    else if (!$("#tab-dash").hidden) renderDashboard(true);
    else if (lastQuery) runScan(lastQuery.raw, false, true);
  }
});

/* boot */
// migrate any pre-data-rule watch entries: strip cached listing content,
// keeping only ids + our own observed prices
(function migrateWatch() {
  const list = getWatch();
  if (list.length && list.some((w) => "title" in w || "img" in w || "seller" in w)) {
    lsSet(K.watch, list.map(stripWatchItem));
  }
})();
applyTheme(theme);
applyView(lsGet(K.view, "grid"));
loadSettingsForm();
renderRecent();
updateWatchCount();
$("#watchSort").value = lsGet(K.wsort, "saved"); // restore the preferred watch order
renderWatch();
updateHiddenCount();
updateBlockedCount();
renderAlerts();
paintNotifyBtn();
setupAutoRefresh();

// offline shell + install support (https or localhost only)
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* not fatal */ });
}
$("#setupNudge").hidden = settingsReady();
$("#q").focus();

// surface environment problems loudly — they masquerade as app bugs
if (!storageOK) storageBroken();
else if (location.protocol === "file:") {
  showStatus("⚠ You're opening the app as a file:// page — saved settings can reset, and install/push won't work. Serve it over http instead: run `npx serve` in this folder, or enable GitHub Pages (see README) and use that URL.", "err");
}

// arrived via a shared link? run that scan straight away
const urlQ = new URLSearchParams(location.search).get("q");
if (urlQ) {
  $("#q").value = urlQ;
  if (settingsReady()) runScan(urlQ, false);
}

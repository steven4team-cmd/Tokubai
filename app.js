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
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full/blocked */ } };

const K = { settings: "ff_settings", token: "ff_token", watch: "ff_watch", recent: "ff_recent", hidden: "ff_hidden", theme: "ff_theme", notify: "ff_notify", auto: "ff_auto" };

const DEFAULTS = { clientId: "", clientSecret: "", proxy: "", market: "EBAY_US", feePct: 13.25, shipOut: 5 };
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
const PAGE = 60;
const FALLBACK_IMG = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="#eef1ee"/><path d="M42 48 56 34h14a5 5 0 0 1 5 5v14L61 67a4 4 0 0 1-5.6 0L42 53.6a4 4 0 0 1 0-5.6Z" fill="#c9cfca"/></svg>`);

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
}
function readSettingsForm() {
  return {
    clientId: $("#sClientId").value.trim(),
    clientSecret: $("#sClientSecret").value.trim(),
    proxy: $("#sProxy").value.trim().replace(/\/+$/, ""),
    market: $("#sMarket").value,
    feePct: clamp(parseFloat($("#sFee").value) || 0, 0, 50),
    shipOut: Math.max(0, parseFloat($("#sShipOut").value) || 0),
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
  setInlineStatus("Saved ✓", "ok");
  $("#setupNudge").hidden = settingsReady();
});

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

async function ebayGET(path) {
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
  return res.json();
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
  p.set("q", q);
  p.set("limit", String(PAGE));
  p.set("offset", String(offset || 0));

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
  if (cond) filters.push(`conditions:{${cond}}`);
  const type = $("#fType").value;
  if (type) filters.push(`buyingOptions:{${type}}`);
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
  if (!mkt || x.total == null) return null;
  const discount = (mkt.median - x.total) / mkt.median;
  const dN = clamp(discount / 0.45, 0, 1);
  const pctN = x.seller.pct != null ? clamp((x.seller.pct - 95) / 5, 0, 1) : 0.4;
  const volN = clamp(x.seller.n / 500, 0, 1);
  const sN = 0.6 * pctN + 0.4 * volN;
  const score = Math.round(100 * (0.62 * dN + 0.22 * sN + 0.16 * COND_W(x.condition)));
  const tier = score >= 78 ? "hot" : score >= 62 ? "great" : score >= 48 ? "good" : "fair";
  const hot = discount >= 0.3 && mkt.count >= 8;
  let profit = null;
  if (mkt.count >= 8 && !x.isAuction) {
    const net = mkt.median * (1 - settings.feePct / 100) - settings.shipOut - x.total;
    if (net > 0) profit = net;
  }
  return { score, tier, hot, discount, profit };
}

/* ============================================================
   RENDERING
   ============================================================ */
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
  <article class="lcard${sc && sc.hot ? " hot" : ""}${o.ended ? " ended" : ""}" data-id="${esc(x.id)}">
    <div class="imgbox">
      <img src="${esc(x.img)}" alt="" loading="lazy" onerror="this.src='${FALLBACK_IMG}'" />
      ${sc ? `<span class="tag-score t-${sc.tier}" title="Deal score ${sc.score}/100 — ${Math.round(sc.discount * 100)}% vs market median">⛁ ${sc.score} ${tierLabel[sc.tier]}</span>` : ""}
      ${o.watch ? "" : `<button class="hide-btn" data-hide="${esc(x.id)}" title="Hide this listing from future scans" aria-label="Hide listing">✕</button>`}
    </div>
    <div class="body">
      <div class="badges">
        ${o.ended ? `<span class="badge gone">ENDED</span>` : ""}
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
      ${sc && sc.discount > 0.02 ? `<div class="below"><b>${Math.round(sc.discount * 100)}% below</b> market median ${money(marketRef().median, x.currency)}</div>` : ""}
      ${sc && sc.profit != null ? `<div class="profit">≈ +${money(sc.profit, x.currency)} est. profit if flipped at market</div>` : ""}
      ${o.delta != null ? `<div class="delta ${o.delta < 0 ? "down" : "up"}">${o.delta < 0 ? "▼" : "▲"} ${money(Math.abs(o.delta), x.currency)} since saved</div>` : ""}
      ${x.seller.name ? `<div class="seller">Seller <b>${esc(x.seller.name)}</b>${x.seller.pct != null ? ` · ${x.seller.pct}% (${x.seller.n.toLocaleString()})` : ""}</div>` : ""}
      ${o.checked ? `<div class="checked">↻ checked ${timeAgo(o.checked)}</div>` : ""}
    </div>
    <div class="actions">
      <a class="btn ghost" href="${esc(x.url)}" target="_blank" rel="noopener">Open listing ↗</a>
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
  const scored = results.map((x) => ({ x, sc: scoreListing(x, market) }));

  scored.sort((a, b) => {
    if (sortBy === "totalAsc") return (a.x.total ?? 1e12) - (b.x.total ?? 1e12);
    if (sortBy === "newest") return (b.x.listedAt || 0) - (a.x.listedAt || 0);
    if (sortBy === "ending") return (a.x.endAt || 9e15) - (b.x.endAt || 9e15);
    return ((b.sc && b.sc.score) || -1) - ((a.sc && a.sc.score) || -1);
  });

  grid.innerHTML = scored.map(({ x, sc }) => cardHTML(x, sc)).join("");
  $("#emptyState").hidden = results.length > 0;
  $("#exportBtn").hidden = results.length === 0;

  const strip = $("#marketStrip");
  const shown = `showing ${results.length}${totalAvail > results.length ? ` of ${totalAvail.toLocaleString()}` : ""}`;
  if (market) {
    const dealLine = market.median * 0.7;
    const hotCount = scored.filter((s) => s.sc && s.sc.hot).length;
    strip.innerHTML =
      `<span>Market read:</span> <b>${money(market.median, market.currency)}</b> <span class="dim">median · typical ${money(market.p25, market.currency)}–${money(market.p75, market.currency)} · ${market.count} comparables</span>` +
      `<span class="flag">${hotCount > 0 ? `🔥 ${hotCount} flagged below ${money(dealLine, market.currency)}` : `deals flag below ${money(dealLine, market.currency)}`}</span>` +
      `<span class="dim">${shown} · † total excludes unknown shipping</span>`;
    strip.hidden = false;
  } else {
    strip.innerHTML = results.length
      ? `<span class="dim">Not enough comparable listings to read the market — showing raw results without scores (${shown}).</span>`
      : "";
    strip.hidden = results.length === 0;
  }
}

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
  if (!append) {
    nextOffset = 0;
    results = [];
    market = null;
    totalAvail = 0;
    $("#results").innerHTML = '<div class="skel"></div>'.repeat(8);
    $("#emptyState").hidden = true;
    $("#marketStrip").hidden = true;
  }

  try {
    const data = await ebayGET(buildSearchPath(q, nextOffset));
    const items = (data.itemSummaries || []).map(normalize).filter((x) => x.price != null);
    results = append ? results.concat(items) : items;
    // de-dupe by id, drop listings the user hid
    const seen = new Set();
    const hiddenSet = new Set(getHidden());
    results = results.filter((x) => !hiddenSet.has(x.id) && (seen.has(x.id) ? false : (seen.add(x.id), true)));

    market = computeMarket(results);
    lastQuery = { raw: rawQuery, q };
    totalAvail = data.total || 0;
    nextOffset += PAGE;
    $("#moreBtn").hidden = !(data.total && nextOffset < Math.min(data.total, 600));

    renderResults();
    showStatus(results.length ? null : `No live listings matched “${q}” with these filters. Loosen the filters or reword the search.`);
    if (!append && !keepFilters) pushRecent(rawQuery);
    // make the scan shareable/bookmarkable (throws on file://, where it can't work)
    if (!append) { try { history.replaceState(null, "", "?q=" + encodeURIComponent(rawQuery)); } catch { /* noop */ } }
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
["fMin", "fMax", "fCat", "fCond", "fType"].forEach((id) => $("#" + id).addEventListener("change", () => {
  if (!lastQuery) return;
  if (isScanning) { pendingRefine = true; return; } // don't drop it — apply after the scan
  runScan(lastQuery.raw, false, true);
}));
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
  $("#recentChips").innerHTML = r.map((x) => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join("");
}
$("#recentChips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-q]");
  if (b) { $("#q").value = b.dataset.q; runScan(b.dataset.q, false); }
});
$$(".eg").forEach((b) => b.addEventListener("click", () => { $("#q").value = b.dataset.eg; switchTab("search"); runScan(b.dataset.eg, false); }));

/* ============================================================
   WATCHLIST
   ============================================================ */
function getWatch() { return lsGet(K.watch, []); }
function isWatched(id) { return getWatch().some((w) => w.id === id); }

function toggleWatch(id) {
  let list = getWatch();
  if (list.some((w) => w.id === id)) {
    list = list.filter((w) => w.id !== id);
  } else {
    const x = results.find((r) => r.id === id);
    if (!x) return;
    list.unshift({ ...x, savedAt: Date.now(), savedTotal: x.total, lastTotal: x.total, checkedAt: null });
    if (list.length > 60) list = list.slice(0, 60);
  }
  lsSet(K.watch, list);
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
  const w = e.target.closest("[data-watch]");
  if (w) toggleWatch(w.dataset.watch);
});

/* ---------- hidden listings ---------- */
function getHidden() { return lsGet(K.hidden, []); }
function updateHiddenCount() { const el = $("#hiddenCount"); if (el) el.textContent = getHidden().length; }
function hideListing(id) {
  const hidden = getHidden();
  if (!hidden.includes(id)) hidden.unshift(id);
  lsSet(K.hidden, hidden.slice(0, 500));
  results = results.filter((x) => x.id !== id);
  market = computeMarket(results); // scores shift when a comparable disappears
  renderResults();
  updateHiddenCount();
}
$("#clearHidden").addEventListener("click", () => {
  lsSet(K.hidden, []);
  updateHiddenCount();
  setInlineStatus("Hidden listings cleared — they'll show up in scans again.", "ok");
});

function updateWatchCount() {
  const n = getWatch().length;
  const el = $("#watchCount");
  el.textContent = n;
  el.hidden = n === 0;
}

function renderWatch() {
  const list = getWatch();
  const grid = $("#watchGrid");
  _marketRef = null; // watch cards don't show market lines
  grid.innerHTML = list.map((x) => {
    const delta = x.checkedAt != null && x.savedTotal != null && x.lastTotal != null && x.lastTotal !== x.savedTotal
      ? x.lastTotal - x.savedTotal : null;
    return cardHTML({ ...x, total: x.lastTotal != null ? x.lastTotal : x.total }, null, { delta, ended: !!x.ended, watch: true, checked: x.checkedAt });
  }).join("");
  $("#watchEmpty").hidden = list.length > 0;
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
        const it = await ebayGET("/buy/browse/v1/item/" + encodeURIComponent(w.id));
        const fresh = normalize({ ...it, itemId: w.id, itemWebUrl: it.itemWebUrl || w.url });
        const prev = w.lastTotal != null ? w.lastTotal : w.savedTotal;
        w.lastTotal = fresh.total != null ? fresh.total : w.lastTotal;
        w.price = fresh.price != null ? fresh.price : w.price;
        w.shipping = fresh.shipping; w.shippingKnown = fresh.shippingKnown;
        w.endAt = fresh.endAt || w.endAt;
        w.checkedAt = Date.now();
        // ended listings can still answer with 200 — catch them by end date
        if (w.endAt && w.endAt < Date.now()) { w.ended = true; gone++; }
        else if (fresh.total != null && prev != null && fresh.total < prev - 0.005) {
          drops.push(`${w.title.length > 48 ? w.title.slice(0, 48) + "…" : w.title} — now ${money(fresh.total, w.currency)} (was ${money(prev, w.currency)})`);
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

  lsSet(K.watch, list);
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

$("#refreshWatch").addEventListener("click", () => refreshWatchPrices(false));

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

function notifyDrops(drops) {
  if (!drops.length || !notifyOn) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(`Tokubai — ${drops.length} price drop${drops.length === 1 ? "" : "s"} 🔻`, {
      body: drops.slice(0, 4).join("\n") + (drops.length > 4 ? `\n…and ${drops.length - 4} more` : ""),
      tag: "tokubai-drops", // replaces the previous alert instead of stacking
    });
  } catch { /* some platforms need a service worker for this — alert shown in-app anyway */ }
}

/* ---------- auto-refresh ---------- */
let autoTimer = null;

function setupAutoRefresh() {
  clearInterval(autoTimer);
  const mins = parseInt(lsGet(K.auto, "0"), 10) || 0;
  $("#autoRefresh").value = String(mins);
  if (mins > 0) {
    autoTimer = setInterval(() => {
      if (getWatch().some((w) => !w.ended)) refreshWatchPrices(true);
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
  updateWatchCount();
  renderWatch();
  showWatchStatus(`Removed ${removed} ended listing${removed === 1 ? "" : "s"}.`, "ok");
});

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
    const cur = x.lastTotal != null ? x.lastTotal : x.total;
    rows.push([
      x.title, x.savedTotal, cur,
      x.savedTotal != null && cur != null ? (cur - x.savedTotal).toFixed(2) : "",
      x.currency, x.condition, x.ended ? "Ended" : "Live",
      x.savedAt ? new Date(x.savedAt).toISOString() : "",
      x.checkedAt ? new Date(x.checkedAt).toISOString() : "",
      x.seller && x.seller.name, x.url,
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
    settings, watch: getWatch(), recent: lsGet(K.recent, []), hidden: getHidden(),
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
    if (Array.isArray(data.watch)) lsSet(K.watch, data.watch);
    if (Array.isArray(data.recent)) lsSet(K.recent, data.recent);
    if (Array.isArray(data.hidden)) lsSet(K.hidden, data.hidden);
    loadSettingsForm();
    renderRecent();
    updateWatchCount();
    renderWatch();
    updateHiddenCount();
    $("#setupNudge").hidden = settingsReady();
    setInlineStatus("Backup imported ✓ — settings, watchlist, and recents restored.", "ok");
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
  $("#tab-watch").hidden = name !== "watch";
  $("#tab-settings").hidden = name !== "settings";
  if (name === "watch") renderWatch();
  if (name === "settings") loadSettingsForm();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("#brandHome").addEventListener("click", (e) => { e.preventDefault(); switchTab("search"); });
$("#goSettings") && $("#goSettings").addEventListener("click", () => switchTab("settings"));

// press "/" anywhere to jump to the search box
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  e.preventDefault();
  switchTab("search");
  $("#q").focus();
  $("#q").select();
});

/* boot */
applyTheme(theme);
loadSettingsForm();
renderRecent();
updateWatchCount();
renderWatch();
updateHiddenCount();
paintNotifyBtn();
setupAutoRefresh();
$("#setupNudge").hidden = settingsReady();
$("#q").focus();

// arrived via a shared link? run that scan straight away
const urlQ = new URLSearchParams(location.search).get("q");
if (urlQ) {
  $("#q").value = urlQ;
  if (settingsReady()) runScan(urlQ, false);
}

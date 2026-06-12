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

const K = { settings: "ff_settings", token: "ff_token", watch: "ff_watch", recent: "ff_recent" };

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
let isScanning = false;      // prevents concurrent scans
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

async function getToken() {
  const cached = lsGet(K.token, null);
  if (cached && cached.exp > Date.now() + 5 * 60 * 1000) return cached.token;

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
  const fMax = parseFloat($("#fMax").value);
  if (!isNaN(fMax) && fMax > 0) {
    filters.push(`price:[..${fMax}]`);
    filters.push(`priceCurrency:${marketCurrency()}`);
  }
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
  const totals = list.filter((x) => x.total != null).map((x) => x.total).sort((a, b) => a - b);
  if (totals.length < 6) return null;
  const mid = Math.floor(totals.length / 2);
  const median = totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
  return { median, count: totals.length, currency: (list[0] && list[0].currency) || marketCurrency() };
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
  <article class="lcard${sc && sc.hot ? " hot" : ""}" data-id="${esc(x.id)}">
    <div class="imgbox">
      <img src="${esc(x.img)}" alt="" loading="lazy" onerror="this.src='${FALLBACK_IMG}'" />
      ${sc ? `<span class="tag-score t-${sc.tier}" title="Deal score ${sc.score}/100 — ${Math.round(sc.discount * 100)}% vs market median">⛁ ${sc.score} ${tierLabel[sc.tier]}</span>` : ""}
    </div>
    <div class="body">
      <div class="badges">
        ${x.condition ? `<span class="badge">${esc(x.condition)}</span>` : ""}
        ${x.isAuction ? `<span class="badge auction">AUCTION · bid</span>` : (x.isBIN ? `<span class="badge">BUY IT NOW</span>` : "")}
        ${endingSoon ? `<span class="badge ending">⏱ ${timeLeft(x.endAt)}</span>` : (x.isAuction && x.endAt ? `<span class="badge">${timeLeft(x.endAt)}</span>` : "")}
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

  const strip = $("#marketStrip");
  if (market) {
    const dealLine = market.median * 0.7;
    const hotCount = scored.filter((s) => s.sc && s.sc.hot).length;
    strip.innerHTML =
      `<span>Market read:</span> <b>${money(market.median, market.currency)}</b> <span class="dim">median across ${market.count} live listings</span>` +
      `<span class="flag">${hotCount > 0 ? `🔥 ${hotCount} flagged below ${money(dealLine, market.currency)}` : `deals flag below ${money(dealLine, market.currency)}`}</span>` +
      `<span class="dim">† total excludes unknown shipping</span>`;
    strip.hidden = false;
  } else {
    strip.innerHTML = results.length
      ? `<span class="dim">Not enough comparable listings to read the market — showing raw results without scores.</span>`
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
async function runScan(rawQuery, append) {
  if (isScanning) return;
  const { q, max } = parseQuery(rawQuery);
  if (!q) return;
  if (!settingsReady()) {
    showStatus(“Connect your eBay API key first — open Settings (top right). Setup takes about five minutes.”, “err”);
    switchTab(“settings”);
    return;
  }
  if (max != null) $(“#fMax”).value = max;

  const btn = $(“#scanBtn”);
  const moreBtn = $(“#moreBtn”);
  isScanning = true;
  btn.disabled = true;
  moreBtn.disabled = true;
  showStatus(append ? “Loading more…” : `Scanning eBay for “${q}”…`, “busy”);
  if (!append) {
    nextOffset = 0;
    results = [];
    $("#results").innerHTML = '<div class="skel"></div>'.repeat(8);
    $("#emptyState").hidden = true;
    $("#marketStrip").hidden = true;
  }

  try {
    const data = await ebayGET(buildSearchPath(q, nextOffset));
    const items = (data.itemSummaries || []).map(normalize).filter((x) => x.price != null);
    results = append ? results.concat(items) : items;
    // de-dupe by id
    const seen = new Set();
    results = results.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));

    market = computeMarket(results);
    lastQuery = { raw: rawQuery, q };
    nextOffset += PAGE;
    $("#moreBtn").hidden = !(data.total && nextOffset < Math.min(data.total, 600));

    renderResults();
    showStatus(results.length ? null : `No live listings matched “${q}” with these filters. Loosen the filters or reword the search.`);
    if (!append) pushRecent(rawQuery);
  } catch (e) {
    if (!append) { results = []; renderResults(); }
    showStatus(friendlyError(e), "err");
  } finally {
    isScanning = false;
    btn.disabled = false;
    moreBtn.disabled = false;
  }
}

$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); runScan($("#q").value, false); });
$("#moreBtn").addEventListener("click", () => lastQuery && runScan(lastQuery.raw, true));
["fMax", "fCat", "fCond", "fType"].forEach((id) => $("#" + id).addEventListener("change", () => lastQuery && runScan(lastQuery.raw, false)));
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
  const w = e.target.closest("[data-watch]");
  if (w) toggleWatch(w.dataset.watch);
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
    return cardHTML({ ...x, total: x.lastTotal != null ? x.lastTotal : x.total }, null, { delta });
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

$("#refreshWatch").addEventListener("click", async () => {
  const list = getWatch();
  if (!list.length) return;
  if (!settingsReady()) { showWatchStatus("Connect your eBay API key in Settings first.", "err"); return; }
  const btn = $("#refreshWatch");
  btn.disabled = true;
  let done = 0, gone = 0;
  for (const w of list) {
    showWatchStatus(`Re-checking prices… ${++done} of ${list.length}`, "busy");
    try {
      const it = await ebayGET("/buy/browse/v1/item/" + encodeURIComponent(w.id));
      const fresh = normalize({ ...it, itemId: w.id, itemWebUrl: it.itemWebUrl || w.url });
      w.lastTotal = fresh.total != null ? fresh.total : w.lastTotal;
      w.price = fresh.price != null ? fresh.price : w.price;
      w.shipping = fresh.shipping; w.shippingKnown = fresh.shippingKnown;
      w.endAt = fresh.endAt || w.endAt;
      w.checkedAt = Date.now();
    } catch (err) {
      const m = String(err && err.message || "");
      if (m === "API_404" || m === "API_410") { w.ended = true; gone++; w.checkedAt = Date.now(); }
      else if (m === "RATE_LIMIT" || m === "BAD_KEYS" || m === "PROXY_DOWN") { showWatchStatus(friendlyError(err), "err"); btn.disabled = false; lsSet(K.watch, list); renderWatch(); return; }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  lsSet(K.watch, list);
  renderWatch();
  showWatchStatus(`Done — ${list.length} checked${gone ? `, ${gone} no longer live (sold or ended)` : ""}. ▼ green means the price dropped.`, "ok");
  btn.disabled = false;
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

/* boot */
loadSettingsForm();
renderRecent();
updateWatchCount();
renderWatch();
$("#setupNudge").hidden = settingsReady();
$("#q").focus();

/* ============================================================
   Tokubai Worker — CORS proxy + 24/7 new-listing deal tracker
   ------------------------------------------------------------
   Roles:
   1. CORS proxy for the browser app (GET/POST /?url=...) — unchanged.
   2. Cron-triggered tracker: polls saved keyword trackers with
      sort=newlyListed, compares new listings against a cached
      median "going rate", and notifies via Web Push + ntfy.sh.
   3. Admin API (Bearer ADMIN_TOKEN) for the app to manage
      trackers, push subscriptions, and check status.

   DATA RULE: KV stores ONLY tracker configs (keywords/filters),
   bare item IDs, watermark timestamps, and median price numbers.
   Listing content is never persisted — fetched live each poll,
   used, and discarded.

   ---------- ONE-TIME SETUP (dash.cloudflare.com) ----------
   1. Workers & Pages → your worker → Settings → Bindings:
        KV namespace binding, name: TRACKER  (create a namespace)
   2. Settings → Variables & secrets (all as SECRETS except noted):
        EBAY_CLIENT_ID      your production App ID
        EBAY_CLIENT_SECRET  your production Cert ID
        ADMIN_TOKEN         any long random string (also goes in app Settings)
        VAPID_PUBLIC_KEY    from: node webpush-keys.js
        VAPID_PRIVATE_KEY   from: node webpush-keys.js
        VAPID_SUBJECT       plain var, e.g. mailto:you@example.com
        NTFY_TOPIC          plain var, optional, e.g. tokubai-yourname-x7k2
        EBAY_MARKETPLACE    plain var, optional, default EBAY_US
   3. Settings → Triggers → Cron Triggers: add a trigger that
      runs every 2 minutes (exact expression is in the README —
      it can't be written inside this comment block)
   ============================================================ */

const ALLOWED_HOSTS = new Set(["api.ebay.com"]);
const FORWARD_HEADERS = ["authorization", "content-type", "x-ebay-c-marketplace-id", "x-ebay-c-enduserctx"];
const MAX_TRACKERS = 8;           // keeps the daily call budget sane at 2-min polling
const BASELINE_TTL_MS = 6 * 3600e3;
const NOTIFY_CAP = 5;             // max notifications per cron run

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));
    if (url.pathname.startsWith("/api/")) return handleAPI(request, env, url);
    return handleProxy(request, url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTrackers(env));
  },
};

/* ============================================================
   CORS proxy (unchanged behavior)
   ============================================================ */
function withCORS(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  headers.set("Access-Control-Allow-Headers", FORWARD_HEADERS.join(","));
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers });
}

async function handleProxy(request, url) {
  const target = url.searchParams.get("url");
  if (!target) {
    return withCORS(new Response("Missing ?url= parameter. This is the Tokubai worker — proxy + tracker are working. Paste this URL into Tokubai's Settings.", { status: 200 }));
  }
  let dest;
  try { dest = new URL(target); } catch { return withCORS(new Response("Invalid url parameter", { status: 400 })); }
  if (dest.protocol !== "https:" || !ALLOWED_HOSTS.has(dest.hostname)) {
    return withCORS(new Response("Host not allowed", { status: 403 }));
  }
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const upstream = await fetch(dest.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
  });
  return withCORS(upstream);
}

/* ============================================================
   Admin API
   ============================================================ */
const json = (data, status = 200) => withCORS(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }));

function authed(request, env) {
  return env.ADMIN_TOKEN && request.headers.get("authorization") === "Bearer " + env.ADMIN_TOKEN;
}

async function handleAPI(request, env, url) {
  const path = url.pathname;

  // public: the app needs this to subscribe to push
  if (path === "/api/vapid" && request.method === "GET") {
    return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  }

  if (!authed(request, env)) return json({ error: "unauthorized — set ADMIN_TOKEN on the worker and in app Settings" }, 401);
  if (!env.TRACKER) return json({ error: "KV binding TRACKER is missing — add it in worker Settings → Bindings" }, 500);

  if (path === "/api/trackers" && request.method === "GET") {
    return json({ trackers: (await env.TRACKER.get("cfg:trackers", "json")) || [] });
  }

  if (path === "/api/trackers" && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (!Array.isArray(body)) return json({ error: "expected an array of trackers" }, 400);
    const trackers = body.slice(0, MAX_TRACKERS).map((t) => ({
      id: String(t.id || Date.now()),
      q: String(t.q || "").trim(),
      ceiling: t.ceiling != null ? Number(t.ceiling) : null,
      pctBelow: t.pctBelow != null ? Number(t.pctBelow) : null,
      every: t.every === true,
      categoryId: t.categoryId || null,
      condition: t.condition || null,
      minPrice: t.minPrice != null ? Number(t.minPrice) : null,
      maxPrice: t.maxPrice != null ? Number(t.maxPrice) : null,
      exclude: String(t.exclude || ""),
      currency: t.currency || "USD",
      enabled: t.enabled !== false,
    })).filter((t) => t.q && (t.ceiling != null || t.pctBelow != null || t.every));
    await env.TRACKER.put("cfg:trackers", JSON.stringify(trackers));
    return json({ ok: true, count: trackers.length, capped: body.length > MAX_TRACKERS });
  }

  if (path === "/api/push/subscribe" && request.method === "POST") {
    const sub = await request.json().catch(() => null);
    if (!sub || !sub.endpoint || !sub.keys) return json({ error: "invalid subscription" }, 400);
    const subs = (await env.TRACKER.get("subs", "json")) || {};
    subs[await hashStr(sub.endpoint)] = sub;
    await env.TRACKER.put("subs", JSON.stringify(subs));
    return json({ ok: true, devices: Object.keys(subs).length });
  }

  if (path === "/api/push/unsubscribe" && request.method === "POST") {
    const sub = await request.json().catch(() => null);
    const subs = (await env.TRACKER.get("subs", "json")) || {};
    if (sub && sub.endpoint) delete subs[await hashStr(sub.endpoint)];
    await env.TRACKER.put("subs", JSON.stringify(subs));
    return json({ ok: true, devices: Object.keys(subs).length });
  }

  if (path === "/api/test-notify" && request.method === "POST") {
    const results = await notify(env, [{
      title: "Tokubai test notification 🔔",
      body: "Server tracker can reach this device. You're all set.",
      url: "https://www.ebay.com",
      tag: "tokubai-test",
    }]);
    return json({ ok: true, results });
  }

  if (path === "/api/run" && request.method === "POST") {
    const summary = await runTrackers(env);
    return json({ ok: true, ...summary });
  }

  if (path === "/api/status" && request.method === "GET") {
    const cfg = (await env.TRACKER.get("cfg:trackers", "json")) || [];
    const state = (await env.TRACKER.get("state", "json")) || {};
    const subs = (await env.TRACKER.get("subs", "json")) || {};
    return json({
      trackers: cfg.map((t) => {
        const ts = state[t.id] || {};
        return {
          q: t.q, enabled: t.enabled, ceiling: t.ceiling, pctBelow: t.pctBelow,
          baselineMedian: ts.baseline ? ts.baseline.median : null,
          baselineComps: ts.baseline ? ts.baseline.n : 0,
          baselineAgeMin: ts.baseline ? Math.round((Date.now() - ts.baseline.at) / 60000) : null,
          watermark: ts.watermark ? new Date(ts.watermark).toISOString() : null,
        };
      }),
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      pushDevices: Object.keys(subs).length,
      ntfy: !!env.NTFY_TOPIC,
      estCallsPerDay: cfg.filter((t) => t.enabled !== false).length * 720 + cfg.length * 4,
    });
  }

  return json({ error: "not found" }, 404);
}

/* ============================================================
   eBay (server-side, credentials never leave the worker)
   ============================================================ */
async function ebayToken(env) {
  const cached = await env.TRACKER.get("ebay_token", "json");
  if (cached && cached.exp > Date.now() + 5 * 60 * 1000) return cached.token;
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(env.EBAY_CLIENT_ID + ":" + env.EBAY_CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error("token " + res.status);
  const data = await res.json();
  await env.TRACKER.put("ebay_token", JSON.stringify({ token: data.access_token, exp: Date.now() + (data.expires_in || 7200) * 1000 }));
  return data.access_token;
}

// live search; results are used and discarded — never stored (data rule)
async function ebaySearch(env, t, { newest, limit }) {
  const token = await ebayToken(env);
  const p = new URLSearchParams();
  const excl = (t.exclude || "").split(/[,\s]+/).filter(Boolean).map((w) => "-" + w).join(" ");
  p.set("q", t.q + (excl ? " " + excl : ""));
  p.set("limit", String(limit));
  if (newest) p.set("sort", "newlyListed");
  if (t.categoryId) p.set("category_ids", String(t.categoryId));
  const f = ["buyingOptions:{FIXED_PRICE}"]; // auctions' early bids poison both baseline and alerts
  const lo = t.minPrice, hi = t.maxPrice;
  if (lo != null && hi != null) f.push(`price:[${lo}..${hi}]`);
  else if (lo != null) f.push(`price:[${lo}]`);
  else if (hi != null) f.push(`price:[..${hi}]`);
  if (lo != null || hi != null) f.push(`priceCurrency:${t.currency || "USD"}`);
  if (t.condition) f.push(/^\d/.test(t.condition) ? `conditionIds:{${t.condition}}` : `conditions:{${t.condition}}`);
  p.set("filter", f.join(","));

  const res = await fetch("https://api.ebay.com/buy/browse/v1/item_summary/search?" + p, {
    headers: {
      "Authorization": "Bearer " + token,
      "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE || "EBAY_US",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=" + encodeURIComponent("country=" + ((env.EBAY_MARKETPLACE || "EBAY_US").slice(-2) === "US" ? "US" : (env.EBAY_MARKETPLACE || "EBAY_US").slice(-2))),
    },
  });
  if (res.status === 401) { await env.TRACKER.put("ebay_token", "{}"); throw new Error("auth 401"); }
  if (!res.ok) throw new Error("search " + res.status);
  const data = await res.json();
  return (data.itemSummaries || []).map((it) => {
    const price = it.price ? parseFloat(it.price.value) : null;
    const so = it.shippingOptions && it.shippingOptions[0];
    const ship = so && so.shippingCost && so.shippingCost.value != null ? parseFloat(so.shippingCost.value) : null;
    return {
      id: it.itemId,
      title: it.title || "",
      url: it.itemWebUrl || "#",
      total: price != null ? price + (ship || 0) : null,
      currency: (it.price && it.price.currency) || t.currency || "USD",
      listedAt: it.itemCreationDate ? Date.parse(it.itemCreationDate) : 0,
    };
  }).filter((x) => x.total != null);
}

/* ============================================================
   Tracker engine (cron)
   ============================================================ */
async function runTrackers(env) {
  const all = (await env.TRACKER.get("cfg:trackers", "json")) || [];
  const cfg = all.filter((t) => t.enabled !== false).slice(0, MAX_TRACKERS);
  if (!cfg.length) return { ran: 0 };
  const state = (await env.TRACKER.get("state", "json")) || {};
  let dirty = false;
  // drop state (ids/watermarks/medians) for trackers that no longer exist
  const known = new Set(all.map((t) => t.id));
  for (const k of Object.keys(state)) {
    if (k !== "lastRunAt" && !known.has(k)) { delete state[k]; dirty = true; }
  }
  const alerts = [];
  const errors = [];

  for (const t of cfg) {
    const ts = state[t.id] || (state[t.id] = { watermark: 0, recentIds: [], baseline: null });
    try {
      // 1. going-rate baseline: rolling median, refreshed every 6h
      // (also kept for every-listing trackers so alerts carry price context)
      if ((t.pctBelow != null || t.every) && (!ts.baseline || Date.now() - ts.baseline.at > BASELINE_TTL_MS)) {
        const comps = await ebaySearch(env, t, { newest: false, limit: 100 });
        const totals = comps.map((x) => x.total).sort((a, b) => a - b);
        const mid = Math.floor(totals.length / 2);
        ts.baseline = {
          median: totals.length >= 8 ? (totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2) : null,
          n: totals.length,
          at: Date.now(),
        };
        dirty = true;
      }

      // 2. poll newest listings
      const items = await ebaySearch(env, t, { newest: true, limit: 50 });
      const newestTs = items.reduce((m, x) => Math.max(m, x.listedAt), 0);

      if (!ts.watermark) {
        // first run: seed silently so existing listings don't flood alerts
        ts.watermark = newestTs || Date.now();
        ts.recentIds = items.slice(0, 60).map((x) => x.id);
        dirty = true;
        continue;
      }

      // 2-minute overlap absorbs listingDate/poll clock skew; recentIds dedupes
      const fresh = items.filter((x) => x.listedAt > ts.watermark - 120000 && !ts.recentIds.includes(x.id));
      if (!fresh.length) continue;

      ts.watermark = Math.max(ts.watermark, newestTs);
      ts.recentIds = fresh.map((x) => x.id).concat(ts.recentIds).slice(0, 200);
      dirty = true;

      const base = ts.baseline && ts.baseline.median;
      for (const x of fresh) {
        const underCeiling = t.ceiling != null && x.total <= t.ceiling;
        const underPct = t.pctBelow != null && base != null && x.total <= base * (1 - t.pctBelow / 100);
        if (!underCeiling && !underPct && !t.every) continue;
        const pct = base != null ? Math.round((1 - x.total / base) * 100) : null;
        const isDeal = underCeiling || underPct || (pct != null && pct >= 20);
        alerts.push({
          title: `${isDeal ? "🔥" : "🆕"} ${t.q}: ${fmtMoney(x.total, x.currency)}${base != null ? ` (going ~${fmtMoney(base, x.currency)}${pct != null && pct > 0 ? `, ${pct}% below` : ""})` : ""}`,
          body: x.title,
          url: x.url,
          tag: "tokubai-" + t.id,
        });
      }
    } catch (e) {
      errors.push(`${t.q}: ${e.message}`);
    }
  }

  state.lastRunAt = Date.now();
  // lastRunAt alone isn't worth a KV write — only persist when tracker state moved
  if (dirty) await env.TRACKER.put("state", JSON.stringify(state));

  let sent = [];
  if (alerts.length) {
    const capped = alerts.slice(0, NOTIFY_CAP);
    if (alerts.length > NOTIFY_CAP) {
      capped.push({ title: `…and ${alerts.length - NOTIFY_CAP} more new deals`, body: "Open Tokubai to see everything.", url: "./", tag: "tokubai-more" });
    }
    sent = await notify(env, capped);
  }
  return { ran: cfg.length, newDeals: alerts.length, sent, errors };
}

function fmtMoney(v, cur) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(v); }
  catch { return "$" + Number(v).toFixed(2); }
}

/* ============================================================
   Notifications — modular: each channel is independent
   ============================================================ */
async function notify(env, messages) {
  const results = [];
  for (const m of messages) {
    if (env.NTFY_TOPIC) results.push(await sendNtfy(env, m).then(() => "ntfy:ok").catch((e) => "ntfy:" + e.message));
    results.push(...await sendWebPushAll(env, m));
  }
  return results;
}

async function sendNtfy(env, m) {
  await fetch("https://ntfy.sh/" + env.NTFY_TOPIC, {
    method: "POST",
    headers: { "Title": m.title.replace(/[^\x20-\x7E]/g, "").trim() || "Tokubai", "Click": m.url, "Priority": "high", "Tags": "fire" },
    body: m.body,
  });
}

async function sendWebPushAll(env, m) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return [];
  const subs = (await env.TRACKER.get("subs", "json")) || {};
  const keys = Object.keys(subs);
  if (!keys.length) return [];
  const out = [];
  let changed = false;
  for (const k of keys) {
    try {
      const r = await sendWebPush(env, subs[k], m);
      if (r === "gone") { delete subs[k]; changed = true; out.push("push:pruned"); }
      else out.push("push:ok");
    } catch (e) { out.push("push:" + e.message); }
  }
  if (changed) await env.TRACKER.put("subs", JSON.stringify(subs));
  return out;
}

/* ---------- Web Push: VAPID (RFC 8292) + aes128gcm (RFC 8291) ---------- */
async function sendWebPush(env, sub, m) {
  const body = await encryptPayload(sub, JSON.stringify(m));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      ...(await vapidHeaders(sub.endpoint, env)),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "600",
      "Urgency": "high",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) throw new Error("status " + res.status);
  return "ok";
}

async function vapidHeaders(endpoint, env) {
  const unsigned =
    b64u(str2u8(JSON.stringify({ typ: "JWT", alg: "ES256" }))) + "." +
    b64u(str2u8(JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
    })));
  const pub = unb64u(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256",
    d: env.VAPID_PRIVATE_KEY,
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, str2u8(unsigned)));
  return { "Authorization": `vapid t=${unsigned + "." + b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}` };
}

async function encryptPayload(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh);   // 65-byte uncompressed EC point
  const authSecret = unb64u(sub.keys.auth); // 16 bytes
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(str2u8("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, str2u8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, str2u8("Content-Encoding: nonce\0"), 12);

  const plaintext = concat(str2u8(payload), new Uint8Array([2])); // 0x02 = last-record delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  // aes128gcm body header: salt(16) | record size(4) | keyid len(1) | keyid(65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  return concat(header, ct);
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

/* ---------- small utils ---------- */
const str2u8 = (s) => new TextEncoder().encode(s);
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hashStr(s) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", str2u8(s)))).slice(0, 24);
}

/* ============================================================
   Tokubai CORS proxy — Cloudflare Worker
   Browsers can't call eBay's API directly (CORS). This tiny
   worker forwards requests and adds the CORS headers.

   Deploy (free, ~3 minutes):
   1. Sign in at https://dash.cloudflare.com → Workers & Pages
   2. Create → Worker → name it (e.g. "tokubai-proxy") → Deploy
   3. Edit code → replace everything with this file → Deploy
   4. Copy the worker URL (https://tokubai-proxy.YOURNAME.workers.dev)
      into Tokubai's Settings → "CORS proxy URL"
   ============================================================ */

// Only eBay may be proxied — keeps your worker from being abused.
const ALLOWED_HOSTS = new Set(["api.ebay.com"]);

const FORWARD_HEADERS = [
  "authorization",
  "content-type",
  "x-ebay-c-marketplace-id",
  "x-ebay-c-enduserctx",
];

function withCORS(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", FORWARD_HEADERS.join(","));
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }));
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return withCORS(new Response('Missing ?url= parameter. This is the Tokubai CORS proxy — it is working. Paste this page\'s URL into Tokubai\'s Settings.', { status: 200 }));
    }

    let dest;
    try { dest = new URL(target); } catch {
      return withCORS(new Response("Invalid url parameter", { status: 400 }));
    }
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
  },
};

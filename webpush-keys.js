/* One-time VAPID keypair generator for Web Push.
   Run:  node webpush-keys.js
   Copy the two lines into your Cloudflare Worker secrets
   (Settings → Variables & secrets). Keep the private key private. */

import { webcrypto as wc } from "node:crypto";

const pair = await wc.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicRaw = new Uint8Array(await wc.subtle.exportKey("raw", pair.publicKey));
const privateJwk = await wc.subtle.exportKey("jwk", pair.privateKey);

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

console.log("Add these as worker secrets:\n");
console.log("VAPID_PUBLIC_KEY=" + b64u(publicRaw));
console.log("VAPID_PRIVATE_KEY=" + privateJwk.d);
console.log("\nAlso set VAPID_SUBJECT as a plain variable, e.g. mailto:you@example.com");

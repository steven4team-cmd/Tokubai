/* Static wiring check: every element id referenced from app.js must exist
   in index.html; no duplicate ids; every tab button has a pane.
   Run: node tools/check-wiring.js  (or npm run check) */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const js = readFileSync(path.join(root, "app.js"), "utf8");

const idList = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const htmlIds = new Set(idList);
const dups = idList.filter((id, i) => idList.indexOf(id) !== i);

const jsIds = new Set([...js.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
for (const m of js.matchAll(/\[((?:\s*"[A-Za-z0-9_-]+"\s*,?)+)\]\.forEach\(\(id\)/g)) {
  for (const s of m[1].matchAll(/"([A-Za-z0-9_-]+)"/g)) jsIds.add(s[1]);
}

const missing = [...jsIds].filter((id) => !htmlIds.has(id));
const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const badTabs = tabs.filter((t) => !htmlIds.has("tab-" + t));

console.log(`wiring: ${jsIds.size} JS-referenced ids vs ${htmlIds.size} HTML ids`);
if (dups.length) console.error("DUPLICATE ids:", dups);
if (missing.length) console.error("MISSING elements for:", missing);
if (badTabs.length) console.error("MISSING tab panes for:", badTabs);

if (dups.length || missing.length || badTabs.length) process.exit(1);
console.log("wiring: OK");

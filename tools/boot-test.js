/* Boot smoke test: executes app.js against a stub DOM and fails on any
   runtime error during startup (null derefs, typo'd variables, bad wiring).
   Run: node tools/boot-test.js  (or npm run check) */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function makeEl() {
  const state = {};
  return new Proxy(state, {
    get(t, p) {
      if (p === "classList") return { toggle() {}, add() {}, remove() {}, contains() { return false; } };
      if (p === "style" || p === "dataset") return {};
      if (["addEventListener", "removeEventListener", "focus", "select", "click", "showModal", "close", "setAttribute", "removeAttribute", "append", "appendChild"].includes(p)) return () => {};
      if (["value", "textContent", "innerHTML", "className", "title", "returnValue", "tagName"].includes(p)) return t[p] ?? "";
      if (["hidden", "checked", "disabled"].includes(p)) return t[p] ?? false;
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

// some of these are getter-only globals in modern Node — defineProperty wins
const def = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
def("window", { addEventListener() {}, scrollTo() {}, scrollY: 0 }); // feature probes ("Notification" in window) come back false
def("document", {
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => makeEl(),
  documentElement: makeEl(),
  body: makeEl(),
  activeElement: null,
  title: "",
});
def("localStorage", {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
});
def("location", { search: "", protocol: "https:", hostname: "boot-test" });
def("history", { replaceState() {} });
def("navigator", {}); // no serviceWorker → registration path is skipped
def("CSS", { escape: (s) => String(s) });
def("fetch", () => Promise.reject(new Error("network disabled in boot test")));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "app.js"), "utf8");

try {
  new Function(src)();
  console.log("boot: OK — app.js started with no runtime errors");
  process.exit(0);
} catch (e) {
  console.error("boot: FAILED —", e && e.stack || e);
  process.exit(1);
}

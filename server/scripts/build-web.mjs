#!/usr/bin/env node
// Builds the standalone web app from the Gündəm UI (app/gundem.html) + runtime (app/runtime.js).
//
//   node scripts/build-web.mjs                                   → web/        (served by this server; API = same origin)
//   The iOS app loads the web app straight from the server (capacitor.config.json → server.url),
//   so UI changes only need a push to GitHub — no new TestFlight build.
import { readFile, writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { brand } from "../src/brand.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (k, d) => { const i = process.argv.lastIndexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const out = path.resolve(root, arg("out", "web"));
const api = arg("api", "");
const ai = arg("ai", "");               // bake the assistant name. Web: the server applies it per request.

let html = await readFile(path.join(root, "app/gundem.html"), "utf8");
const rep = (a, b) => { if (!html.includes(a)) throw new Error("patch target not found: " + a.slice(0, 80)); html = html.split(a).join(b); };

// --- claude.ai wording → own Google sign-in ---
rep("Gündəm poçtunu, təqvimini və sənədlərini sənin claude.ai qoşulmaların ilə oxuyur. Parolların heç vaxt bu tətbiqə gəlmir.",
    "Gündəm poçtunu, təqvimini və sənədlərini Google hesabına verdiyin icazə ilə oxuyur. Google parolun heç vaxt bu tətbiqə gəlmir.");
rep("Qoşulmayıbsa: claude.ai → Settings → Connectors", "Qoşulmayıbsa: çıxış et, Google ilə yenidən daxil ol və bütün qutuları işarələ");
rep("Parol lazım deyil — giriş claude.ai hesabınla olur.", "Parol lazım deyil — giriş Google hesabınla olur.");
rep("Gündəm sənin claude.ai qoşulmalarından istifadə edir. «İcazə ver və yoxla» düyməsini bas — hər xidmət üçün bir dəfə icazə istəyəcək.",
    "Gündəm Google hesabına girişdə verdiyin icazələrlə işləyir. «İcazə ver və yoxla» düyməsini bas — hər xidməti yoxlayacaq.");
rep("Qoşulmayan xidmət varsa: claude.ai → Settings → Connectors bölməsindən əlavə et. Sonra da Ayarlardan edə bilərsən.",
    "Xidmət qoşulmayıbsa: Ayarlardan çıxış et, Google ilə yenidən daxil ol və icazə ekranında bütün qutuları işarələ.");
rep("${server} bağlantısının vaxtı keçib — claude.ai → Settings → Connectors bölməsində yenidən qoşun.", "${server} icazəsinin vaxtı keçib və ya verilməyib — çıxış edib Google ilə yenidən daxil ol.");
rep("${server} qoşulmayıb — claude.ai → Settings → Connectors bölməsindən əlavə edin.", "${server} qoşulmayıb — çıxış edib Google ilə yenidən daxil ol və bütün icazələri ver.");
rep("Canlı məlumat bu görünüşdə əlçatan deyil — səhifəni claude.ai-da açın.", "Serverlə əlaqə yoxdur — internet bağlantısını yoxla və yenidən daxil ol.");
rep("Canlı məlumat yalnız claude.ai-da açıldıqda işləyir", "Serverlə əlaqə yoxdur");
rep("Qoşulmayıb — claude.ai → Settings → Connectors-dan əlavə et", "Qoşulmayıb — çıxış edib Google ilə yenidən daxil ol");
rep("`claude.ai hesabı: ${viewer.name}` : \"claude.ai hesabı ilə daxil olmusan\"", "`Google hesabı: ${viewer.email || viewer.name}` : \"Google hesabı ilə daxil olmusan\"");
rep("brifinqi bu görünüşdə əlçatan deyil — səhifəni claude.ai-da açın.", "brifinqi hazır deyil — serverlə əlaqəni yoxla.");
rep("Canlı məlumat yalnız səhifə claude.ai-da açıldıqda görünür.", "Gündəm serverinə qoşulmaq alınmadı.");
if (/claude\.ai/.test(html.replace(/window\.claude/g, ""))) console.warn("⚠ claude.ai still mentioned:", (html.match(/.{40}claude\.ai.{40}/g) || []).slice(0, 5));

// --- real sign-out (token) instead of the artifact's local "welcome back" screen ---
rep("function signOut() {", "function signOut() { if (window.GundemAuth) return window.GundemAuth.signOut();");

// --- the app script goes to its own file (a strict CSP allows no inline scripts) ---
const open = html.indexOf("<script>"), close = html.indexOf("</script>", open);
if (open < 0 || close < 0 || html.indexOf("<script>", close) >= 0) throw new Error("expected exactly one inline <script> in gundem.html");
const appJs = html.slice(open + "<script>".length, close);
html = html.slice(0, open) + "<script src=\"app.js?v=__APP__\"></script>" + html.slice(close + "</script>".length);

await mkdir(out, { recursive: true });
const staticFiles = await readdir(path.join(root, "app/static"));
for (const f of staticFiles) await copyFile(path.join(root, "app/static", f), path.join(out, f));
const runtimeJs = await readFile(path.join(root, "app/runtime.js"), "utf8");
const configJs = `window.GUNDEM_CONFIG = ${JSON.stringify({ api })};\n`;
await writeFile(path.join(out, "runtime.js"), runtimeJs);
await writeFile(path.join(out, "config.js"), configJs);
await writeFile(path.join(out, "app.js"), appJs);
const hash = async (f) => createHash("sha1").update(await readFile(path.join(out, f))).digest("hex").slice(0, 10);
const v = {}; for (const f of ["app.js", "runtime.js", "config.js", "capacitor.js", "icon-180.png", "icon-192.png", "manifest.webmanifest"]) v[f] = await hash(f);

// --- full HTML document; every asset is versioned (?v=hash) so it can be cached for a year ---
const head = `<!DOCTYPE html>
<html lang="az">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B7A75">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Gündəm">
<link rel="icon" href="icon-192.png?v=${v["icon-192.png"]}">
<link rel="apple-touch-icon" href="icon-180.png?v=${v["icon-180.png"]}">
<link rel="manifest" href="manifest.webmanifest?v=${v["manifest.webmanifest"]}">
<style>
/* iPhone notch / status bar (iOS app, home-screen web app): keep content below it */
@media (max-width:900px){html body .app{padding-top:calc(16px + env(safe-area-inset-top,0px))}}
body::before{content:"";position:fixed;left:0;right:0;top:0;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:31;pointer-events:none}
</style>
<script src="capacitor.js?v=${v["capacitor.js"]}"></script>
<script src="config.js?v=${v["config.js"]}"></script>
<script src="runtime.js?v=${v["runtime.js"]}"></script>
`;
html = head + html.replace(/^\s*/, "").replace("app.js?v=__APP__", "app.js?v=" + v["app.js"]) + (html.includes("</html>") ? "" : "\n</html>\n");
if (ai) html = brand(html, ai);
await writeFile(path.join(out, "index.html"), html);

// --- service worker: the app shell opens instantly from cache (even while the free server is waking up) ---
const shell = ["./", ...Object.entries(v).filter(([f]) => f !== "app.js").map(([f, h]) => `${f}?v=${h}`)];   // app.js (branded per provider) is cached on first use
const build = createHash("sha1").update(html).digest("hex").slice(0, 10);
await writeFile(path.join(out, "sw.js"), `// generated by build-web.mjs — app shell cache (no API data is cached here)
const CACHE = "gundem-${build}";
const SHELL = ${JSON.stringify(shell)};
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (/^\\/(api|auth|webhooks|health)\\b/.test(u.pathname)) return;           // live data and login: always network
  if (e.request.mode === "navigate" && (u.pathname === "/" || u.pathname === "/index.html")) {
    // stale-while-revalidate: show the cached shell now, refresh it in the background for next time
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match("./");
      const net = fetch(e.request).then((r) => { if (r.ok) c.put("./", r.clone()); return r; });
      return hit || net;
    }));
    return;
  }
  if (u.searchParams.has("v")) e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));   // versioned = immutable
});
`);
console.log(`built ${path.relative(process.cwd(), out) || "."}/index.html  api=${api || "(same origin)"}${ai ? "  ai=" + ai : ""}  app.js=${Math.round(appJs.length / 1024)}KB`);

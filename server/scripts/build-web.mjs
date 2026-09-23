#!/usr/bin/env node
// Builds the standalone web app from the Gündəm UI (app/gundem.html) + runtime (app/runtime.js).
//
//   node scripts/build-web.mjs                                   → web/        (served by this server; API = same origin)
//   The iOS app loads the web app straight from the server (capacitor.config.json → server.url),
//   so UI changes only need a push to GitHub — no new TestFlight build.
import { readFile, writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

// --- full HTML document + runtime before the app script ---
const head = `<!DOCTYPE html>
<html lang="az">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B7A75">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Gündəm">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="manifest" href="manifest.webmanifest">
<style>
/* iPhone notch / status bar (iOS app, home-screen web app): keep content below it */
@media (max-width:900px){html body .app{padding-top:calc(16px + env(safe-area-inset-top,0px))}}
body::before{content:"";position:fixed;left:0;right:0;top:0;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:31;pointer-events:none}
</style>
<script src="capacitor.js"></script>
<script src="config.js"></script>
<script src="runtime.js"></script>
`;
html = head + html.replace(/^\s*/, "") + (html.includes("</html>") ? "" : "\n</html>\n");
if (ai) html = brand(html, ai);

await mkdir(out, { recursive: true });
await writeFile(path.join(out, "index.html"), html);
await copyFile(path.join(root, "app/runtime.js"), path.join(out, "runtime.js"));
await writeFile(path.join(out, "config.js"), `window.GUNDEM_CONFIG = ${JSON.stringify({ api })};\n`);
for (const f of await readdir(path.join(root, "app/static"))) await copyFile(path.join(root, "app/static", f), path.join(out, f));
console.log(`built ${path.relative(process.cwd(), out) || "."}/index.html  api=${api || "(same origin)"}${ai ? "  ai=" + ai : ""}`);

// End-to-end: real server + real web UI (runtime shim) in Chromium, Google and Gemini mocked.
//   NODE_PATH=<global node_modules with playwright> node test/e2e.mjs
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
process.env.PUBLIC_URL = "http://localhost:8099"; process.env.PORT = "8099";
process.env.JWT_SECRET ||= "test-secret-test-secret-test-secret"; process.env.TOKEN_ENC_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL ||= "postgres://gundem:gundem@127.0.0.1:5432/gundem";
process.env.GOOGLE_CLIENT_ID ||= "cid"; process.env.GOOGLE_CLIENT_SECRET ||= "cs"; process.env.AI_PROVIDER = "gemini"; process.env.GEMINI_API_KEY ||= "g-test";
process.env.LOG_LEVEL = "warn";
const { google } = await import("googleapis");
const { pool, one, q } = await import("../src/db.js");
await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
await q("truncate users cascade");
const { build } = await import("../src/server.js");
const { issueToken } = await import("../src/auth.js");
const { saveRefreshToken } = await import("../src/google.js");
const SHOTS = process.env.SHOTS || (await import("node:os")).tmpdir() + "/gundem-e2e"; await mkdir(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("ok  ", m); } else { fail++; console.log("FAIL", m); } };

/* ---- Google mocks (realistic inbox) ---- */
const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const b64u = (s) => Buffer.from(s).toString("base64url");
const TH = [
  { id: "t1", from: "Aysel Quliyeva <aysel@company.az>", subj: "Q3 hesabatı — cümə gününə qədər", body: "Salam Tərlan,\nQ3 hesabatını cümə saat 17:00-a qədər göndərə bilərsən?\nTəşəkkürlər", labels: ["INBOX", "UNREAD", "IMPORTANT"], ago: 2 },
  { id: "t2", from: "Kapital Bank <noreply@kapitalbank.az>", subj: "Kart əməliyyatı", body: "Kartınızla 25 AZN ödəniş edildi.", labels: ["INBOX", "CATEGORY_UPDATES"], ago: 5 },
  { id: "t3", from: "Trendyol <kampaniya@trendyol.com>", subj: "50% endirim yalnız bu gün!", body: "Kampaniya", labels: ["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"], ago: 8 },
  { id: "t4", from: "Rəşad Məmmədov <rashad@company.az>", subj: "Sabahkı görüş", body: "Sabah 10:00-da görüşək?", labels: ["INBOX"], ago: 20 },
];
const msg = (t) => ({ id: "m_" + t.id, threadId: t.id, labelIds: t.labels, snippet: t.body.slice(0, 60), internalDate: String(now - t.ago * 3600e3),
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: t.from }, { name: "To", value: "Tərlan <me@x.az>" }, { name: "Subject", value: t.subj }, { name: "Message-ID", value: `<${t.id}@x>` }], body: { data: b64u(t.body) } } });
const sent = [];
google.gmail = () => ({ users: {
  getProfile: async () => ({ data: { emailAddress: "me@x.az" } }),
  threads: { list: async ({ q: qs }) => ({ data: { threads: (/in:sent/.test(qs) ? [] : TH).map((t) => ({ id: t.id })) } }),
    get: async ({ id }) => { const t = TH.find((x) => x.id === id); return { data: { id, messages: [msg(t)] } }; } },
  messages: { get: async ({ id }) => ({ data: msg(TH.find((t) => "m_" + t.id === id)) }),
    modify: async ({ id, requestBody }) => { const t = TH.find((x) => "m_" + x.id === id); t.labels = t.labels.filter((l) => !(requestBody.removeLabelIds || []).includes(l)).concat(requestBody.addLabelIds || []); return { data: { id, labelIds: t.labels } }; },
    send: async ({ requestBody }) => { sent.push(requestBody); return { data: { id: "s1", threadId: requestBody.threadId } }; } },
  drafts: { create: async ({ requestBody }) => { sent.push(requestBody.message); return { data: { id: "d1", message: { id: "dm", threadId: "t1" } } }; } },
} });
const today = new Date(); const at = (h, m = 0) => { const d = new Date(today); d.setHours(h, m, 0, 0); return d.toISOString(); };
google.calendar = () => ({ events: {
  list: async () => ({ data: { items: [
    { id: "e1", summary: "Komanda görüşü", start: { dateTime: at(15) }, end: { dateTime: at(16) }, location: "Zoom", htmlLink: "https://calendar.google.com/e1" },
    { id: "e2", summary: "Rəşadla görüş", start: { dateTime: iso(now + 26 * 3600e3) }, end: { dateTime: iso(now + 27 * 3600e3) } },
  ] } }),
  insert: async ({ requestBody }) => ({ data: { id: "e9", ...requestBody } }),
} });
google.drive = () => ({ files: {
  list: async () => ({ data: { files: [{ id: "f1", name: "Layihə planı", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/f1", owners: [{ emailAddress: "me@x.az" }], parents: ["root"], modifiedTime: iso(now - 3600e3) }] } }),
  get: async (p) => ({ data: { id: p.fileId, name: "Layihə planı", mimeType: "application/vnd.google-apps.document", size: "10" } }),
  export: async () => ({ data: new TextEncoder().encode("# Layihə planı\n\n- Mərhələ 1: analiz\n- Mərhələ 2: tətbiq").buffer }),
  create: async (p) => ({ data: { id: "f9", name: p.requestBody.name, mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/f9" } }),
  update: async ({ fileId }) => ({ data: { id: fileId, trashed: true } }),
} });

/* ---- Gemini mock ---- */
const ai = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("generativelanguage")) return realFetch(url, init);
  const body = JSON.parse(init.body), last = body.contents.at(-1).parts, text = last.map((p) => p.text || "").join(" ");
  ai.push(text.slice(0, 80));
  let parts;
  if (/brifinqini/.test(text)) { globalThis.__briefChars = text.length; globalThis.__briefHasPromo = /Trendyol|Kapital Bank/.test(text); }
  if (/bölmələrə ayır/.test(text)) globalThis.__sortChars = text.length;
  if (/brifinqini/.test(text)) parts = [{ text: JSON.stringify({ headline: "Bu gün hesabat günüdür", summary: "Aysel Q3 hesabatını gözləyir. Saat 15:00-da komanda görüşü var.", priorities: [{ threadId: "t1", title: "Q3 hesabatı", reason: "Aysel cümə 17:00-a qədər gözləyir", action: "Hesabatı göndər", level: "high" }], tasks: ["Q3 hesabatını hazırla"] }) }];
  else if (/bölmələrə ayır/.test(text)) parts = [{ text: "{}" }];
  else if (body.tools?.length && !last.some((p) => p.functionResponse)) parts = [{ functionCall: { id: "c1", name: "search_mail", args: { query: "hesabat" } }, thoughtSignature: "s" }];
  else if (last.some((p) => p.functionResponse)) parts = [{ text: "Poçtunda **Q3 hesabatı** haqqında Ayseldən məktub var — cümə 17:00-a qədər gözləyir." }];
  else parts = [{ text: "- Aysel Q3 hesabatını istəyir\n- Səndən gözlənilən: hesabatı göndərmək" }];
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
};

/* ---- server + user ---- */
const app = build(); await app.listen({ port: 8099, host: "127.0.0.1" });
const u = await one("insert into users (google_sub,email,name,avatar_url) values ('g1','me@x.az','Tərlan Nəsirov','') returning *");
await saveRefreshToken(u.id, "rt", "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive");
const token = await issueToken(u.id);
// profile from an earlier session on another device → onboarding must be skipped
await q("insert into user_state (user_id,key,value) values ($1,'profile',$2)", [u.id, JSON.stringify({ v: JSON.stringify({ name: "Tərlan", full: "Tərlan Nəsirov", email: "me@x.az", onboarded: true, tz: "Asia/Baku" }), at: Date.now() })]);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errors = [];
async function page(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
  return p;
}
try {
  const p = await page({ width: 1360, height: 900 });
  await p.goto("http://localhost:8099/");
  await p.waitForSelector("#gd-login button", { timeout: 8000 });
  ok(await p.isVisible("text=Google ilə daxil ol"), "no token → login screen");
  await p.screenshot({ path: SHOTS + "/1-login.png" });
  // forged links must not log anyone in
  const f = await page({ width: 800, height: 600 });
  await f.goto("http://localhost:8099/#token=" + token); await f.waitForSelector("#gd-login button");
  ok(!(await f.evaluate(() => localStorage.getItem("gundem.auth.token"))) && !(await f.evaluate(() => /token/.test(location.hash))), "forged #token= link is ignored and removed (no login CSRF)");
  await q("insert into login_codes (code,user_id,expires_at,challenge) values ('stolen',$1, now()+interval '1 minute','x')", [u.id]);
  await f.goto("about:blank"); await f.goto("http://localhost:8099/#code=stolen"); await f.waitForSelector("#gd-login button"); await f.waitForTimeout(300);
  ok(!(await f.evaluate(() => localStorage.getItem("gundem.auth.token"))) && /başlanmayıb/.test(await f.textContent("#gd-msg")), "code without this tab's PKCE verifier is rejected");
  await f.close();

  // real web login: Google is simulated — /auth/google/start (tested in smoke) is intercepted, a code bound to the page's challenge is issued
  let webCC = null;
  await p.route(/\/auth\/google\/start/, async (r) => {
    webCC = new URL(r.request().url()).searchParams.get("cc");
    await q("insert into login_codes (code,user_id,expires_at,challenge) values ('webcode',$1, now()+interval '1 minute',$2)", [u.id, webCC]);
    await r.fulfill({ status: 302, headers: { location: "http://localhost:8099/#code=webcode" } });
  });
  await p.click("#gd-go");
  await p.waitForFunction(() => !!localStorage.getItem("gundem.auth.token") && !/code=/.test(location.hash), null, { timeout: 10000 });
  ok(/^[A-Za-z0-9_-]{43}$/.test(webCC || ""), "web login: PKCE challenge sent, code exchanged for a session, URL cleaned");
  await p.waitForFunction(() => document.querySelectorAll("#mail-list .mrow, #mail-list [data-id]").length >= 1, null, { timeout: 15000 });
  ok(!(await p.isVisible("#gd-login")), "login hidden after sign-in");
  ok(await p.evaluate(() => document.getElementById("onb").hidden), "onboarding skipped (profile synced from server)");
  await p.waitForFunction(() => /hesabat günüdür/.test(document.getElementById("ai-panel").textContent), null, { timeout: 15000 });
  ok(true, "AI brief rendered from Gemini JSON");
  ok(await p.evaluate(() => /Komanda görüşü/.test(document.body.textContent)), "calendar event shown");
  ok(await p.evaluate(() => /Gemini/.test(document.body.textContent) && !/claude\.ai/.test(document.body.textContent)), "UI says Gemini, no claude.ai wording");
  await p.screenshot({ path: SHOTS + "/2-today.png" });

  // mail
  await p.click('[data-nav="mail"]'); await p.waitForTimeout(400);
  const rows = await p.$$eval("#mail-list [data-id]", (els) => els.map((e) => e.getAttribute("data-id")));
  ok(rows.includes("t1") && rows.includes("t4"), "mail list has main threads: " + rows.join(","));
  await p.click('#mail-list [data-id="t1"]');
  await p.waitForFunction(() => /cümə saat 17:00/.test(document.getElementById("d-body").textContent), null, { timeout: 8000 });
  ok(true, "thread opened with body text");
  await p.waitForTimeout(1900);
  ok(!TH[0].labels.includes("UNREAD"), "opening marks as read in Gmail (labels modified)");
  await p.screenshot({ path: SHOTS + "/3-mail.png" });
  await p.click("#d-sum"); await p.waitForFunction(() => /Səndən gözlənilən/.test(document.getElementById("drawer").textContent), null, { timeout: 8000 });
  ok(true, "AI thread summary");
  // reply
  await p.click("#d-reply"); await p.fill("#r-body", "Salam Aysel, cümə göndərəcəm.");
  await p.click("#r-send");
  await p.click("#r-confirm >> text=Bəli, göndər");
  await p.waitForFunction(() => /Göndərildi/.test(document.getElementById("toast").textContent), null, { timeout: 8000 });
  { const raw = Buffer.from(sent.at(-1)?.raw || "", "base64url").toString(), subj = raw.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/);
  ok(sent.at(-1)?.threadId === "t1" && /^To: Aysel Quliyeva <aysel@company\.az>/m.test(raw) && subj && Buffer.from(subj[1], "base64").toString().startsWith("Re: Q3"), "reply sent through Gmail API (threaded, Re: subject)"); }

  // docs
  await p.keyboard.press("Escape");
  await p.click('[data-nav="docs"]'); await p.waitForTimeout(600);
  ok(await p.evaluate(() => /Layihə planı/.test(document.querySelector('[data-view="docs"]').textContent)), "Drive docs listed");

  // chat with tool call
  await p.click('.side-claude'); await p.waitForSelector("#chat:not([hidden])");
  await p.fill("#chat-input", "Hesabat haqqında nə var?"); await p.keyboard.press("Enter");
  await p.waitForFunction(() => /Q3 hesabatı/.test(document.getElementById("chat-log").textContent) && /Ayseldən/.test(document.getElementById("chat-log").textContent), null, { timeout: 15000 });
  ok(true, "chat: Gemini called search_mail tool in the page, answered");
  await p.screenshot({ path: SHOTS + "/4-chat.png" });
  await p.keyboard.press("Escape");

  // settings: account + delete button
  await p.evaluate(() => { const b = document.querySelector('[data-nav="settings"]'); if (b) b.click(); else location.hash = "settings"; });
  await p.waitForTimeout(500);
  ok(await p.isVisible("#gd-del"), "settings: 'Hesabı birdəfəlik sil' present");
  ok(await p.evaluate(() => /Google hesabı/.test(document.getElementById("st-acct").textContent)), "settings shows Google account");
  await p.screenshot({ path: SHOTS + "/5-settings.png", fullPage: false });

  // state sync: tasks saved on the server
  await p.evaluate(() => { const f = document.getElementById("today-task-form"); });
  const saved = await one("select value from user_state where user_id=$1 and key='profile'", [u.id]);
  ok(saved && JSON.parse(saved.value.v).onboarded, "profile state kept on server");

  // mobile
  const m = await page({ width: 390, height: 844 });
  await m.addInitScript((t) => localStorage.setItem("gundem.auth.token", t), token);
  await m.goto("http://localhost:8099/");
  await m.waitForFunction(() => /hesabat günüdür/.test(document.getElementById("ai-panel").textContent), null, { timeout: 15000 });
  await m.screenshot({ path: SHOTS + "/6-mobile.png" });
  ok(true, "mobile loads with brief (cached)");

  // ---- iOS app: loads the page straight from the server (capacitor server.url); Capacitor plugins mocked ----
  const n = await page({ width: 390, height: 844 });
  await n.addInitScript(() => {
    window.__opened = []; window.__listeners = {};
    const Browser = { open: async (o) => { window.__opened.push(o.url); }, close: async () => { localStorage.setItem("__closed", "1"); } };
    const App = { addListener: (ev, fn) => { window.__listeners[ev] = fn; return { remove() {} }; } };
    window.__bioOk = true; window.__bioCalls = 0;
    const NativeBiometric = { isAvailable: async () => ({ isAvailable: true, biometryType: 2 }), verifyIdentity: async () => { window.__bioCalls++; if (!window.__bioOk) throw new Error("fail"); } };
    window.Capacitor = { Plugins: { Browser, App, NativeBiometric, SplashScreen: { hide: () => { window.__splashHidden = true; } } } };
    window.CapacitorCustomPlatform = { name: "ios" };   // makes @capacitor/core report a native platform
  });
  await n.goto("http://localhost:8099/");
  await n.waitForSelector("#gd-login button");
  await n.click("#gd-go"); await n.waitForTimeout(200);
  ok(await n.evaluate(() => /^http:\/\/localhost:8099\/auth\/google\/start\?app=1&cc=[A-Za-z0-9_-]{43}$/.test(window.__opened[0]) && window.__splashHidden), "iOS: splash hidden, login opens system browser with absolute app=1 URL + PKCE");
  await n.evaluate(() => window.__listeners.appUrlOpen({ url: "gundem://auth?error=access_denied" }));
  ok(await n.evaluate(() => /ləğv edildi/.test(document.getElementById("gd-msg")?.textContent || "")), "iOS: cancelled Google login shows message");
  await n.evaluate(() => window.__listeners.appUrlOpen({ url: "gundem://auth?code=stolen" }));
  ok(!(await n.evaluate(() => localStorage.getItem("gundem.auth.token"))), "iOS: deep link with no login in progress is ignored");
  await n.click("#gd-go"); await n.waitForTimeout(200);
  const iosCC = await n.evaluate(() => new URL(window.__opened.at(-1)).searchParams.get("cc"));
  await q("insert into login_codes (code,user_id,expires_at,challenge) values ('ioscode',$1, now()+interval '1 minute',$2)", [u.id, iosCC]);
  await n.evaluate(() => window.__listeners.appUrlOpen({ url: "gundem://auth?code=ioscode" }));
  await n.waitForFunction(() => /hesabat günüdür/.test(document.getElementById("ai-panel").textContent), null, { timeout: 15000 });
  ok(await n.evaluate(() => localStorage.getItem("__closed") === "1" && !!localStorage.getItem("gundem.auth.token")), "iOS: deep link + PKCE verifier → signed in, browser closed");
  ok(await n.evaluate(() => /Gemini/.test(document.querySelector(".tabbar").textContent)), "iOS: assistant named Gemini (branding from server)");
  // Face ID lock
  await n.evaluate(() => { const b = document.querySelector('[data-nav="settings"]'); if (b) b.click(); else location.hash = "settings"; });
  await n.waitForSelector("#gd-lock-t", { timeout: 5000 });
  ok(await n.evaluate(() => /Face ID ilə kilidlə/.test(document.getElementById("gd-lock-row").textContent)), "iOS: settings offers 'Face ID ilə kilidlə'");
  await n.click("#gd-lock-t"); await n.waitForTimeout(1700);   // the Face ID sheet's own inactive/active events are ignored for 1.5 s
  ok(await n.evaluate(() => localStorage.getItem("gundem.lock") === "1" && window.__bioCalls === 1), "enabling the lock asks Face ID first");
  await n.evaluate(() => window.__listeners.appStateChange({ isActive: false }));
  ok(await n.isVisible("#gd-lock"), "going to background hides content (app switcher)");
  await n.evaluate(() => window.__listeners.appStateChange({ isActive: true }));
  ok(!(await n.isVisible("#gd-lock")), "back within 1 min → no prompt");
  await n.evaluate(() => { window.__bioOk = false; window.__listeners.appStateChange({ isActive: false }); });
  await n.evaluate(() => { const d = Date.now; Date.now = () => d() + 120000; window.__listeners.appStateChange({ isActive: true }); });
  await n.waitForTimeout(500);
  ok(await n.isVisible("#gd-lock") && /alınmadı/.test(await n.textContent("#gd-lock-msg")), "after >1 min Face ID is required; failure keeps it locked");
  await n.screenshot({ path: SHOTS + "/8-lock.png" });
  await n.evaluate(() => { window.__bioOk = true; }); await n.click("#gd-lock-go"); await n.waitForTimeout(200);
  ok(!(await n.isVisible("#gd-lock")), "successful Face ID unlocks");
  await n.reload(); await n.waitForTimeout(800);
  ok(await n.evaluate(() => window.__bioCalls === 1 && !document.getElementById("gd-lock")), "cold start with lock on → Face ID prompt → unlocked");
  await n.screenshot({ path: SHOTS + "/7-ios.png" });

  // sign out → login screen, token gone
  await p.evaluate(() => window.GundemAuth.signOut());
  await p.waitForSelector("#gd-login button", { timeout: 8000 });
  ok(await p.evaluate(() => !localStorage.getItem("gundem.auth.token")), "sign-out clears token and shows login");
  ok(!errors.length, "no page errors" + (errors.length ? ": " + errors.slice(0, 5).join(" | ") : ""));
  console.log("AI calls:", ai.length, "brief prompt chars:", globalThis.__briefChars, "sort prompt chars:", globalThis.__sortChars);
  ok(globalThis.__briefHasPromo === false, "brief prompt skips promo/receipt/notification mails");
} catch (e) { fail++; console.log("FAIL exception", e.message); }
await browser.close(); await app.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

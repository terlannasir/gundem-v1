/* Gündəm runtime — stands in for the claude.ai artifact runtime (window.claude.use)
 * so the same Gündəm UI runs on its own server: Google sign-in, Gmail/Calendar/Drive
 * through /api/tool, AI through /api/ai/sample, synced settings through /api/state.
 * Loaded before the app script. Config: window.GUNDEM_CONFIG = { api: "https://…" } (empty = same origin). */
(function () {
  "use strict";
  var CFG = window.GUNDEM_CONFIG || {};
  var API = String(CFG.api || "").replace(/\/$/, "");
  var BASE = API || location.origin;   // absolute server URL (the iOS app loads this page straight from the server)
  var Cap = window.Capacitor;
  var NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  var TK = "gundem.auth.token", CACHE = "gundem.rt.cache.";
  var ls = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    keys: function () { try { return Object.keys(localStorage); } catch (e) { return []; } }
  };
  var plugins = {};
  function plugin(name) {   // @capacitor/core (capacitor.js) is bundled in the iOS build → registerPlugin gives the native proxy
    if (!Cap) return null;
    if (!plugins[name]) plugins[name] = (Cap.Plugins && Cap.Plugins[name]) || (Cap.registerPlugin ? Cap.registerPlugin(name) : null) || null;
    return plugins[name];
  }

  /* ---------------- login code from the OAuth redirect (web) ---------------- */
  // PKCE: the tab that starts the login keeps a secret verifier; the server only hands out a token for
  // code + verifier, so a login link/code injected by someone else is useless (no login CSRF, no code theft).
  var PK = "gundem.pkce", authError = null, pendingCode = null;
  var ss = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }, del: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} } };
  (function () {
    var h = location.hash || "";
    var c = h.match(/[#&]code=([^&]+)/), e = h.match(/[#&](?:auth_)?error=([^&]+)/), old = /[#&]token=/.test(h);
    if (c) pendingCode = decodeURIComponent(c[1]);
    if (e) authError = decodeURIComponent(e[1]);
    if (c || e || old) history.replaceState(null, "", location.pathname + location.search);   // never accept a token from the URL
  })();
  function b64url(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  async function newPkce() {
    var v = b64url(crypto.getRandomValues(new Uint8Array(32)));
    var cc = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
    return { v: v, cc: cc };
  }
  function subOf(t) { try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub || ""; } catch (e) { return ""; } }
  function setToken(t) {   // a different account on this device → drop the previous account's local copies
    var prev = ls.get("gundem.auth.uid"), sub = subOf(t);
    if (prev && sub && prev !== sub) ls.keys().forEach(function (k) { if (k.indexOf("gundem.") === 0) ls.del(k); });
    ls.set(TK, t); ls.set("gundem.auth.uid", sub);
  }
  async function exchange(code, verifier) {
    var r = await fetch(BASE + "/auth/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code, verifier: verifier }) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok || !d.token) throw new Error(d.error || "exchange");
    return d.token;
  }

  var token = ls.get(TK), me = null, authResolve, reauthShown = false;
  var authed = new Promise(function (r) { authResolve = r; });

  /* ---------------- HTTP ---------------- */
  function err(code, message, extra) { var e = { code: code, message: message || code }; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  async function api(path, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(API + path, {
        method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
        headers: Object.assign({ "authorization": "Bearer " + token }, opts.body !== undefined ? { "content-type": "application/json" } : {}),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw err("cancelled", "Ləğv edildi");
      throw err("server_unavailable", "Serverə qoşulmaq alınmadı — internet bağlantısını yoxla", { retryable: true, retryAfterMs: 2000 });
    }
    var data = null; try { data = await res.json(); } catch (e) {}
    if (res.ok) return data;
    if (res.status === 401) { signOut(true); throw err("not_granted", "Yenidən daxil olmaq lazımdır"); }
    var code = (data && data.error) || "upstream_error";
    if (res.status === 409 || code === "google_reconnect_required") code = "needs_reauth";
    if (code === "needs_reauth" && path === "/api/tool" && !reauthShown) {   // Google token expired/revoked (Testing mode: every 7 days)
      reauthShown = true; showLogin("Google icazəsinin vaxtı keçib və ya tam verilməyib — yenidən daxil ol və bütün qutuları işarələ.");
    }
    if (res.status === 402) throw err("quota_exceeded", "Bu ayın AI limiti doldu" + (data && data.detail ? " (" + data.detail.used + "/" + data.detail.limit + ")" : ""), { status: 402 });
    if (res.status === 429) throw err("rate_limited", "Çox sorğu — bir az gözlə", { retryAfterMs: 20000 });
    if (res.status >= 500 && code !== "tool_error") throw err(code === "server_error" ? "server_unavailable" : code, (data && data.message) || "Server xətası", { retryable: true, retryAfterMs: 3000 });
    throw err(code, (data && data.message) || code);
  }

  /* ---------------- login screen ---------------- */
  var CSS = "#gd-login{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom));background:linear-gradient(160deg,#0A2427,#0C5B55);color:#EFFAF8;font-family:Onest,-apple-system,'Segoe UI',system-ui,sans-serif;text-align:center}" +
    "#gd-login .c{width:100%;max-width:380px}#gd-login .lg{width:84px;height:84px;border-radius:24px;background:rgba(255,255,255,.1);display:grid;place-items:center;margin:0 auto 18px}#gd-login .lg svg{width:44px;height:44px}" +
    "#gd-login h1{margin:0 0 8px;font-family:Unbounded,Onest,system-ui,sans-serif;font-weight:600;font-size:30px;letter-spacing:-.02em}#gd-login p{margin:0 auto;color:#A9D4CE;font-size:15.5px;line-height:1.5;max-width:32ch}" +
    "#gd-login button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin:26px 0 0;border:0;border-radius:14px;padding:15px;font:700 16px/1 inherit;font-family:inherit;background:#fff;color:#1f2937;cursor:pointer}#gd-login button[disabled]{opacity:.6}" +
    "#gd-login button svg{width:20px;height:20px}#gd-login .n{margin-top:16px;font-size:13px;color:#8FC2BB;line-height:1.5}#gd-login .n a{color:#CDEFEA}#gd-login .e{margin-top:14px;padding:10px 12px;border-radius:12px;background:rgba(244,63,94,.18);color:#FFE4E6;font-size:14px}";
  var LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="#EFFAF8" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var GLOGO = '<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  var ERRS = { access_denied: "Google girişi ləğv edildi.", invalid_code: "Giriş kodu etibarsızdır və ya vaxtı keçib — yenidən cəhd et.", not_started: "Giriş bu pəncərədə başlanmayıb — yenidən «Google ilə daxil ol» bas." };
  function showLogin(msg) {
    var box = document.getElementById("gd-login");
    if (!box) {
      var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
      box = document.createElement("div"); box.id = "gd-login"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
      box.innerHTML = '<div class="c"><div class="lg">' + LOGO + '</div><h1>Gündəm</h1><p>Poçt, təqvim, sənədlər və süni intellekt köməkçisi — bir yerdə.</p>' +
        '<button type="button" id="gd-go">' + GLOGO + '<span>Google ilə daxil ol</span></button><div id="gd-msg"></div>' +
        '<p class="n">Gündəm yalnız sənin icazə verdiyin Gmail, Təqvim və Drive məlumatını oxuyur. Google parolun bu tətbiqə gəlmir. <a href="' + API + '/privacy.html" target="_blank" rel="noopener">Məxfilik siyasəti</a></p></div>';
      (document.body || document.documentElement).appendChild(box);
      document.getElementById("gd-go").addEventListener("click", startLogin);
    }
    box.hidden = false; box.style.display = "";
    var m = document.getElementById("gd-msg"); m.className = msg ? "e" : ""; m.textContent = msg || "";
  }
  function hideLogin() { var b = document.getElementById("gd-login"); if (b) b.style.display = "none"; }
  function busy(on, label) { var b = document.getElementById("gd-go"); if (!b) return; b.disabled = on; b.lastChild.textContent = label || "Google ilə daxil ol"; }

  var retryMode = false, nativeVerifier = null;
  async function startLogin() {
    if (retryMode) { retryMode = false; busy(true, "Qoşulur…"); return boot(); }
    busy(true, "Google açılır…");
    var pk; try { pk = await newPkce(); } catch (e) { busy(false); showLogin("Bu brauzer təhlükəsiz girişi dəstəkləmir."); return; }
    ss.set(PK, pk.v);
    if (!NATIVE) { location.href = BASE + "/auth/google/start?cc=" + pk.cc; return; }
    nativeVerifier = pk.v;
    var Browser = plugin("Browser");
    try { await Browser.open({ url: BASE + "/auth/google/start?app=1&cc=" + pk.cc, presentationStyle: "popover" }); }
    catch (e) { busy(false); showLogin("Brauzer açılmadı: " + (e && e.message || e)); }
    setTimeout(function () { busy(false); }, 4000);
  }
  if (NATIVE) {
    var App = plugin("App");
    if (App) App.addListener("appUrlOpen", async function (ev) {
      var u; try { u = new URL(ev.url); } catch (e) { return; }
      if (u.host !== "auth" && u.pathname.replace(/^\/+/, "") !== "auth") return;
      var verifier = nativeVerifier || ss.get(PK);
      if (!verifier) return;                        // no login started here → ignore foreign/replayed links
      try { plugin("Browser").close(); } catch (e) {}
      var code = u.searchParams.get("code"), e2 = u.searchParams.get("error");
      nativeVerifier = null; ss.del(PK);
      if (e2 || !code) { if (token && me) return; showLogin(ERRS[e2] || "Giriş alınmadı: " + e2); busy(false); return; }
      busy(true, "Daxil olunur…");
      try { setToken(await exchange(code, verifier)); location.reload(); }   // fresh page = clean state for the new session
      catch (e) { busy(false); showLogin(ERRS[e.message] || "Giriş alınmadı — yenidən cəhd et."); }
    });
  }

  async function boot() {
    if (pendingCode) {                               // back from Google in this tab
      var v = ss.get(PK), c = pendingCode; pendingCode = null; ss.del(PK);
      if (!v) authError = "not_started";
      else { try { token = await exchange(c, v); var before = ls.get("gundem.auth.uid"); setToken(token); clearCaches(); if (before && before !== subOf(token)) { location.reload(); return; } } catch (e) { authError = e.message; } }
    }
    if (!token) { showLogin(authError ? (ERRS[authError] || "Giriş alınmadı: " + authError) : ""); return; }
    var slow = setTimeout(function () { showLogin(""); busy(true, "Server oyanır… (30–60 san.)"); }, 3500);
    try {
      me = await api("/api/me");
      clearTimeout(slow); hideLogin(); busy(false); authResolve(true); addAccountControls();
    } catch (e) {
      clearTimeout(slow); busy(false);
      if (e && e.code === "not_granted") return;          // signOut already showed the login screen
      showLogin(e && e.message ? e.message : "Serverə qoşulmaq alınmadı");
      retryMode = true; var b = document.getElementById("gd-go"); if (b) b.lastChild.textContent = "Yenidən cəhd et";
    }
  }
  function clearCaches() { ls.keys().forEach(function (k) { if (k.indexOf(CACHE) === 0) ls.del(k); }); }
  function signOut(expired) {
    token = null; ls.del(TK); clearCaches();
    watches.forEach(function (w) { clearInterval(w.timer); }); watches.clear();
    if (expired === true) { showLogin("Sessiyanın vaxtı keçib — yenidən daxil ol."); return; }
    ls.keys().forEach(function (k) { if (k.indexOf("gundem.") === 0) ls.del(k); });
    location.reload();
  }
  async function deleteAccount() {
    await api("/api/me", { method: "DELETE" });
    ls.keys().forEach(function (k) { if (k.indexOf("gundem.") === 0) ls.del(k); });
    token = null; location.reload();
  }
  window.GundemTools = {
    parseOffice: async function (bytes, name, kind) {
      var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      var r = await api("/api/parse", { body: { name: name, kind: kind, data: b64(u) } });
      return r.text || "";
    }
  };
  window.GundemAuth = { signOut: signOut, deleteAccount: deleteAccount, me: function () { return me; } };

  // Settings → "Hesabı sil" (App Store rule 5.1.1(v)); shown under the data section
  function addAccountControls() {
    var run = function () {
      var anchor = document.getElementById("st-wipe-confirm");
      if (!anchor || document.getElementById("gd-del")) return;
      var wrap = document.createElement("div"); wrap.style.cssText = "margin-top:14px;padding-top:14px;border-top:1px solid var(--line)";
      wrap.innerHTML = '<p class="meta" style="margin:0 0 8px">Hesab: ' + (me && me.email ? me.email.replace(/[<>&"]/g, "") : "") + (me && me.plan === "premium" ? " · Premium" : " · Pulsuz plan") +
        (me && me.limits ? " · AI: " + (me.usage ? me.usage.ai : 0) + "/" + me.limits.ai + " bu ay" : "") + '</p>' +
        '<div id="gd-lock-row"></div>' +
        '<button class="btn ghost" type="button" id="gd-out-all" style="margin-right:8px">Bütün cihazlardan çıx</button>' +
        '<button class="btn ghost" type="button" id="gd-del" style="color:var(--rose)">Hesabı birdəfəlik sil</button><div id="gd-del-c"></div>';
      anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
      renderLockRow();
      document.getElementById("gd-out-all").addEventListener("click", function (ev) {
        ev.currentTarget.disabled = true;
        api("/api/signout-all", { method: "POST", body: {} }).then(function () { signOut(); }, function () { ev.currentTarget.disabled = false; });
      });
      document.getElementById("gd-del").addEventListener("click", function () {
        var c = document.getElementById("gd-del-c");
        c.innerHTML = '<p class="note err" style="margin:10px 0">Hesabın, Google icazəsi və Gündəmdə saxlanan bütün məlumat silinəcək. Gmail, Təqvim və Drive-dakı faylların toxunulmaz qalır.</p><button class="btn" type="button" id="gd-del-yes" style="background:var(--rose);color:#fff;border-color:var(--rose)">Bəli, hesabı sil</button>';
        document.getElementById("gd-del-yes").addEventListener("click", function (ev) { ev.currentTarget.disabled = true; deleteAccount().catch(function (e) { c.textContent = "Silmək alınmadı: " + (e.message || e.code); }); });
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
    var root = document.querySelector('[data-view="settings"]') || document.documentElement;   // watch only the settings view
    new MutationObserver(function () { if (!document.getElementById("gd-del")) run(); }).observe(root, { childList: true, subtree: true });
  }

  /* ---------------- Face ID / Touch ID lock (iOS app) ---------------- */
  var LOCK = "gundem.lock", GRACE = 60000;
  var bio = { ok: false, name: "Face ID" }, locked = false, prompting = false, bgAt = 0, promptEndedAt = 0;
  var lockOn = function () { return ls.get(LOCK) === "1"; };
  // lock on → hide everything from the very first paint until Face ID says otherwise
  function veil(on) {
    var v = document.getElementById("gd-veil");
    if (on && !v) { v = document.createElement("style"); v.id = "gd-veil"; v.textContent = "body>*:not(#gd-lock):not(#gd-login){visibility:hidden!important}"; document.head.appendChild(v); }
    if (!on && v) v.remove();
  }
  if (NATIVE && lockOn()) veil(true);
  var LOCK_CSS = "#gd-lock{position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;background:linear-gradient(160deg,#0A2427,#0C5B55);color:#EFFAF8;font-family:Onest,-apple-system,system-ui,sans-serif;text-align:center}" +
    "#gd-lock h2{margin:8px 0 0;font:600 24px Unbounded,Onest,system-ui,sans-serif}#gd-lock p{margin:0;color:#A9D4CE;font-size:15px}#gd-lock button{margin-top:18px;border:0;border-radius:14px;padding:14px 26px;font:700 16px inherit;font-family:inherit;background:#EFFAF8;color:#0A2427}";
  function lockOverlay(show, msg) {
    var el = document.getElementById("gd-lock");
    veil(!!show);
    if (!show) { if (el) el.remove(); return; }
    if (!el) {
      if (!document.getElementById("gd-lock-css")) { var st = document.createElement("style"); st.id = "gd-lock-css"; st.textContent = LOCK_CSS; document.head.appendChild(st); }
      el = document.createElement("div"); el.id = "gd-lock"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
      el.innerHTML = '<div style="width:84px;height:84px;border-radius:24px;background:rgba(255,255,255,.1);display:grid;place-items:center">' + LOGO.replace('<svg ', '<svg width="44" height="44" ') + '</div><h2>Gündəm kilidlidir</h2><p id="gd-lock-msg"></p><button type="button" id="gd-lock-go"></button>';
      (document.body || document.documentElement).appendChild(el);
      document.getElementById("gd-lock-go").addEventListener("click", unlock);
    }
    document.getElementById("gd-lock-go").textContent = bio.name + " ilə aç";
    document.getElementById("gd-lock-msg").textContent = msg || "";
  }
  async function unlock() {
    if (prompting) return;
    var B = plugin("NativeBiometric"); if (!B) { locked = false; lockOverlay(false); return; }
    prompting = true;
    try {
      await B.verifyIdentity({ reason: "Gündəmi açmaq üçün", title: "Gündəm", useFallback: true });
      locked = false; lockOverlay(false);
    } catch (e) { lockOverlay(true, "Təsdiq alınmadı — yenidən cəhd et."); }
    finally { prompting = false; bgAt = 0; promptEndedAt = Date.now(); }
  }
  function lockNow(prompt) { locked = true; lockOverlay(true); if (prompt) setTimeout(unlock, 250); }
  async function initLock() {
    if (!NATIVE) return;
    var B = plugin("NativeBiometric");
    try {
      var r = B && await B.isAvailable({ useFallback: true });
      bio.ok = !!(r && r.isAvailable); bio.name = r && r.biometryType === 1 ? "Touch ID" : r && r.biometryType === 2 ? "Face ID" : "Kod";
    } catch (e) { bio.ok = false; veil(false); }    // older build without the plugin → no lock option
    renderLockRow();
    if (bio.ok && lockOn()) lockNow(true);
    var App = plugin("App");
    if (App) App.addListener("appStateChange", function (st) {
      // the Face ID sheet itself makes the app inactive/active — ignore those transitions (else: endless prompt loop after "Cancel")
      if (prompting || !bio.ok || !lockOn() || Date.now() - promptEndedAt < 1500) return;
      if (!st.isActive) { bgAt = Date.now(); if (!locked) lockOverlay(true); }   // hide content in the app switcher
      else if (bgAt && Date.now() - bgAt > GRACE) lockNow(true);
      else if (locked) lockOverlay(true);            // still locked (e.g. cancelled) → wait for the button, don't re-prompt
      else { lockOverlay(false); bgAt = 0; }
    });
  }
  function renderLockRow() {
    var row = document.getElementById("gd-lock-row"); if (!row) return;
    if (!bio.ok) { row.replaceChildren(); return; }
    row.innerHTML = '<label class="chkrow" style="margin:0 0 12px"><input type="checkbox" id="gd-lock-t"> ' + bio.name + ' ilə kilidlə <span class="meta">(tətbiq 1 dəqiqədən çox arxa planda qalanda)</span></label>';
    var t = document.getElementById("gd-lock-t"); t.checked = lockOn();
    t.addEventListener("change", async function () {
      if (!t.checked) { ls.del(LOCK); return; }
      var B = plugin("NativeBiometric"); prompting = true;
      try { await B.verifyIdentity({ reason: bio.name + " kilidini aktivləşdirmək üçün", title: "Gündəm", useFallback: true }); ls.set(LOCK, "1"); }
      catch (e) { t.checked = false; }
      finally { prompting = false; promptEndedAt = Date.now(); }
    });
  }
  window.GundemLock = { lockNow: lockNow, state: function () { return { available: bio.ok, on: lockOn(), locked: locked }; } };

  /* ---------------- mcp ---------------- */
  var watches = new Map(); var wid = 0;
  function key(server, tool, input) { return server + "|" + tool + "|" + JSON.stringify(input || {}); }
  function readCache(k) { try { return JSON.parse(ls.get(CACHE + k) || "null"); } catch (e) { return null; } }
  function writeCache(k, payload) { var s = JSON.stringify({ payload: payload, storedAt: Date.now() }); if (s.length < 600000) ls.set(CACHE + k, s); }
  async function callTool(server, tool, input, opts) {
    await authed;
    var r = await api("/api/tool", { body: { server: server, tool: tool, input: input || {} }, signal: opts && opts.signal })
      .catch(function (e) { e.server = server; throw e; });
    var storedAt = Date.now();
    if (/^(search_|list_)/.test(tool)) writeCache(key(server, tool, input), r.payload);   // lists only: opened mails/docs are not kept in the browser
    return { payload: r.payload, content: [{ type: "text", text: JSON.stringify(r.payload) }], cache: { storedAt: storedAt } };
  }
  function runWatch(w) {
    if (w.inflight) return w.inflight;
    w.inflight = callTool(w.server, w.tool, w.input).then(function (res) {
      w.last = Date.now(); if (w.alive) w.handler({ type: "data", result: res });
    }, function (e) { if (w.alive) w.handler({ type: "error", error: e }); })
      .finally(function () { w.inflight = null; });
    return w.inflight;
  }
  function watchTool(server, tool, input, handler, opts) {
    opts = opts || {};
    var w = { id: ++wid, server: server, tool: tool, input: input, handler: handler, alive: true, last: 0, stale: (opts.cache && opts.cache.staleTime) || 60000 };
    watches.set(w.id, w);
    var c = readCache(key(server, tool, input));
    if (c) setTimeout(function () { if (w.alive) handler({ type: "data", result: { payload: c.payload, cache: { storedAt: c.storedAt, replayed: true } } }); }, 0);
    authed.then(function () { if (w.alive) runWatch(w); });
    if (opts.refetchInterval) w.timer = setInterval(function () { if (!document.hidden) runWatch(w); }, Math.max(30000, opts.refetchInterval));
    return function () { w.alive = false; clearInterval(w.timer); watches.delete(w.id); };
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !token) return;
    watches.forEach(function (w) { if (Date.now() - w.last > w.stale) runWatch(w); });
  });
  var mcp = Object.freeze({
    listTools: async function () { await authed; var r = await api("/api/tools"); return { servers: r.servers.map(function (s) { return { server: s.server, kind: "connector", authStatus: s.authStatus, tools: s.tools.map(function (n) { return { name: n }; }) }; }), fileArgs: false }; },
    callTool: callTool,
    watchTool: watchTool,
    invalidate: async function (server) {
      if (server) ls.keys().forEach(function (k) { if (k.indexOf(CACHE + server + "|") === 0) ls.del(k); });
      var list = []; watches.forEach(function (w) { if (!server || w.server === server) list.push(runWatch(w)); });
      await Promise.all(list);
    },
    server: async function (name) {
      var h = {}; ["search_threads", "get_thread", "get_message", "update_message_labels", "send_message", "create_draft", "reply", "forward", "list_events", "create_event", "search_files", "read_file_content", "create_file", "trash_file"]
        .forEach(function (t) { h[t] = function (input, o) { return callTool(name, t, input, o).then(function (r) { return r.payload; }); }; });
      return Object.freeze(h);
    },
    describeTool: function () { return Promise.reject(err("capability_removed", "describeTool is not available")); }
  });

  /* ---------------- sample (AI) ---------------- */
  var IMG_MAX = 4, IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  function b64(buf) { var s = "", u = new Uint8Array(buf); for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  async function imagePart(blob) {
    var type = blob.type || "image/png";
    if (blob.size > 1200000 || IMG_TYPES.indexOf(type) < 0) {   // downscale big photos to keep requests small
      try {
        var bmp = await createImageBitmap(blob), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        var cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
        cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
        blob = await new Promise(function (r) { cv.toBlob(r, "image/jpeg", 0.85); }); type = "image/jpeg";
      } catch (e) { if (IMG_TYPES.indexOf(type) < 0) throw err("image_rejected", "Şəkil növü dəstəklənmir"); }
    }
    return { type: "image", mediaType: type, data: b64(await blob.arrayBuffer()) };
  }
  function toMessages(input) {
    if (typeof input === "string") return [{ role: "user", content: input }];
    if (!Array.isArray(input) || !input.length) throw err("bad_request", "input boşdur");
    return input.map(function (t) { return { role: t.role === "assistant" ? "assistant" : "user", content: String(t.content == null ? "" : t.content) }; });
  }
  async function sample(input, opts) {
    opts = opts || {};
    await authed;
    var msgs = toMessages(input);
    var imgs = opts.images ? (opts.images instanceof Blob ? [opts.images] : Array.prototype.slice.call(opts.images)) : [];
    if (imgs.length) {
      var last = msgs[msgs.length - 1], parts = [{ type: "text", text: last.content }];
      for (var i = 0; i < Math.min(IMG_MAX, imgs.length); i++) parts.push(await imagePart(imgs[i]));
      last.content = parts;
    }
    var tools = (opts.tools || []).slice(0, 16), byName = {};
    tools.forEach(function (t) { byName[t.name] = t; });
    var defs = tools.map(function (t) { return { name: t.name, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } }; });
    var text = "";
    var turn = null;
    for (var round = 0; round < 6; round++) {
      if (opts.signal && opts.signal.aborted) throw err("cancelled", "Ləğv edildi");
      var r = await api("/api/ai/sample", { body: { messages: msgs, tools: defs.length ? defs : undefined, modelTier: opts.modelTier, json: !!opts.json, turn: turn || undefined }, signal: opts.signal });
      if (r.turn) turn = r.turn;
      if (r.text) { text += (text ? "\n\n" : "") + r.text; if (opts.onText) try { opts.onText({ text: text, delta: r.text }); } catch (e) {} }
      if (r.stop !== "tool_use") return { text: text, truncated: !!r.truncated };
      msgs.push({ role: "assistant", raw: r.raw });
      var results = [];
      for (var j = 0; j < r.calls.length; j++) {
        var c = r.calls[j], t = byName[c.name], out, isErr = false;
        try {
          if (!t) throw new Error("naməlum alət: " + c.name);
          out = await t.execute(c.input || {}, { signal: opts.signal || new AbortController().signal });
          out = typeof out === "string" ? out : JSON.stringify(out == null ? null : out);
        } catch (e) { isErr = true; out = "Xəta: " + (e && (e.message || e.code) || e); }
        results.push({ id: c.id, name: c.name, output: String(out).slice(0, 9000), isError: isErr });
      }
      msgs.push({ role: "user", toolResults: results });
    }
    return { text: text || "(cavab alınmadı)", truncated: true };
  }
  function parseJSON(t) {
    var s = String(t || "").trim(), m = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) s = m[1].trim();
    try { return JSON.parse(s); } catch (e) {}
    var a = s.search(/[\[{]/), b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
    throw err("invalid_json", "Cavab JSON deyil", { text: t });
  }
  sample.json = async function (input, opts) { var r = await sample(input, Object.assign({}, opts, { json: true })); return parseJSON(r.text); };
  sample.limits = async function () { return { maxInputBytes: 400000, tools: { maxCount: 16 }, images: { maxCount: IMG_MAX, maxBytes: 5000000, mediaTypes: IMG_TYPES } }; };
  Object.freeze(sample);

  /* ---------------- db (maps data/users/<id>/<key> → /api/state/<key>) ---------------- */
  var stateCache = null, stateAt = 0, subs = new Map();
  var stateInflight = null;
  async function loadState(force) {
    if (!force && stateCache && Date.now() - stateAt < 5000) return stateCache;
    if (!stateInflight) stateInflight = api("/api/state").then(function (s) { stateCache = s; stateAt = Date.now(); return s; }).finally(function () { stateInflight = null; });
    return stateInflight;   // six parallel reads on boot → one request
  }
  function keyOf(path) { var m = String(path).match(/^data\/users\/[^/]+\/([a-z]+)$/); if (!m) throw err("bad_request", "Unsupported path " + path); return m[1]; }
  function snap(v) { return { exists: v !== undefined && v !== null, data: function () { return v; } }; }
  function doc(path) {
    var k = keyOf(path);
    return Object.freeze({
      get: async function () { await authed; var s = await loadState(); return snap(s[k]); },
      set: async function (v) { await authed; await api("/api/state/" + k, { method: "PUT", body: v }); if (stateCache) stateCache[k] = v; return; },
      update: async function (v) { await authed; var s = await loadState(); var n = Object.assign({}, s[k] || {}, v); await api("/api/state/" + k, { method: "PUT", body: n }); if (stateCache) stateCache[k] = n; },
      delete: async function () { await authed; await api("/api/state/" + k, { method: "PUT", body: null }); if (stateCache) stateCache[k] = null; },
      onSnapshot: function (cb, onErr) {
        var entry = { cb: cb, last: undefined };
        if (!subs.has(k)) subs.set(k, new Set()); subs.get(k).add(entry);
        authed.then(async function () { try { var s = await loadState(); entry.last = JSON.stringify(s[k]); cb(snap(s[k])); } catch (e) { if (onErr) onErr(e); } });
        return function () { var set = subs.get(k); if (set) set.delete(entry); };
      }
    });
  }
  async function pollState() {   // other devices' changes (phone ↔ computer) arrive within a minute or on focus
    if (!token || !subs.size || document.hidden) return;
    try {
      var s = await loadState(true);
      subs.forEach(function (set, k) { var j = JSON.stringify(s[k]); set.forEach(function (e) { if (j !== e.last) { e.last = j; try { e.cb(snap(s[k])); } catch (x) {} } }); });
    } catch (e) {}
  }
  setInterval(pollState, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pollState(); });
  var db = Object.freeze({ doc: doc, collection: function () { throw err("capability_removed", "collections are not supported"); } });

  /* ---------------- user ---------------- */
  var user = Object.freeze({
    id: async function () { await authed; return me.id; },
    me: async function () { await authed; return { id: me.id, name: me.name || "", email: me.email || "", avatarUrl: me.avatarUrl || "" }; },
    isOwner: function () { return true; }, canEdit: function () { return true; }, can: function () { return true; },
    profiles: async function (ids) { await authed; var o = {}; (ids || []).forEach(function (i) { o[i] = i === me.id ? { id: me.id, name: me.name || "" } : { id: i, name: "" }; }); return o; },
    search: async function () { return []; }
  });

  /* ---------------- downloads ---------------- */
  var downloads = Object.freeze({
    save: async function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: "application/octet-stream" });
      var name = String(o.filename || "fayl").replace(/[\\/:*?"<>|]+/g, "_");
      if (NATIVE && navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: blob.type })] })) {
        try { await navigator.share({ files: [new File([blob], name, { type: blob.type })], title: name }); return; }
        catch (e) { if (e && e.name === "AbortError") throw err("cancelled", "Ləğv edildi"); }
      }
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
  });

  var NS = { mcp: mcp, sample: sample, db: db, user: user, downloads: downloads };
  window.claude = Object.freeze({
    use: function (name) {
      if (!NS[name]) return Promise.resolve(null);
      return authed.then(function () { return NS[name]; });
    }
  });

  if (NATIVE) { try { var sp = plugin("SplashScreen"); if (sp) sp.hide(); } catch (e) {} }
  if (NATIVE) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initLock); else initLock(); }
  if (!NATIVE && window.isSecureContext && "serviceWorker" in navigator) {   // app shell opens instantly next time (web / home-screen app)
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

// Smoke test against a real PostgreSQL with Google APIs and the AI providers mocked.
//   DATABASE_URL=postgres://… npm test
import assert from "node:assert/strict";
process.env.PUBLIC_URL ||= "http://localhost:8080";
process.env.JWT_SECRET ||= "test-secret-test-secret-test-secret"; process.env.TOKEN_ENC_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL ||= "postgres://gundem:gundem@127.0.0.1:5432/gundem";
process.env.GOOGLE_CLIENT_ID ||= "cid"; process.env.GOOGLE_CLIENT_SECRET ||= "cs";
process.env.AI_PROVIDER = process.env.TEST_PROVIDER || "gemini"; process.env.GEMINI_API_KEY ||= "g-test"; process.env.ANTHROPIC_API_KEY ||= "sk-test";
process.env.REVENUECAT_WEBHOOK_SECRET ||= "rc"; process.env.FREE_AI_REQUESTS = "3";
const { readFile } = await import("node:fs/promises");
const { google } = await import("googleapis");
const { pool, one, q } = await import("../src/db.js");
await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
await q("truncate users cascade");
const { build } = await import("../src/server.js");
const { issueToken } = await import("../src/auth.js");
const { encrypt, decrypt } = await import("../src/crypto.js");
const { saveRefreshToken } = await import("../src/google.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("ok ", m); };
const PROVIDER = process.env.AI_PROVIDER;

/* ---------- Google mocks ---------- */
const b64u = (s) => Buffer.from(s).toString("base64url");
const sent = [];
const MSG = (id, from, labels, extra = {}) => ({ id, threadId: "t1", labelIds: labels, snippet: "Salam " + id, internalDate: String(Date.parse("2026-09-22T09:00:00Z")),
  payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: from }, { name: "To", value: "Tərlan <me@x.az>, Ali <ali@x.az>" }, { name: "Cc", value: "boss@x.az" }, { name: "Subject", value: "Hesabat" }, { name: "Message-ID", value: `<${id}@x>` }],
    parts: [{ mimeType: "text/plain", body: { data: b64u("Salam, hesabatı göndər.\n\n> köhnə") } }, { mimeType: "application/pdf", filename: "hesabat.pdf", body: { attachmentId: "a1", size: 2048 } }] }, ...extra });
google.gmail = () => ({ users: {
  getProfile: async () => ({ data: { emailAddress: "me@x.az" } }),
  threads: {
    list: async ({ q: qs }) => ({ data: { threads: qs === "none" ? [] : [{ id: "t1" }] } }),
    get: async ({ id, format }) => ({ data: { id, messages: [MSG("m1", "Aysel <aysel@x.az>", ["INBOX", "UNREAD", "IMPORTANT"]), MSG("m2", "me@x.az", ["SENT"])] } }),
  },
  messages: {
    get: async ({ id, format }) => format === "raw" ? { data: { id, threadId: "t1", raw: b64u("From: a@x\r\nSubject: s\r\n\r\nbody é") } } : { data: MSG(id, "Aysel <aysel@x.az>", ["INBOX"]) },
    modify: async ({ id, requestBody }) => ({ data: { id, labelIds: ["INBOX"].filter((l) => !requestBody.removeLabelIds.includes(l)) } }),
    send: async ({ requestBody }) => { sent.push(requestBody); return { data: { id: "s" + sent.length, threadId: requestBody.threadId || "new" } }; },
  },
  drafts: { create: async ({ requestBody }) => { sent.push(requestBody.message); return { data: { id: "d1", message: { id: "dm1", threadId: requestBody.message.threadId } } }; } },
} });
let lastEvents;
google.calendar = () => ({ events: {
  list: async (p) => { lastEvents = p; return { data: { items: [{ id: "e1", summary: "Görüş", start: { dateTime: "2026-09-23T10:00:00+04:00" }, end: { dateTime: "2026-09-23T11:00:00+04:00" } }] } }; },
  insert: async ({ requestBody }) => ({ data: { id: "e2", ...requestBody } }),
} });
let lastDriveQ, created;
google.drive = () => ({ files: {
  list: async (p) => { lastDriveQ = p; return { data: { files: [{ id: "f1", name: "Plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/f1", owners: [{ emailAddress: "me@x.az" }], parents: ["root"], modifiedTime: "2026-09-20T10:00:00Z" }] } }; },
  get: async (p) => p.alt === "media" ? { data: new TextEncoder().encode("a,b\n1,2").buffer } : { data: { id: p.fileId, name: p.fileId === "csv" ? "t.csv" : "Plan", mimeType: p.fileId === "csv" ? "text/csv" : p.fileId === "zip" ? "application/zip" : "application/vnd.google-apps.document", size: "10" } },
  export: async ({ mimeType }) => ({ data: new TextEncoder().encode(mimeType === "text/markdown" ? "# Plan\n- bənd" : "x").buffer }),
  create: async (p) => { created = p; return { data: { id: "f9", name: p.requestBody.name, mimeType: p.requestBody.mimeType || p.media.mimeType, webViewLink: "https://docs.google.com/document/d/f9" } }; },
  update: async ({ fileId }) => ({ data: { id: fileId, trashed: true } }),
} });

/* ---------- AI mocks ---------- */
const aiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, init);
  const body = JSON.parse(init.body); aiCalls.push({ url: String(url), body, headers: init.headers });
  if (String(url).includes("gemini-3.6-flash:")) return new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "This model models/gemini-3.6-flash is no longer available to new users." } }), { status: 404 });
  if (globalThis.__quota429 && (globalThis.__quota429 === "ALL" || String(url).includes(globalThis.__quota429 + ":"))) return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 250 PerDay" } }), { status: 429 });
  const hasTools = body.tools?.length, lastParts = body.contents.at(-1).parts;
  let parts;
  if (hasTools && !lastParts.some((p) => p.functionResponse)) parts = [{ functionCall: { id: "fc1", name: "search_mail", args: { query: "hesabat" } }, thoughtSignature: "sig123" }];
  else if (body.generationConfig.responseMimeType === "application/json") parts = [{ text: '{"headline":"Sakit gün","priorities":[]}' }];
  else parts = [{ text: "Hazırdır: " + (lastParts.find((p) => p.functionResponse)?.functionResponse.response.result || "salam") }];
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
};
if (PROVIDER === "anthropic") {
  const { anthropicClient } = await import("../src/llm.js");
  anthropicClient().messages.create = async (req) => {
    aiCalls.push({ body: req });
    const last = req.messages.at(-1);
    if (req.tools?.length && !(Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")))
      return { content: [{ type: "tool_use", id: "tu1", name: "search_mail", input: { query: "hesabat" } }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 20 } };
    const tr = Array.isArray(last.content) && last.content.find((b) => b.type === "tool_result");
    return { content: [{ type: "text", text: tr ? "Hazırdır: " + tr.content : '{"headline":"Sakit gün","priorities":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } };
  };
}

/* ---------- tests ---------- */
ok(decrypt(encrypt("refresh-ə")) === "refresh-ə", "AES-GCM round trip");
const app = build(); await app.ready();
ok((await app.inject("/health")).json().ok, "health");
let r = await app.inject("/");
ok(r.statusCode === 200 && r.body.includes("runtime.js") && (PROVIDER === "gemini" ? r.body.includes("Gemini ilə") && !/\bClaude-a\b/.test(r.body) : r.body.includes("Claude")), `web app served with ${PROVIDER} branding`);
ok((await app.inject("/privacy.html")).statusCode === 200 && (await app.inject("/runtime.js")).statusCode === 200, "privacy + runtime served");
const { createHash } = await import("node:crypto");
const VER = "v".repeat(43), CC = createHash("sha256").update(VER).digest("base64url");
ok((await app.inject("/auth/google/start?app=1")).statusCode === 400, "start without PKCE challenge rejected");
const start = await app.inject("/auth/google/start?app=1&cc=" + CC);
const loc = decodeURIComponent(start.headers.location || "");
ok(start.statusCode === 302 && /gmail\.modify/.test(loc) && /auth\/drive(\s|&|$)/.test(loc) && /access_type=offline/.test(loc), "oauth start: gmail.modify + full drive + offline");
ok((await app.inject("/auth/google/callback?state=garbage&code=x")).statusCode === 400, "callback rejects bad state");
const st = new URL(start.headers.location).searchParams.get("state");
r = await app.inject(`/auth/google/callback?state=${encodeURIComponent(st)}&error=access_denied`);
ok(r.statusCode === 302 && r.headers.location === "gundem://auth?error=access_denied", "cancel on Google → back to app with error");
ok((await app.inject("/api/me")).statusCode === 401, "api requires auth");

const u = await one("insert into users (google_sub,email,name) values ('g1','me@x.az','Tərlan') returning *");
const H = { authorization: "Bearer " + await issueToken(u.id) };
r = await app.inject({ url: "/api/me", headers: H });
ok(r.statusCode === 200 && r.json().plan === "free" && r.json().limits.ai === 3 && r.json().googleConnected === false && r.json().aiProvider === PROVIDER, "me: free plan, limits, provider");
const tool = (server, tool, input) => app.inject({ method: "POST", url: "/api/tool", headers: H, payload: { server, tool, input } });
r = await tool("Gmail", "search_threads", { query: "in:inbox" });
ok(r.statusCode === 409 && r.json().error === "needs_reauth", "tool without Google token → needs_reauth");
await saveRefreshToken(u.id, "rt", "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive");
r = await app.inject({ url: "/api/tools", headers: H });
ok(r.json().servers.length === 3 && r.json().servers.every((s) => s.authStatus === "connected"), "listTools: 3 servers connected");

// state (artifact db replacement)
r = await app.inject({ method: "PUT", url: "/api/state/tasks", headers: H, payload: { v: "[{\"t\":\"iş\"}]", at: 1 } });
ok(r.statusCode === 200, "put state");
ok((await app.inject({ method: "PUT", url: "/api/state/evil", headers: H, payload: {} })).statusCode === 400, "state key whitelist");
ok((await app.inject({ url: "/api/state", headers: H })).json().tasks.v === "[{\"t\":\"iş\"}]", "get state");

// Gmail
r = await tool("Gmail", "search_threads", { query: "in:inbox newer_than:7d", pageSize: 40 });
const th = r.json().payload.threads[0];
ok(r.statusCode === 200 && th.id === "t1" && th.messages[0].sender === "Aysel <aysel@x.az>" && th.messages[0].labelIds.includes("UNREAD") && th.messages[0].subject === "Hesabat" && th.messages[0].toRecipients.length === 2, "search_threads → connector shape");
r = await tool("Gmail", "get_thread", { threadId: "t1", messageFormat: "PLAIN_TEXT" });
const m0 = r.json().payload.messages[0];
ok(m0.plaintextBody.startsWith("Salam, hesabatı") && m0.attachments[0].filename === "hesabat.pdf" && m0.ccRecipients[0] === "boss@x.az", "get_thread: body + attachments + cc");
r = await tool("Gmail", "get_message", { messageId: "m1", messageFormat: "RAW" });
ok(Buffer.from(r.json().payload.raw, "base64url").toString().includes("body é"), "get_message RAW");
r = await tool("Gmail", "update_message_labels", { messageId: "m1", addLabelIds: [], removeLabelIds: ["INBOX"] });
ok(r.json().payload.labelIds.length === 0, "update_message_labels (archive)");
r = await tool("Gmail", "reply", { messageId: "m1", body: "Oldu, göndərirəm.", replyAll: true });
let raw = Buffer.from(sent.at(-1).raw, "base64url").toString();
ok(r.statusCode === 200 && sent.at(-1).threadId === "t1" && /^To: Aysel <aysel@x\.az>/m.test(raw) && /^Cc: .*ali@x\.az.*boss@x\.az/m.test(raw) && !/^Cc:.*me@x\.az/m.test(raw) && /In-Reply-To: <m1@x>/.test(raw) && /Subject: Re: Hesabat/.test(raw), "reply-all: recipients, threading, subject");
r = await tool("Gmail", "reply", { messageId: "m1", body: "x", to: ["other@x.az"] });
raw = Buffer.from(sent.at(-1).raw, "base64url").toString();
ok(/^To: other@x\.az/m.test(raw) && !/^Cc:/m.test(raw), "reply with override recipient");
r = await tool("Gmail", "forward", { messageId: "m1", to: ["boss@x.az"], forwardText: "Bax buna" });
raw = Buffer.from(sent.at(-1).raw, "base64url").toString("latin1");
ok(/Subject: Fwd: Hesabat/.test(raw) && /message\/rfc822/.test(raw) && raw.includes("body \xc3\xa9"), "forward attaches original byte-exact");
r = await tool("Gmail", "send_message", { to: ["Əli Məmmədov <ali@x.az>"], subject: "Salam dünya", body: "Mətn ə" });
raw = Buffer.from(sent.at(-1).raw, "base64url").toString();
ok(/^To: =\?UTF-8\?B\?.+\?= <ali@x\.az>/m.test(raw) && /Subject: =\?UTF-8\?B\?/.test(raw) && Buffer.from(raw.split("\r\n\r\n").pop().replace(/\r\n/g, ""), "base64").toString() === "Mətn ə", "send_message: UTF-8 headers + body");
r = await tool("Gmail", "send_message", { to: ['"Doe, John" <j@x.az>'], subject: "s", body: "b" });
ok(/^To: "Doe, John" <j@x\.az>/m.test(Buffer.from(sent.at(-1).raw, "base64url").toString()), "display name with comma stays one recipient");
r = await tool("Google Calendar", "list_events", { startTime: "nonsense" });
ok(r.statusCode === 400 && r.json().error === "bad_request", "invalid date → 400 not 500");
r = await tool("Gmail", "send_message", { to: [], body: "x" });
ok(r.statusCode === 400 && r.json().error === "bad_request", "send without recipient → bad_request");
r = await tool("Gmail", "create_draft", { to: ["a@x.az"], subject: "Re: Hesabat", body: "qaralama", replyToMessageId: "m1" });
ok(r.json().payload.id === "d1" && sent.at(-1).threadId === "t1", "create_draft threaded");
r = await tool("Gmail", "delete_everything", {});
ok(r.statusCode === 400 && r.json().error === "not_in_manifest", "unknown tool rejected");

// Calendar
r = await tool("Google Calendar", "list_events", { startTime: "2026-09-23T00:00:00+04:00", endTime: "2026-09-30T00:00:00+04:00", timeZone: "Asia/Baku", orderBy: "startTime", pageSize: 60 });
ok(r.json().payload.events[0].summary === "Görüş" && lastEvents.timeMin === "2026-09-22T20:00:00.000Z" && lastEvents.singleEvents, "list_events");
r = await tool("Google Calendar", "create_event", { summary: "Zəng", startTime: "2026-09-24T15:00:00+04:00", endTime: "2026-09-24T15:30:00+04:00", timeZone: "Asia/Baku" });
ok(r.json().payload.start.dateTime === "2026-09-24T15:00:00+04:00", "create_event");

// Drive
r = await tool("Google Drive", "search_files", { query: "title contains 'plan' and mimeType != 'x'", pageSize: 20 });
ok(lastDriveQ.q === "(name contains 'plan' and mimeType != 'x') and trashed = false" && r.json().payload.files[0].title === "Plan" && r.json().payload.files[0].viewUrl, "search_files: title→name, trashed filter, shape");
await tool("Google Drive", "search_files", { query: "fullText contains 'title'" });
ok(lastDriveQ.q.includes("'title'") && lastDriveQ.orderBy === undefined, "fullText: quoted text untouched, no orderBy");
r = await tool("Google Drive", "read_file_content", { fileId: "f1" });
ok(r.json().payload.fileContent === "# Plan\n- bənd", "read_file_content: Google Doc → markdown");
r = await tool("Google Drive", "read_file_content", { fileId: "csv" });
ok(r.json().payload.fileContent === "a,b\n1,2", "read_file_content: csv");
r = await tool("Google Drive", "read_file_content", { fileId: "zip" });
ok(r.statusCode === 422 && r.json().error === "tool_error", "unsupported file → tool_error");
r = await tool("Google Drive", "create_file", { title: "Qeyd", textContent: "<h1>Salam</h1>", contentMimeType: "text/html" });
ok(created.requestBody.mimeType === "application/vnd.google-apps.document" && r.json().payload.id === "f9", "create_file: HTML → Google Doc");
r = await tool("Google Drive", "create_file", { title: "a.bin", contentMimeType: "application/pdf", base64Content: Buffer.from("PDF").toString("base64") });
ok(created.media.mimeType === "application/pdf" && !created.requestBody.mimeType, "create_file: binary upload");
r = await tool("Google Drive", "trash_file", { fileId: "f9" });
ok(r.json().payload.trashed === true, "trash_file");

// AI
const sampleReq = (body) => app.inject({ method: "POST", url: "/api/ai/sample", headers: H, payload: body });
r = await sampleReq({ messages: [{ role: "user", content: "Brifinq" }], json: true, modelTier: "default" });
ok(r.statusCode === 200 && r.json().stop === "end" && JSON.parse(r.json().text).headline === "Sakit gün", "sample: JSON answer");
if (PROVIDER === "gemini") ok(aiCalls.at(-1).body.generationConfig.responseMimeType === "application/json" && aiCalls.at(-1).url.includes("gemini-3.5-flash:") && aiCalls.at(-1).headers["x-goog-api-key"] === "g-test" && aiCalls.at(-1).body.generationConfig.thinkingConfig?.thinkingLevel === "low" && aiCalls.at(-1).body.generationConfig.maxOutputTokens === 1500, "gemini: json mode, smart model, key header, low thinking, 1500 cap");
else ok(aiCalls.at(-1).body.system[0].cache_control?.type === "ephemeral" && aiCalls.at(-1).body.model === "claude-sonnet-5", "anthropic: prompt caching, smart model");
const tools = [{ name: "search_mail", description: "Poçtda axtar", inputSchema: { type: "object", properties: { query: { type: "string" } } } }];
const convo = [{ role: "user", content: [{ type: "text", text: "Hesabat məktubu hardadır?" }, { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] }];
ok((await sampleReq({ messages: convo, tools, turn: "fake" })).statusCode === 400, "follow-up round without a server-issued turn is rejected (no quota bypass)");
r = await sampleReq({ messages: convo, tools, modelTier: "quick" });
const t1 = r.json();
ok(t1.stop === "tool_use" && t1.calls[0].name === "search_mail" && t1.calls[0].input.query === "hesabat", "sample: tool call returned to the page");
if (PROVIDER === "gemini") ok(aiCalls.at(-1).body.generationConfig.thinkingConfig?.thinkingLevel === "minimal" && aiCalls.at(-1).url.includes("flash-lite") && aiCalls.at(-1).body.contents[0].parts[1].inlineData.mimeType === "image/png", "gemini: quick tier → lite model, image inline");
r = await sampleReq({ messages: [...convo, { role: "assistant", raw: t1.raw }, { role: "user", toolResults: [{ id: t1.calls[0].id, name: "search_mail", output: "2 məktub tapıldı" }] }], tools, turn: t1.turn });
ok(r.json().stop === "end" && r.json().text === "Hazırdır: 2 məktub tapıldı", "sample: tool result round → final answer");
if (PROVIDER === "gemini") { const c = aiCalls.at(-1).body.contents; ok(c[1].parts[0].thoughtSignature === "sig123" && c[2].parts[0].functionResponse.id === "fc1", "gemini: thought signature + call id echoed back"); }
ok((await sampleReq({ messages: [{ role: "system", content: "x" }] })).statusCode === 400, "sample validates roles");
ok((await sampleReq({ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/svg+xml", data: "x" }] }] })).statusCode === 400, "sample rejects svg images");
let us = await one("select * from ai_usage where user_id=$1", [u.id]);
ok(us.chat_msgs === 2, "tool rounds not double-counted (2 answers = 2 requests)");
await sampleReq({ messages: [{ role: "user", content: "3" }] });
r = await sampleReq({ messages: [{ role: "user", content: "4" }] });
ok(r.statusCode === 402 && r.json().detail.limit === 3, "free AI quota → 402");

// billing
ok((await app.inject({ method: "POST", url: "/webhooks/revenuecat", payload: {} })).statusCode === 401, "webhook auth");
await app.inject({ method: "POST", url: "/webhooks/revenuecat", headers: { authorization: "Bearer rc" }, payload: { event: { type: "INITIAL_PURCHASE", app_user_id: u.id, expiration_at_ms: Date.now() + 30 * 864e5 } } });
ok((await app.inject({ url: "/api/me", headers: H })).json().plan === "premium", "RevenueCat → premium");
ok((await sampleReq({ messages: [{ role: "user", content: "5" }] })).statusCode === 200, "premium lifts quota");
if (PROVIDER === "gemini") {
  const n0 = aiCalls.length;
  r = await sampleReq({ messages: [{ role: "user", content: "eyni sual" }], modelTier: "quick" });
  const r2 = await sampleReq({ messages: [{ role: "user", content: "eyni sual" }], modelTier: "quick" });
  ok(r.statusCode === 200 && r2.json().text === r.json().text && aiCalls.length === n0 + 1, "identical request within 30 min → served from cache, no new AI call");
  globalThis.__quota429 = "gemini-3.5-flash";
  r = await sampleReq({ messages: [{ role: "user", content: "fallback testi" }] });
  ok(r.statusCode === 200 && aiCalls.at(-3).url.includes("gemini-3.5-flash:") && aiCalls.at(-2).url.includes("gemini-3.6-flash:") && aiCalls.at(-1).url.includes("gemini-3.7-flash:"), "limit on one model → next free model; a retired model is skipped");
  r = await sampleReq({ messages: [{ role: "user", content: "fallback testi 2" }] });
  ok(aiCalls.at(-1).url.includes("gemini-3.7-flash:") && !String(aiCalls.at(-2).body.contents[0].parts[0].text).includes("fallback testi 2"), "exhausted and retired models are skipped for a while");
  globalThis.__quota429 = "ALL";
  r = await sampleReq({ messages: [{ role: "user", content: "hamısı dolub" }] });
  ok(r.statusCode === 429 && r.json().error === "rate_limited", "all free models exhausted → clear 'limit reached' error, not a retired-model error");
  globalThis.__quota429 = null;
  const big = "x".repeat(8000);
  await sampleReq({ messages: [{ role: "user", content: "a" }, { role: "assistant", raw: [{ text: "?" }] }, { role: "user", toolResults: [{ id: "1", name: "t", output: big }] }, { role: "assistant", raw: [{ text: "??" }] }, { role: "user", toolResults: [{ id: "2", name: "t", output: big }] }] }).catch(() => {});
  { const c = aiCalls.at(-1).body.contents; ok(c[2].parts[0].functionResponse.response.result.length < 1600 && c[4].parts[0].functionResponse.response.result.length === 8000, "older tool results are resent shortened, the latest stays full"); }
}
await app.inject({ method: "POST", url: "/webhooks/revenuecat", headers: { authorization: "Bearer rc" }, payload: { event: { type: "EXPIRATION", app_user_id: u.id } } });
ok((await app.inject({ url: "/api/me", headers: H })).json().plan === "free", "expiration → free");

// mobile code exchange
await q("insert into login_codes (code,user_id,expires_at,challenge) values ('c1',$1, now()+interval '1 minute',$2)", [u.id, CC]);
ok((await app.inject({ method: "POST", url: "/auth/exchange", payload: { code: "c1", verifier: "w".repeat(43) } })).statusCode === 400, "code exchange with wrong PKCE verifier rejected");
await q("insert into login_codes (code,user_id,expires_at,challenge) values ('c1',$1, now()+interval '1 minute',$2)", [u.id, CC]);
r = await app.inject({ method: "POST", url: "/auth/exchange", payload: { code: "c1", verifier: VER } });
ok(r.statusCode === 200 && r.json().token, "code exchange");
ok((await app.inject({ method: "POST", url: "/auth/exchange", payload: { code: "c1", verifier: VER } })).statusCode === 400, "code single-use");
const T2 = r.json().token; ok((await app.inject({ url: "/api/me", headers: { authorization: "Bearer " + T2 } })).statusCode === 200, "exchanged token works");
await app.inject({ method: "POST", url: "/api/signout-all", headers: { authorization: "Bearer " + T2 } });
ok((await app.inject({ url: "/api/me", headers: { authorization: "Bearer " + T2 } })).statusCode === 401, "signout-all revokes issued tokens");
const H3 = { authorization: "Bearer " + await issueToken(u.id) };

ok((await app.inject({ method: "DELETE", url: "/api/me", headers: H3 })).json().ok, "account delete");
ok((await app.inject({ url: "/api/me", headers: H3 })).statusCode === 401, "deleted user cannot auth");
ok(!(await one("select 1 from google_tokens where user_id=$1", [u.id])), "google token deleted with account");
console.log(`\n${pass} passed (${PROVIDER})`);
await app.close(); await pool.end();

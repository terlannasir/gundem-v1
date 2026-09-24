import { requireUser, forgetUser } from "../auth.js";
import { q, one } from "../db.js";
import { config } from "../config.js";
import { clientFor, forgetClient, oauthClient } from "../google.js";
import { decrypt } from "../crypto.js";
import { SERVERS, runTool, forgetUserThreads } from "../tools.js";
import { parseDocument, kindOf } from "../parse.js";
import { usage, limitsFor, sampleRequest } from "../ai.js";

const TOOL_CODES = new Set(["needs_reauth", "tool_error", "bad_request", "server_unavailable", "not_in_manifest"]);
const AI_CODES = new Set(["rate_limited", "upstream_error", "bad_request", "blocked"]);
const STATE_KEYS = ["profile", "settings", "tasks", "docs", "aicat", "brief"];

export default async function apiRoutes(app) {
  app.addHook("preHandler", requireUser);

  // ---- account ----
  app.get("/me", async (req) => {
    const u = await usage(req.user.id), lim = limitsFor(req.user);
    const g = await one("select scopes from google_tokens where user_id=$1", [req.user.id]);
    return { id: req.user.id, email: req.user.email, name: req.user.name, avatarUrl: req.user.avatar_url, plan: req.user.plan, planUntil: req.user.plan_until,
      googleConnected: !!g, aiProvider: config.ai.provider, usage: { ai: u.chat_msgs }, limits: lim };
  });
  app.delete("/me", async (req) => {   // App Store account-deletion requirement (5.1.1(v))
    const row = await one("select refresh_token from google_tokens where user_id=$1", [req.user.id]);
    if (row) { try { await oauthClient().revokeToken(decrypt(row.refresh_token)); } catch (e) { req.log.warn({ err: e.message }, "google revoke failed"); } }
    forgetClient(req.user.id);
    await q("delete from users where id=$1", [req.user.id]); forgetUser(req.user.id); forgetUserThreads(req.user.id);
    return { ok: true };
  });

  app.post("/signout-all", async (req) => {   // invalidates every issued token of this user (all devices)
    await q("update users set token_version = token_version + 1 where id=$1", [req.user.id]); forgetUser(req.user.id);
    return { ok: true };
  });

  // ---- synced app state (replaces the artifact db) ----
  app.get("/state", async (req) => Object.fromEntries((await q("select key, value, extract(epoch from updated_at)*1000 as at from user_state where user_id=$1", [req.user.id])).map((r) => [r.key, r.value])));
  app.put("/state/:key", async (req, reply) => {
    if (!STATE_KEYS.includes(req.params.key)) return reply.code(400).send({ error: "bad_key" });
    if (JSON.stringify(req.body ?? null).length > 512 * 1024) return reply.code(413).send({ error: "too_large" });
    await q(`insert into user_state (user_id, key, value) values ($1,$2,$3) on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`,
      [req.user.id, req.params.key, JSON.stringify(req.body ?? null)]);
    return { ok: true };
  });

  // ---- connector-compatible tools (Gmail / Google Calendar / Google Drive) ----
  app.get("/tools", async (req) => {
    const g = await one("select scopes from google_tokens where user_id=$1", [req.user.id]);
    return { servers: Object.entries(SERVERS).map(([server, s]) => ({ server, kind: "connector", tools: s.tools,
      authStatus: g && g.scopes.includes(s.scope) ? "connected" : "needs_reauth" })) };
  });
  app.post("/tool", { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const { server, tool, input } = req.body || {};
    if (!SERVERS[server]) return reply.code(400).send({ error: "not_in_manifest", message: "unknown server" });
    try {
      const payload = await runTool(await clientFor(req.user.id), server, tool, input, { uid: req.user.id });
      return { payload };
    } catch (e) {
      if (e.code === "needs_reauth") forgetClient(req.user.id);
      if (TOOL_CODES.has(e.code)) return reply.code(e.status || 500).send({ error: e.code, message: e.message, server, ...(e.retryable ? { retryable: true } : {}) });
      throw e;   // anything else (DB, bugs) → generic 500 without internals
    }
  });

  // ---- parse an email attachment the page already has (Excel etc.) in an isolated worker ----
  app.post("/parse", { bodyLimit: 12 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { name = "", kind, data } = req.body || {};
    const k = ["pdf", "docx", "xlsx"].includes(kind) ? kind : kindOf("", String(name));
    if (!k || typeof data !== "string") return reply.code(400).send({ error: "bad_request" });
    const buf = Buffer.from(data, "base64");
    if (buf.length > 8 * 1024 * 1024) return reply.code(413).send({ error: "too_large", message: "Fayl 8 MB-dan böyükdür" });
    try { return { text: await parseDocument(buf, k) }; }
    catch (e) { return reply.code(e.status || 422).send({ error: e.code || "tool_error", message: e.message }); }
  });

  // ---- AI (Claude or Gemini, see AI_PROVIDER) ----
  app.post("/ai/sample", { bodyLimit: 16 * 1024 * 1024, config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    try { return await sampleRequest(req.user, req.body || {}, req.log); }
    catch (e) {
      if (e.status === 402) throw e;
      if (AI_CODES.has(e.code)) return reply.code(e.status && e.status < 500 ? e.status : 502).send({ error: e.code, message: e.message });
      throw e;
    }
  });
}

import { requireUser } from "../auth.js";
import { q, one } from "../db.js";
import { config } from "../config.js";
import { clientFor, forgetClient } from "../google.js";
import { SERVERS, runTool } from "../tools.js";
import { usage, limitsFor, sampleRequest } from "../ai.js";

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
    if (row) { try { const c = await clientFor(req.user.id); await c.revokeCredentials(); } catch {} }
    forgetClient(req.user.id);
    await q("delete from users where id=$1", [req.user.id]);
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
      const payload = await runTool(await clientFor(req.user.id), server, tool, input);
      return { payload };
    } catch (e) {
      if (e.code === "needs_reauth") forgetClient(req.user.id);
      if (e.code) return reply.code(e.status || 500).send({ error: e.code, message: e.message, server, ...(e.retryable ? { retryable: true } : {}) });
      throw e;
    }
  });

  // ---- AI (Claude or Gemini, see AI_PROVIDER) ----
  app.post("/ai/sample", { bodyLimit: 16 * 1024 * 1024, config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    try { return await sampleRequest(req.user, req.body || {}, req.log); }
    catch (e) {
      if (e.status === 402) throw e;
      if (e.code && e.status && e.status < 500) return reply.code(e.status).send({ error: e.code, message: e.message });
      if (e.code) return reply.code(502).send({ error: e.code, message: e.message });
      throw e;
    }
  });
}

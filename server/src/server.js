import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { brand } from "./brand.js";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { pool } from "./db.js";
import authRoutes from "./routes/auth.js";
import apiRoutes from "./routes/api.js";
import billingRoutes from "./routes/billing.js";

export function build() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info", redact: ["req.headers.authorization"] }, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  app.register(cors, { origin: [config.webOrigin, config.publicUrl, "capacitor://localhost", "http://localhost", "https://localhost"], credentials: false });
  app.register(rateLimit, { max: 240, timeWindow: "1 minute", keyGenerator: (req) => req.headers.authorization?.slice(-24) || req.ip });
  app.addHook("onSend", async (req, reply) => { reply.header("x-content-type-options", "nosniff"); reply.header("referrer-policy", "no-referrer"); });
  app.get("/health", async () => ({ ok: true }));
  app.register(authRoutes);
  app.register(billingRoutes);
  app.register(apiRoutes, { prefix: "/api" });
  // The web app (web/index.html + runtime) is served from the same origin → no CORS, same login.
  const webDir = fileURLToPath(new URL("../web/", import.meta.url));
  if (existsSync(webDir)) {
    // index.html gets the assistant's name for the active AI provider (Claude / Gemini)
    const index = brand(readFileSync(webDir + "index.html", "utf8"), config.ai.provider);
    const sendIndex = (req, reply) => reply.header("cache-control", "no-cache").header("referrer-policy", "no-referrer").type("text/html; charset=utf-8").send(index);
    app.get("/", sendIndex); app.get("/index.html", sendIndex);
    app.register(fastifyStatic, { root: webDir, index: false, maxAge: 0, wildcard: true });
  }
  app.setErrorHandler((err, req, reply) => {
    const status = err.status || err.statusCode || (err.code === 401 || err.response?.status === 401 ? 409 : 500);
    if (status >= 500) req.log.error(err);
    const error = status === 409 ? "google_reconnect_required" : status === 402 ? "quota_exceeded" : status >= 500 ? "server_error" : err.message;
    reply.code(status).send({ error, ...(err.detail ? { detail: err.detail } : {}) });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // create/upgrade tables on boot (idempotent) — no separate migration step needed on Render
  await pool.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const app = build();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  const shutdown = async () => { await app.close(); await pool.end(); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

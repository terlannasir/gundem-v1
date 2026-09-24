import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { brand } from "./brand.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import authRoutes from "./routes/auth.js";
import apiRoutes from "./routes/api.js";
import billingRoutes from "./routes/billing.js";

// Content-Security-Policy: only our own scripts + the two pinned parser libraries (with SRI in the page).
// Styles need 'unsafe-inline' (the UI sets style attributes); no inline scripts are allowed.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/ https://cdn.jsdelivr.net/npm/mammoth@1.8.0/",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "frame-src 'self' blob:",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Rate-limit bucket: the signed-in user (id read from the token; forged ids are rejected by auth right after) or the IP.
function rateKey(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) {
    try { const sub = JSON.parse(Buffer.from(h.slice(7).split(".")[1], "base64url").toString()).sub; if (sub) return "u:" + String(sub).slice(0, 40); } catch {}
  }
  return "ip:" + req.ip;
}

export function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      redact: ["req.headers.authorization"],
      serializers: { req: (r) => ({ method: r.method, url: String(r.url).split("?")[0] }) },   // never log ?code= / ?state=
    },
    logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== "1" }),   // errors + "ai usage" lines only (saves CPU on the free tier)
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: 1,                                             // Render's proxy is the one hop we trust
  });
  app.register(cors, { origin: [...new Set([config.webOrigin, config.publicUrl])], credentials: false });
  app.register(compress, { global: true, threshold: 1024, encodings: ["br", "gzip"], brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } } });
  app.register(rateLimit, { max: 240, timeWindow: "1 minute", keyGenerator: rateKey });
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    const ct = String(reply.getHeader("content-type") || "");
    if (ct.startsWith("text/html")) { reply.header("content-security-policy", CSP); reply.header("cache-control", "no-cache"); }
    if (/\/sw\.js$/.test(req.url.split("?")[0])) reply.header("cache-control", "no-cache");
  });
  app.get("/health", async () => ({ ok: true }));
  app.register(authRoutes);
  app.register(billingRoutes);
  app.register(apiRoutes, { prefix: "/api" });

  // The web app is served from the same origin → no CORS, same login.
  const webDir = fileURLToPath(new URL("../web/", import.meta.url));
  if (existsSync(webDir)) {
    // index.html + app.js carry the assistant's name for the active AI provider (Claude / Gemini);
    // both are prepared once: branded, pre-compressed, with an ETag (→ 304 on repeat opens)
    const prep = (text, type, extra = {}) => {
      const body = Buffer.from(text);
      return { type, body, etag: '"' + createHash("sha1").update(body).digest("base64url") + '"', extra,
        br: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), gz: zlib.gzipSync(body, { level: 9 }) };
    };
    const P = config.ai.provider;
    const indexSrc = brand(readFileSync(webDir + "index.html", "utf8"), P).replace(/app\.js\?v=([\w]+)/, `app.js?v=$1-${P}`);
    const INDEX = prep(indexSrc, "text/html; charset=utf-8");
    const APP = existsSync(webDir + "app.js") ? prep(brand(readFileSync(webDir + "app.js", "utf8"), P), "text/javascript; charset=utf-8", { "cache-control": "public, max-age=31536000, immutable" }) : null;
    const serve = (f) => (req, reply) => {
      reply.header("etag", f.etag).header("vary", "accept-encoding").type(f.type);
      for (const [k, v] of Object.entries(f.extra)) reply.header(k, v);
      if (req.headers["if-none-match"] === f.etag) return reply.code(304).send();
      const ae = String(req.headers["accept-encoding"] || "");
      if (/\bbr\b/.test(ae)) return reply.header("content-encoding", "br").send(f.br);
      if (/\bgzip\b/.test(ae)) return reply.header("content-encoding", "gzip").send(f.gz);
      return reply.send(f.body);
    };
    app.get("/", serve(INDEX)); app.get("/index.html", serve(INDEX));
    if (APP) app.get("/app.js", serve(APP));
    // assets are referenced as file?v=<hash> → safe to cache for a year
    app.register(fastifyStatic, { root: webDir, index: false, wildcard: true, maxAge: "365d", immutable: true });
  }
  app.setErrorHandler((err, req, reply) => {
    const status = err.status || err.statusCode || (err.code === 401 || err.response?.status === 401 ? 409 : 500);
    if (status >= 500) req.log.error(err);
    const error = status === 409 ? "google_reconnect_required" : status === 402 ? "quota_exceeded" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : err.message;
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

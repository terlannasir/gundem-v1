import { createHash } from "node:crypto";
const req = (k) => { const v = process.env[k]; if (!v) throw new Error(`Missing env ${k}`); return v; };
const num = (k, d) => Number(process.env[k] ?? d);

const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "anthropic")).toLowerCase();
if (!["gemini", "anthropic"].includes(provider)) throw new Error("AI_PROVIDER must be gemini or anthropic");
if (provider === "gemini") req("GEMINI_API_KEY"); else req("ANTHROPIC_API_KEY");

// Render sets RENDER_EXTERNAL_URL automatically (https://<name>.onrender.com)
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || req("PUBLIC_URL")).replace(/\/$/, "");
// 32-byte key for encrypting Google tokens: base64 of 32 bytes, or any long random string (hashed to 32 bytes)
const rawKey = req("TOKEN_ENC_KEY"), keyB64 = Buffer.from(rawKey, "base64");
const tokenKey = keyB64.length === 32 ? keyB64 : createHash("sha256").update(rawKey).digest();

export const config = {
  port: num("PORT", 8080),
  publicUrl,
  // Where the web app lives. Default: served by this same server at PUBLIC_URL.
  webOrigin: (process.env.WEB_ORIGIN || publicUrl).replace(/\/$/, ""),
  appScheme: process.env.APP_SCHEME || "gundem",
  jwtSecret: new TextEncoder().encode(req("JWT_SECRET")),
  tokenKey,
  databaseUrl: req("DATABASE_URL"),
  google: { clientId: req("GOOGLE_CLIENT_ID"), clientSecret: req("GOOGLE_CLIENT_SECRET") },
  // "full" = whole Drive (needed to list the user's existing docs; fine in Testing mode).
  // "file" = only files this app created (no restricted-scope review, but the Docs list starts empty).
  driveScope: process.env.DRIVE_SCOPE === "file" ? "file" : "full",

  ai: {
    provider,
    anthropicKey: process.env.ANTHROPIC_API_KEY || "",
    geminiKey: process.env.GEMINI_API_KEY || "",
    models: provider === "gemini"
      ? { smart: process.env.MODEL_SMART || "gemini-3.5-flash", fast: process.env.MODEL_FAST || "gemini-3.5-flash-lite" }
      : { smart: process.env.MODEL_SMART || "claude-sonnet-5", fast: process.env.MODEL_FAST || "claude-haiku-4-5-20251001" },
  },
  // USD per 1M tokens [input, output]. Gemini free tier = 0. Keep in sync with the providers' pricing pages.
  prices: { "claude-sonnet-5": [2, 10], "claude-haiku-4-5-20251001": [1, 5], "claude-opus-5-5": [4, 20] },

  // Monthly AI request limits per plan (one request = one Claude/Gemini answer, tool rounds included)
  limits: {
    free: { ai: num("FREE_AI_REQUESTS", 600) },
    premium: { ai: num("PREMIUM_AI_REQUESTS", 6000) },
  },
  revenuecatSecret: process.env.REVENUECAT_WEBHOOK_SECRET || "",
};
if (rawKey.length < 24) throw new Error("TOKEN_ENC_KEY is too short — use: openssl rand -base64 32");

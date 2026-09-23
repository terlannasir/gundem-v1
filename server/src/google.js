import { google } from "googleapis";
import { config } from "./config.js";
import { one, q } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

// gmail.modify and full drive are RESTRICTED scopes → Google verification + annual CASA audit before a PUBLIC launch.
// In "Testing" mode up to 100 listed test users can sign in without any review.
export const SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  config.driveScope === "file" ? "https://www.googleapis.com/auth/drive.file" : "https://www.googleapis.com/auth/drive",
];

export const oauthClient = () => new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, `${config.publicUrl}/auth/google/callback`);

export async function saveRefreshToken(userId, token, scopes) {
  await q(`insert into google_tokens (user_id, refresh_token, scopes) values ($1,$2,$3)
           on conflict (user_id) do update set refresh_token = excluded.refresh_token, scopes = excluded.scopes, updated_at = now()`,
    [userId, encrypt(token), scopes]);
}

/** Authorized client for a user (cached ~50 min so access tokens are reused); throws {status:409} when Google must be reconnected */
const cache = new Map();
export function forgetClient(userId) { cache.delete(userId); }
export async function clientFor(userId) {
  const hit = cache.get(userId);
  if (hit && hit.until > Date.now()) return hit.client;
  const row = await one("select refresh_token from google_tokens where user_id = $1", [userId]);
  if (!row) throw Object.assign(new Error("google_not_connected"), { status: 409, code: "needs_reauth" });
  const c = oauthClient();
  c.setCredentials({ refresh_token: decrypt(row.refresh_token) });
  c.on("tokens", (t) => { if (t.refresh_token) saveRefreshToken(userId, t.refresh_token, t.scope || SCOPES.join(" ")).catch(() => {}); });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  cache.set(userId, { client: c, until: Date.now() + 50 * 60e3 });
  return c;
}

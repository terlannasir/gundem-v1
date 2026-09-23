import { google } from "googleapis";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { issueToken } from "../auth.js";
import { SCOPES, oauthClient, saveRefreshToken, forgetClient } from "../google.js";
import { randomCode, encrypt, decrypt } from "../crypto.js";

// Login = Google OAuth + a one-time code bound to the starting tab/device with PKCE:
//   client makes a random `verifier`, sends sha256(verifier) as `cc` to /auth/google/start
//   web:  … → callback → WEB_ORIGIN/#code=…           → POST /auth/exchange {code, verifier}
//   iOS:  … → callback → gundem://auth?code=…          → POST /auth/exchange {code, verifier}
// A stolen/injected code is useless without the verifier, and no token ever appears in a URL.
const B64URL = /^[A-Za-z0-9_-]{43}$/;
const s256 = (v) => createHash("sha256").update(v).digest("base64url");

export default async function authRoutes(app) {
  app.get("/auth/google/start", async (req, reply) => {
    const cc = String(req.query.cc || "");
    if (!B64URL.test(cc)) return reply.code(400).send({ error: "missing_challenge" });
    const state = encrypt(JSON.stringify({ app: req.query.app === "1", cc, t: Date.now() }));
    const url = oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", include_granted_scopes: true, scope: SCOPES, state });
    return reply.redirect(url);
  });

  app.get("/auth/google/callback", async (req, reply) => {
    let st; try { st = JSON.parse(decrypt(String(req.query.state || ""))); } catch { return reply.code(400).send({ error: "bad_state" }); }
    if (Date.now() - st.t > 10 * 60e3) return reply.code(400).send({ error: "state_expired" });
    const back = (params) => reply.redirect(st.app ? `${config.appScheme}://auth?${params}` : `${config.webOrigin}/#${params}`);
    if (req.query.error) return back("error=" + encodeURIComponent(String(req.query.error).slice(0, 60)));   // "Cancel" on Google's screen
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code));
    client.setCredentials(tokens);
    const { data: me } = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
    const user = await one(`insert into users (google_sub, email, name, avatar_url) values ($1,$2,$3,$4)
      on conflict (google_sub) do update set email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url, deleted_at = null
      returning *`, [me.id, me.email, me.name, me.picture]);
    if (tokens.refresh_token) { await saveRefreshToken(user.id, tokens.refresh_token, tokens.scope || SCOPES.join(" ")); forgetClient(user.id); }
    const code = randomCode(24);
    await q("insert into login_codes (code, user_id, expires_at, challenge) values ($1,$2, now() + interval '3 minutes', $3)", [code, user.id, st.cc]);
    return back("code=" + code);
  });

  app.post("/auth/exchange", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const code = String(req.body?.code || ""), verifier = String(req.body?.verifier || "");
    const row = await one("delete from login_codes where code = $1 and expires_at > now() returning user_id, challenge", [code]);
    if (!row || !row.challenge || !verifier || s256(verifier) !== row.challenge) return reply.code(400).send({ error: "invalid_code" });
    return { token: await issueToken(row.user_id) };
  });
}

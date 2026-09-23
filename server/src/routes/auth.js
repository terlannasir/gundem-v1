import { google } from "googleapis";
import { config } from "../config.js";
import { one, q } from "../db.js";
import { issueToken } from "../auth.js";
import { SCOPES, oauthClient, saveRefreshToken } from "../google.js";
import { randomCode, encrypt, decrypt } from "../crypto.js";

export default async function authRoutes(app) {
  // Web: GET /auth/google/start            → Google → callback → redirect WEB_ORIGIN/#token=...
  // App: GET /auth/google/start?app=1      → Google → callback → gundem://auth?code=... → POST /auth/exchange
  app.get("/auth/google/start", async (req, reply) => {
    const state = encrypt(JSON.stringify({ app: req.query.app === "1", t: Date.now() }));
    const url = oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", include_granted_scopes: true, scope: SCOPES, state });
    return reply.redirect(url);
  });

  app.get("/auth/google/callback", async (req, reply) => {
    let st; try { st = JSON.parse(decrypt(String(req.query.state || ""))); } catch { return reply.code(400).send({ error: "bad_state" }); }
    if (Date.now() - st.t > 10 * 60e3) return reply.code(400).send({ error: "state_expired" });
    if (req.query.error) {   // user pressed "Cancel" on Google's screen → back to the app's login screen
      const err = encodeURIComponent(String(req.query.error).slice(0, 60));
      return reply.redirect(st.app ? `${config.appScheme}://auth?error=${err}` : `${config.webOrigin}/#auth_error=${err}`);
    }
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code));
    client.setCredentials(tokens);
    const { data: me } = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
    const user = await one(`insert into users (google_sub, email, name, avatar_url) values ($1,$2,$3,$4)
      on conflict (google_sub) do update set email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url, deleted_at = null
      returning *`, [me.id, me.email, me.name, me.picture]);
    if (tokens.refresh_token) await saveRefreshToken(user.id, tokens.refresh_token, tokens.scope || SCOPES.join(" "));
    if (st.app) {
      const code = randomCode(24);
      await q("insert into login_codes (code, user_id, expires_at) values ($1,$2, now() + interval '2 minutes')", [code, user.id]);
      return reply.redirect(`${config.appScheme}://auth?code=${code}`);
    }
    const token = await issueToken(user.id);
    return reply.redirect(`${config.webOrigin}/#token=${token}`);
  });

  app.post("/auth/exchange", async (req, reply) => {
    const code = String(req.body?.code || "");
    const row = await one("delete from login_codes where code = $1 and expires_at > now() returning user_id", [code]);
    if (!row) return reply.code(400).send({ error: "invalid_code" });
    return { token: await issueToken(row.user_id) };
  });
}

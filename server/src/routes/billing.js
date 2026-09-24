import { config } from "../config.js";
import { q } from "../db.js";
import { timingSafeEqual } from "node:crypto";
import { forgetUser } from "../auth.js";
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// RevenueCat → Webhooks. Set the app_user_id in the app to our user id (Purchases.logIn(userId)).
const ACTIVE = new Set(["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION", "SUBSCRIPTION_EXTENDED", "TEMPORARY_ENTITLEMENT_GRANT"]);
const ENDED = new Set(["EXPIRATION"]);

export default async function billingRoutes(app) {
  app.post("/webhooks/revenuecat", async (req, reply) => {
    if (!config.revenuecatSecret || !safeEq(req.headers.authorization || "", `Bearer ${config.revenuecatSecret}`)) return reply.code(401).send({ error: "unauthorized" });
    const ev = req.body?.event || {};
    const userId = ev.app_user_id;
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return { ok: true, ignored: true };
    if (ACTIVE.has(ev.type)) await q("update users set plan='premium', plan_until=to_timestamp($2/1000.0) where id=$1", [userId, ev.expiration_at_ms || Date.now() + 31 * 864e5]);
    else if (ENDED.has(ev.type)) await q("update users set plan='free', plan_until=null where id=$1", [userId]);
    forgetUser(userId);
    return { ok: true };
  });
}

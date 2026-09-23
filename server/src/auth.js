import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";
import { one } from "./db.js";

export async function issueToken(userId) {
  const u = await one("select token_version from users where id = $1", [userId]);
  return new SignJWT({ sub: userId, v: u?.token_version ?? 0 }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d").sign(config.jwtSecret);
}

/** Fastify preHandler: requires "Authorization: Bearer <jwt>", attaches req.user */
export async function requireUser(req, reply) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return reply.code(401).send({ error: "unauthorized" });
  try {
    const { payload } = await jwtVerify(tok, config.jwtSecret);
    const user = await one("select * from users where id = $1 and deleted_at is null", [payload.sub]);
    if (!user || (payload.v ?? 0) !== user.token_version) return reply.code(401).send({ error: "unauthorized" });
    if (user.plan === "premium" && user.plan_until && new Date(user.plan_until) < new Date()) user.plan = "free";
    req.user = user;
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

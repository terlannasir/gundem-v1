import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";
import { one } from "./db.js";

export async function issueToken(userId) {
  return new SignJWT({ sub: userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d").sign(config.jwtSecret);
}

/** Fastify preHandler: requires "Authorization: Bearer <jwt>", attaches req.user */
export async function requireUser(req, reply) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return reply.code(401).send({ error: "unauthorized" });
  try {
    const { payload } = await jwtVerify(tok, config.jwtSecret);
    const user = await one("select * from users where id = $1 and deleted_at is null", [payload.sub]);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (user.plan === "premium" && user.plan_until && new Date(user.plan_until) < new Date()) user.plan = "free";
    req.user = user;
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

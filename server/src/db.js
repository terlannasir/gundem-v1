import pg from "pg";
import { config } from "./config.js";

const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl);
// Supabase → Database → SSL Configuration → "Download certificate"; paste the PEM into DATABASE_CA to verify the server.
const ssl = local ? false : config.databaseCa ? { ca: config.databaseCa, rejectUnauthorized: true } : { rejectUnauthorized: false };
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, idleTimeoutMillis: 300000, keepAlive: true, ssl });
pool.on("error", () => {});   // a dropped idle connection must not crash the process
export const q = (text, params) => pool.query(text, params).then((r) => r.rows);
export const one = async (text, params) => (await q(text, params))[0] || null;

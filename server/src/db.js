import pg from "pg";
import { config } from "./config.js";
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false } });
export const q = (text, params) => pool.query(text, params).then((r) => r.rows);
export const one = async (text, params) => (await q(text, params))[0] || null;

import { createRequire } from "node:module";
import { pool } from "./database.js";
import { env } from "./env.js";

const require = createRequire(import.meta.url);
const session = require("express-session") as typeof import("express-session");
const connectPgSimple = require("connect-pg-simple") as typeof import("connect-pg-simple");
const PgSessionStore = connectPgSimple(session);

export function createSessionMiddleware() {
  return session({
    name: env.SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new PgSessionStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    cookie: {
      httpOnly: true,
      maxAge: env.SESSION_TTL_MS,
      sameSite: env.NODE_ENV === "production" ? "none" : "lax",
      secure: env.NODE_ENV === "production"
    }
  });
}

import { Router } from "express";
import { z } from "zod";
import {
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  requireAuth,
  signAccessToken,
  storeRefreshToken,
  verifyPassword
} from "../auth.js";
import { pool } from "../db.js";
import { HttpError } from "../errors.js";
import type { AuthUser } from "../types.js";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

function authResponse(user: AuthUser, refreshToken: string) {
  return {
    user,
    accessToken: signAccessToken(user),
    refreshToken
  };
}

router.post("/register", async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const result = await pool.query<AuthUser>(
      "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name",
      [input.email.toLowerCase(), input.name, passwordHash]
    );

    const user = result.rows[0];
    const refreshToken = createRefreshToken();
    await storeRefreshToken(user.id, refreshToken);
    res.status(201).json(authResponse(user, refreshToken));
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const result = await pool.query<{ id: string; email: string; name: string; password_hash: string }>(
      "SELECT id, email, name, password_hash FROM users WHERE email = $1",
      [input.email.toLowerCase()]
    );
    const userRecord = result.rows[0];
    if (!userRecord || !(await verifyPassword(input.password, userRecord.password_hash))) {
      throw new HttpError(401, "Invalid email or password");
    }

    const user = { id: userRecord.id, email: userRecord.email, name: userRecord.name };
    const refreshToken = createRefreshToken();
    await storeRefreshToken(user.id, refreshToken);
    res.json(authResponse(user, refreshToken));
  } catch (error) {
    next(error);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const input = refreshSchema.parse(req.body);
    const tokenHash = hashRefreshToken(input.refreshToken);
    const result = await pool.query<AuthUser & { token_id: string }>(
      `SELECT u.id, u.email, u.name, rt.id AS token_id
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
         AND rt.revoked_at IS NULL
         AND rt.expires_at > now()`,
      [tokenHash]
    );

    const row = result.rows[0];
    if (!row) {
      throw new HttpError(401, "Invalid refresh token");
    }

    await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [row.token_id]);
    const user = { id: row.id, email: row.email, name: row.name };
    const refreshToken = createRefreshToken();
    await storeRefreshToken(user.id, refreshToken);
    res.json(authResponse(user, refreshToken));
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const input = refreshSchema.parse(req.body);
    await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [
      hashRefreshToken(input.refreshToken)
    ]);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export { router as authRoutes };


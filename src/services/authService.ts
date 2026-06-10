import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

type TokenPayload = {
  sub: string;
  email: string;
  name: string;
};

export async function registerUser(input: {
  email: string;
  name: string;
  password: string;
}) {
  const passwordHash = await hashPassword(input.password);
  const result = await pool.query<AuthUser>(
    "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name",
    [input.email.toLowerCase(), input.name, passwordHash]
  );

  const user = result.rows[0];
  const refreshToken = createRefreshToken();
  await storeRefreshToken(user.id, refreshToken);
  return authResponse(user, refreshToken);
}

export async function loginUser(input: { email: string; password: string }) {
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
  return authResponse(user, refreshToken);
}

export async function refreshSession(refreshTokenInput: string) {
  const tokenHash = hashRefreshToken(refreshTokenInput);
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
  return authResponse(user, refreshToken);
}

export async function logoutSession(refreshTokenInput: string): Promise<void> {
  await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [
    hashRefreshToken(refreshTokenInput)
  ]);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(user: AuthUser): string {
  const payload: TokenPayload = { sub: user.id, email: user.email, name: user.name };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL } as SignOptions);
}

export function verifyAccessToken(token: string): AuthUser {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload;
  return {
    id: decoded.sub,
    email: decoded.email,
    name: decoded.name
  };
}

export function createRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiresAt(): Date {
  const days = env.REFRESH_TOKEN_TTL.endsWith("d")
    ? Number(env.REFRESH_TOKEN_TTL.replace("d", ""))
    : 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function storeRefreshToken(userId: string, token: string): Promise<void> {
  await pool.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, hashRefreshToken(token), refreshTokenExpiresAt()]
  );
}

function authResponse(user: AuthUser, refreshToken: string) {
  return {
    user,
    accessToken: signAccessToken(user),
    refreshToken
  };
}


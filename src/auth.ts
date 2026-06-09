import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { pool } from "./db.js";
import { env } from "./env.js";
import { HttpError } from "./errors.js";
import type { AuthUser } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

type TokenPayload = {
  sub: string;
  email: string;
  name: string;
};

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

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "Missing bearer token");
    }

    const token = header.slice("Bearer ".length);
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload;
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name
    };
    next();
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }
    next(new HttpError(401, "Invalid or expired token"));
  }
}


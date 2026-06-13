import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { generateSecret, generateURI, verifySync } from "otplib";
import { pool, withTransaction } from "../config/database.js";
import { HttpError } from "../utils/errors.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "./emailService.js";

type AuthUserRow = {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
  twoFactorEnabled: boolean;
};

type UserWithSecretsRow = AuthUserRow & {
  password_hash: string;
  two_factor_secret: string | null;
};

type AuthTokenPurpose = "email_verification" | "password_reset";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function registerUser(input: {
  email: string;
  name: string;
  password: string;
}) {
  const passwordHash = await hashPassword(input.password);
  const email = input.email.toLowerCase();

  try {
    const result = await pool.query<AuthUserRow>(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, email_verified_at AS "emailVerifiedAt", two_factor_enabled AS "twoFactorEnabled"`,
      [email, input.name, passwordHash]
    );

    const user = normalizeUser(result.rows[0]);
    const token = await createAuthToken(user.id, "email_verification", EMAIL_VERIFICATION_TTL_MS);
    await sendVerificationEmail(user, token);

    return { user, emailVerificationRequired: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "Email is already registered");
    }
    throw error;
  }
}

export async function loginUser(input: { email: string; password: string }) {
  const userRecord = await getUserWithSecretsByEmail(input.email.toLowerCase());
  if (!userRecord || !(await verifyPassword(input.password, userRecord.password_hash))) {
    throw new HttpError(401, "Invalid email or password");
  }

  const user = normalizeUser(userRecord);
  if (!user.emailVerifiedAt) {
    throw new HttpError(403, "Email verification required");
  }

  if (userRecord.twoFactorEnabled) {
    return {
      twoFactorRequired: true,
      challengeToken: await createTwoFactorLoginChallenge(user.id)
    };
  }

  return authResponse(user);
}

export async function completeTwoFactorLogin(input: { challengeToken: string; code: string }) {
  const user = await consumeTwoFactorLoginChallenge(input.challengeToken);
  const userRecord = await getUserWithSecretsById(user.id);
  if (!userRecord?.two_factor_secret || !verifyTotp(input.code, userRecord.two_factor_secret)) {
    throw new HttpError(401, "Invalid two-factor code");
  }

  return authResponse(normalizeUser(userRecord));
}

export async function getUserById(userId: string): Promise<AuthUser> {
  const result = await pool.query<AuthUserRow>(
    `SELECT id, email, name, email_verified_at AS "emailVerifiedAt", two_factor_enabled AS "twoFactorEnabled"
     FROM users
     WHERE id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user) {
    throw new HttpError(401, "Invalid session");
  }

  return normalizeUser(user);
}

export async function verifyEmailToken(token: string) {
  const userId = await consumeAuthToken(token, "email_verification");
  const result = await pool.query<AuthUserRow>(
    `UPDATE users
     SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
     WHERE id = $1
     RETURNING id, email, name, email_verified_at AS "emailVerifiedAt", two_factor_enabled AS "twoFactorEnabled"`,
    [userId]
  );

  return authResponse(normalizeUser(result.rows[0]));
}

export async function resendVerificationEmail(emailInput: string): Promise<void> {
  const user = await getUserByEmail(emailInput.toLowerCase());
  if (!user || user.emailVerifiedAt) {
    return;
  }

  const token = await createAuthToken(user.id, "email_verification", EMAIL_VERIFICATION_TTL_MS);
  await sendVerificationEmail(user, token);
}

export async function requestPasswordReset(emailInput: string): Promise<void> {
  const user = await getUserByEmail(emailInput.toLowerCase());
  if (!user) {
    return;
  }

  const token = await createAuthToken(user.id, "password_reset", PASSWORD_RESET_TTL_MS);
  await sendPasswordResetEmail(user, token);
}

export async function resetPassword(input: { token: string; password: string }): Promise<void> {
  const userId = await consumeAuthToken(input.token, "password_reset");
  const passwordHash = await hashPassword(input.password);
  await pool.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [
    passwordHash,
    userId
  ]);
}

export async function updateProfile(userId: string, input: { name: string }) {
  const result = await pool.query<AuthUserRow>(
    `UPDATE users
     SET name = $1, updated_at = now()
     WHERE id = $2
     RETURNING id, email, name, email_verified_at AS "emailVerifiedAt", two_factor_enabled AS "twoFactorEnabled"`,
    [input.name, userId]
  );

  return authResponse(normalizeUser(result.rows[0]));
}

export async function updatePassword(userId: string, input: { currentPassword: string; newPassword: string }): Promise<void> {
  const userRecord = await getUserWithSecretsById(userId);
  if (!userRecord || !(await verifyPassword(input.currentPassword, userRecord.password_hash))) {
    throw new HttpError(401, "Current password is incorrect");
  }

  const passwordHash = await hashPassword(input.newPassword);
  await pool.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [
    passwordHash,
    userId
  ]);
}

export function createTwoFactorSetup(user: AuthUser) {
  const secret = generateSecret();
  return {
    secret,
    otpauthUrl: generateURI({
      issuer: "Smart Meeting Assistant",
      label: user.email,
      secret
    })
  };
}

export async function enableTwoFactor(userId: string, input: { secret: string; code: string }) {
  if (!verifyTotp(input.code, input.secret)) {
    throw new HttpError(400, "Invalid two-factor code");
  }

  const result = await pool.query<AuthUserRow>(
    `UPDATE users
     SET two_factor_enabled = true, two_factor_secret = $1, updated_at = now()
     WHERE id = $2
     RETURNING id, email, name, email_verified_at AS "emailVerifiedAt", two_factor_enabled AS "twoFactorEnabled"`,
    [input.secret, userId]
  );

  return authResponse(normalizeUser(result.rows[0]));
}

export async function disableTwoFactor(userId: string, input: { password: string; code: string }) {
  const userRecord = await getUserWithSecretsById(userId);
  if (!userRecord || !(await verifyPassword(input.password, userRecord.password_hash))) {
    throw new HttpError(401, "Password is incorrect");
  }
  if (!userRecord.two_factor_secret || !verifyTotp(input.code, userRecord.two_factor_secret)) {
    throw new HttpError(400, "Invalid two-factor code");
  }

  const result = await pool.query<AuthUserRow>(
    `UPDATE users
     SET two_factor_enabled = false, two_factor_secret = NULL, updated_at = now()
     WHERE id = $1
     RETURNING id, email, name, email_verified_at AS "emailVerifiedAt", two_factor_enabled AS "twoFactorEnabled"`,
    [userId]
  );

  return authResponse(normalizeUser(result.rows[0]));
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

async function getUserByEmail(email: string): Promise<AuthUser | null> {
  const result = await pool.query<AuthUserRow>(
    `SELECT id, email, name, email_verified_at AS "emailVerifiedAt", two_factor_enabled AS "twoFactorEnabled"
     FROM users
     WHERE email = $1`,
    [email]
  );

  return result.rows[0] ? normalizeUser(result.rows[0]) : null;
}

async function getUserWithSecretsByEmail(email: string): Promise<UserWithSecretsRow | null> {
  const result = await pool.query<UserWithSecretsRow>(
    `SELECT id, email, name, password_hash, email_verified_at AS "emailVerifiedAt",
            two_factor_enabled AS "twoFactorEnabled", two_factor_secret
     FROM users
     WHERE email = $1`,
    [email]
  );

  return result.rows[0] ?? null;
}

async function getUserWithSecretsById(userId: string): Promise<UserWithSecretsRow | null> {
  const result = await pool.query<UserWithSecretsRow>(
    `SELECT id, email, name, password_hash, email_verified_at AS "emailVerifiedAt",
            two_factor_enabled AS "twoFactorEnabled", two_factor_secret
     FROM users
     WHERE id = $1`,
    [userId]
  );

  return result.rows[0] ?? null;
}

async function createAuthToken(userId: string, purpose: AuthTokenPurpose, ttlMs: number): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);

  await withTransaction(async (client) => {
    await client.query(
      "UPDATE auth_tokens SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL",
      [userId, purpose]
    );
    await client.query(
      "INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, $4)",
      [userId, tokenHash, purpose, expiresAt]
    );
  });

  return token;
}

async function consumeAuthToken(token: string, purpose: AuthTokenPurpose): Promise<string> {
  const tokenHash = hashToken(token);
  const result = await pool.query<{ id: string; user_id: string }>(
    `UPDATE auth_tokens
     SET consumed_at = now()
     WHERE id = (
       SELECT id
       FROM auth_tokens
       WHERE token_hash = $1
         AND purpose = $2
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
     )
     RETURNING id, user_id`,
    [tokenHash, purpose]
  );

  const tokenRow = result.rows[0];
  if (!tokenRow) {
    throw new HttpError(400, "Invalid or expired token");
  }

  return tokenRow.user_id;
}

async function createTwoFactorLoginChallenge(userId: string): Promise<string> {
  const challengeToken = crypto.randomBytes(32).toString("base64url");
  const challengeHash = hashToken(challengeToken);
  await pool.query(
    "INSERT INTO two_factor_login_challenges (user_id, challenge_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, challengeHash, new Date(Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS)]
  );

  return challengeToken;
}

async function consumeTwoFactorLoginChallenge(challengeToken: string): Promise<AuthUser> {
  const challengeHash = hashToken(challengeToken);
  const result = await pool.query<AuthUserRow>(
    `UPDATE two_factor_login_challenges
     SET consumed_at = now()
     WHERE id = (
       SELECT id
       FROM two_factor_login_challenges
       WHERE challenge_hash = $1
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
     )
     RETURNING user_id`,
    [challengeHash]
  );

  const challenge = result.rows[0] as unknown as { user_id: string } | undefined;
  if (!challenge) {
    throw new HttpError(401, "Invalid or expired two-factor challenge");
  }

  return getUserById(challenge.user_id);
}

function verifyTotp(code: string, secret: string): boolean {
  return verifySync({
    secret,
    token: code.replace(/\s/g, ""),
    epochTolerance: 30
  }).valid;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeUser(user: AuthUserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt,
    twoFactorEnabled: user.twoFactorEnabled
  };
}

function authResponse(user: AuthUser) {
  return { user };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

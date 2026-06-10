import bcrypt from "bcryptjs";
import { pool } from "../config/database.js";
import { HttpError } from "../utils/errors.js";

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

  return authResponse(result.rows[0]);
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

  return authResponse({
    id: userRecord.id,
    email: userRecord.email,
    name: userRecord.name
  });
}

export async function getUserById(userId: string): Promise<AuthUser> {
  const result = await pool.query<AuthUser>(
    "SELECT id, email, name FROM users WHERE id = $1",
    [userId]
  );
  const user = result.rows[0];
  if (!user) {
    throw new HttpError(401, "Invalid session");
  }

  return user;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function authResponse(user: AuthUser) {
  return { user };
}

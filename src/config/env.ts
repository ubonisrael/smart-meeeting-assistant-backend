import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173,http://localhost:3000"),
  SESSION_SECRET: z.string().min(16),
  SESSION_COOKIE_NAME: z.string().default("smart_meeting_assistant.sid"),
  SESSION_TTL_MS: z.coerce.number().default(30 * 24 * 60 * 60 * 1000),
  APP_URL: z.string().url().default("http://localhost:5173"),
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_EMAIL_ADDRESS: z.string(),
  SMTP_PASSWORD: z.string(),
  SUPABASE_S3_ENDPOINT: z.string().optional(),
  SUPABASE_S3_REGION: z.string().default("us-east-1"),
  SUPABASE_S3_ACCESS_KEY_ID: z.string().optional(),
  SUPABASE_S3_SECRET_ACCESS_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("meeting-recordings"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-1.5-flash"),
  GEMINI_TRANSCRIPTION_MODEL: z.string().default("gemini-3.5-flash")
});

export const env = envSchema.parse({
  ...process.env,
  SESSION_SECRET: process.env.SESSION_SECRET ?? process.env.JWT_ACCESS_SECRET
});

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("30d"),
  SUPABASE_S3_ENDPOINT: z.string().optional(),
  SUPABASE_S3_REGION: z.string().default("us-east-1"),
  SUPABASE_S3_ACCESS_KEY_ID: z.string().optional(),
  SUPABASE_S3_SECRET_ACCESS_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("meeting-recordings"),
  TRANSCRIPTION_SERVICE_URL: z.string().default("http://localhost:8000"),
  AI_PROVIDER: z.string().default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini")
});

export const env = envSchema.parse(process.env);


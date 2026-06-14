import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

function assertStorageConfigured(): void {
  if (!env.SUPABASE_S3_ENDPOINT || !env.SUPABASE_S3_ACCESS_KEY_ID || !env.SUPABASE_S3_SECRET_ACCESS_KEY) {
    throw new HttpError(500, "Supabase Storage S3 credentials are not configured");
  }
}

export function createS3Client(): S3Client {
  assertStorageConfigured();
  return new S3Client({
    endpoint: env.SUPABASE_S3_ENDPOINT,
    region: env.SUPABASE_S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.SUPABASE_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.SUPABASE_S3_SECRET_ACCESS_KEY ?? ""
    }
  });
}

export async function uploadRecording(input: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  const client = createS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: env.SUPABASE_STORAGE_BUCKET,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType
    })
  );
}

export async function downloadRecording(key: string): Promise<Buffer> {
  const client = createS3Client();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: env.SUPABASE_STORAGE_BUCKET,
      Key: key
    })
  );

  if (!response.Body) {
    throw new Error("Storage object did not include a body");
  }

  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deleteRecording(key: string): Promise<void> {
  const client = createS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.SUPABASE_STORAGE_BUCKET,
      Key: key
    })
  );
}

export function buildStorageKey(userId: string, meetingId: string, filename: string): string {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${userId}/${meetingId}/${Date.now()}-${safeFilename}`;
}


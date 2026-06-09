import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const TRANSCRIPTION_REQUEST_QUEUE = "transcription:requests";
export const TRANSCRIPTION_RESULT_QUEUE = "transcription:results";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const bullMQConnection: ConnectionOptions = parseRedisUrl(env.REDIS_URL);

export const meetingProcessingQueue = new Queue("meeting-processing", {
  connection: bullMQConnection
});

export async function enqueueMeetingProcessing(meetingId: string): Promise<string> {
  const job = await meetingProcessingQueue.add(
    "process-meeting",
    { meetingId },
    {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000
      },
      removeOnComplete: 100,
      removeOnFail: 100
    }
  );
  return job.id ?? "";
}

export async function enqueueTranscriptionRequest(input: {
  meetingId: string;
  storageBucket: string;
  storageKey: string;
  filename: string;
  mimeType: string;
}): Promise<void> {
  await redisConnection.lpush(TRANSCRIPTION_REQUEST_QUEUE, JSON.stringify(input));
}

function parseRedisUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname ? Number(url.pathname.slice(1) || 0) : 0,
    maxRetriesPerRequest: null
  };
}

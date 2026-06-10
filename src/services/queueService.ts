import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logFlow } from "../utils/logger.js";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const bullMQConnection: ConnectionOptions = parseRedisUrl(env.REDIS_URL);

export const meetingProcessingQueue = new Queue("meeting-processing", {
  connection: bullMQConnection
});

export async function enqueueMeetingProcessing(meetingId: string): Promise<string> {
  logFlow("bullmq.meeting_processing.enqueue_started", {
    meetingId,
    queue: "meeting-processing"
  });

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

  logFlow("bullmq.meeting_processing.enqueue_completed", {
    meetingId,
    queue: "meeting-processing",
    bullmqJobId: job.id
  });

  return job.id ?? "";
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


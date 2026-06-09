import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.js";

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const meetingProcessingQueue = new Queue("meeting-processing", {
  connection: redisConnection
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


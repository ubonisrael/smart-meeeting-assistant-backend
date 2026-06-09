import { Worker } from "bullmq";
import { generateSummary, extractActionItems } from "./ai.js";
import { migrateDatabase, pool, withTransaction } from "./db.js";
import type { TranscriptionResult } from "./types.js";
import {
  enqueueTranscriptionRequest,
  bullMQConnection,
  redisConnection,
  TRANSCRIPTION_RESULT_QUEUE
} from "./queue.js";

await migrateDatabase();

const worker = new Worker(
  "meeting-processing",
  async (job) => {
    const meetingId = job.data.meetingId as string;
    await processMeeting(meetingId);
  },
  {
    connection: bullMQConnection,
    concurrency: 2
  }
);

worker.on("completed", (job) => {
  console.log(`Completed meeting processing job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`Failed meeting processing job ${job?.id}:`, error);
});

void listenForTranscriptionResults();

async function processMeeting(meetingId: string): Promise<void> {
  try {
    await setMeetingStatus(meetingId, "transcribing");

    const fileResult = await pool.query<{
      storage_bucket: string;
      storage_key: string;
      original_filename: string;
      mime_type: string;
    }>(
      `SELECT storage_bucket, storage_key, original_filename, mime_type
       FROM meeting_files
       WHERE meeting_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [meetingId]
    );

    const file = fileResult.rows[0];
    if (!file) {
      throw new Error("Meeting file not found");
    }

    await enqueueTranscriptionRequest({
      meetingId,
      storageBucket: file.storage_bucket,
      storageKey: file.storage_key,
      filename: file.original_filename,
      mimeType: file.mime_type
    });
    await pool.query(
      "UPDATE processing_jobs SET status = 'transcription_queued', updated_at = now() WHERE meeting_id = $1",
      [meetingId]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";
    await pool.query(
      "UPDATE meetings SET status = 'failed', failed_reason = $2, updated_at = now() WHERE id = $1",
      [meetingId, message]
    );
    throw error;
  }
}

async function setMeetingStatus(meetingId: string, status: string): Promise<void> {
  await pool.query("UPDATE meetings SET status = $2, updated_at = now() WHERE id = $1", [meetingId, status]);
}

type TranscriptionQueueResult =
  | {
      meetingId: string;
      status: "completed";
      transcription: TranscriptionResult;
    }
  | {
      meetingId: string;
      status: "failed";
      error: string;
    };

async function listenForTranscriptionResults(): Promise<void> {
  const resultConnection = redisConnection.duplicate();
  console.log(`Listening for transcription results on ${TRANSCRIPTION_RESULT_QUEUE}`);

  while (true) {
    try {
      const item = await resultConnection.brpop(TRANSCRIPTION_RESULT_QUEUE, 0);
      if (!item) {
        continue;
      }
      const [, rawPayload] = item;
      const payload = JSON.parse(rawPayload) as TranscriptionQueueResult;
      await processTranscriptionResult(payload);
    } catch (error) {
      console.error("Failed to process transcription result:", error);
      await wait(2000);
    }
  }
}

async function processTranscriptionResult(payload: TranscriptionQueueResult): Promise<void> {
  if (payload.status === "failed") {
    await pool.query(
      "UPDATE meetings SET status = 'failed', failed_reason = $2, updated_at = now() WHERE id = $1",
      [payload.meetingId, payload.error]
    );
    return;
  }

  const transcription = payload.transcription;
  await withTransaction(async (client) => {
    const transcriptResult = await client.query<{ id: string }>(
      `INSERT INTO transcripts (meeting_id, text, language)
       VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id)
       DO UPDATE SET text = EXCLUDED.text, language = EXCLUDED.language
       RETURNING id`,
      [payload.meetingId, transcription.text, transcription.language ?? null]
    );

    const transcriptId = transcriptResult.rows[0].id;
    await client.query("DELETE FROM transcript_segments WHERE meeting_id = $1", [payload.meetingId]);
    for (const segment of transcription.segments) {
      await client.query(
        `INSERT INTO transcript_segments (transcript_id, meeting_id, start_seconds, end_seconds, text)
         VALUES ($1, $2, $3, $4, $5)`,
        [transcriptId, payload.meetingId, segment.start, segment.end, segment.text]
      );
    }
  });

  await setMeetingStatus(payload.meetingId, "summarizing");
  const summary = await generateSummary(transcription.text);
  await pool.query(
    `INSERT INTO summaries (meeting_id, overview, decisions, risks, next_steps)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (meeting_id)
     DO UPDATE SET overview = EXCLUDED.overview,
                   decisions = EXCLUDED.decisions,
                   risks = EXCLUDED.risks,
                   next_steps = EXCLUDED.next_steps`,
    [
      payload.meetingId,
      summary.overview,
      JSON.stringify(summary.decisions),
      JSON.stringify(summary.risks),
      JSON.stringify(summary.nextSteps)
    ]
  );

  await setMeetingStatus(payload.meetingId, "extracting_action_items");
  const actionItems = await extractActionItems(transcription.text);
  await withTransaction(async (client) => {
    await client.query("DELETE FROM action_items WHERE meeting_id = $1", [payload.meetingId]);
    for (const item of actionItems) {
      await client.query(
        `INSERT INTO action_items (meeting_id, assignee, task, deadline, source_text, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          payload.meetingId,
          item.assignee ?? null,
          item.task,
          item.deadline ?? null,
          item.sourceText ?? null,
          item.confidence ?? null
        ]
      );
    }
  });

  await setMeetingStatus(payload.meetingId, "completed");
  await pool.query(
    "UPDATE processing_jobs SET status = 'completed', updated_at = now() WHERE meeting_id = $1",
    [payload.meetingId]
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

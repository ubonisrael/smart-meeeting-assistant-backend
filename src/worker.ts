import { Worker } from "bullmq";
import { generateSummary, extractActionItems } from "./ai.js";
import { migrateDatabase, pool, withTransaction } from "./db.js";
import { downloadRecording } from "./storage.js";
import { bullMQConnection } from "./queue.js";
import { logFlow, logFlowError } from "./logger.js";
import { transcribeRecordingWithGemini } from "./transcription.js";
import type { TranscriptionResult } from "./types.js";

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
  logFlow("bullmq.meeting_processing.completed", {
    bullmqJobId: job.id,
    meetingId: job.data.meetingId
  });
});

worker.on("failed", (job, error) => {
  logFlowError("bullmq.meeting_processing.failed", {
    bullmqJobId: job?.id,
    meetingId: job?.data.meetingId,
    error: error.message
  });
});

async function processMeeting(meetingId: string): Promise<void> {
  try {
    logFlow("meeting.processing.started", { meetingId });
    await setMeetingStatus(meetingId, "transcribing");
    logFlow("meeting.status.updated", { meetingId, status: "transcribing" });

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

    logFlow("meeting.transcription.started", {
      meetingId,
      storageBucket: file.storage_bucket,
      storageKey: file.storage_key,
      filename: file.original_filename,
      mimeType: file.mime_type
    });

    const recording = await downloadRecording(file.storage_key);
    logFlow("meeting.recording.downloaded", {
      meetingId,
      storageBucket: file.storage_bucket,
      storageKey: file.storage_key,
      sizeBytes: recording.length
    });

    const transcription = await transcribeRecordingWithGemini({
      meetingId,
      recording,
      filename: file.original_filename,
      mimeType: file.mime_type
    });

    await pool.query(
      "UPDATE processing_jobs SET status = 'transcribed', updated_at = now() WHERE meeting_id = $1",
      [meetingId]
    );
    await processTranscriptionResult({
      meetingId,
      status: "completed",
      transcription
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";
    await pool.query(
      "UPDATE meetings SET status = 'failed', failed_reason = $2, updated_at = now() WHERE id = $1",
      [meetingId, message]
    );
    logFlowError("meeting.processing.failed", {
      meetingId,
      error: message
    });
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

async function processTranscriptionResult(payload: TranscriptionQueueResult): Promise<void> {
  if (payload.status === "failed") {
    await pool.query(
      "UPDATE meetings SET status = 'failed', failed_reason = $2, updated_at = now() WHERE id = $1",
      [payload.meetingId, payload.error]
    );
    logFlowError("meeting.transcription.failed", {
      meetingId: payload.meetingId,
      error: payload.error
    });
    return;
  }

  const transcription = payload.transcription;
  logFlow("meeting.transcription.completed", {
    meetingId: payload.meetingId,
    language: transcription.language,
    transcriptCharacters: transcription.text.length,
    segmentCount: transcription.segments.length
  });

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
  logFlow("meeting.transcript.persisted", {
    meetingId: payload.meetingId,
    segmentCount: transcription.segments.length
  });

  await setMeetingStatus(payload.meetingId, "summarizing");
  logFlow("meeting.status.updated", { meetingId: payload.meetingId, status: "summarizing" });
  logFlow("meeting.summary.started", { meetingId: payload.meetingId });
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
  logFlow("meeting.summary.completed", {
    meetingId: payload.meetingId,
    decisionsCount: summary.decisions.length,
    risksCount: summary.risks.length,
    nextStepsCount: summary.nextSteps.length
  });

  await setMeetingStatus(payload.meetingId, "extracting_action_items");
  logFlow("meeting.status.updated", { meetingId: payload.meetingId, status: "extracting_action_items" });
  logFlow("meeting.action_items.started", { meetingId: payload.meetingId });
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
  logFlow("meeting.action_items.completed", {
    meetingId: payload.meetingId,
    actionItemCount: actionItems.length
  });

  await setMeetingStatus(payload.meetingId, "completed");
  logFlow("meeting.status.updated", { meetingId: payload.meetingId, status: "completed" });
  await pool.query(
    "UPDATE processing_jobs SET status = 'completed', updated_at = now() WHERE meeting_id = $1",
    [payload.meetingId]
  );
  logFlow("meeting.flow.completed", {
    meetingId: payload.meetingId,
    status: "completed"
  });
}

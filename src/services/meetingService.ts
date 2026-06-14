import { env } from "../config/env.js";
import { pool, withTransaction } from "../config/database.js";
import { HttpError } from "../utils/errors.js";
import { logFlow } from "../utils/logger.js";
import { answerQuestion } from "./aiService.js";
import { enqueueMeetingProcessing } from "./queueService.js";
import { buildStorageKey, uploadRecording } from "./storageService.js";

type UploadMeetingInput = {
  user: AuthUser;
  file: Express.Multer.File;
  title?: string;
};

export async function uploadMeeting(input: UploadMeetingInput) {
  const title = input.title?.trim() || input.file.originalname;

  logFlow("meeting.upload.received", {
    userId: input.user.id,
    title,
    filename: input.file.originalname,
    mimeType: input.file.mimetype,
    sizeBytes: input.file.size
  });

  const meetingResult = await pool.query<{ id: string }>(
    `INSERT INTO meetings (user_id, title, status)
     VALUES ($1, $2, 'uploaded')
     RETURNING id`,
    [input.user.id, title]
  );
  const meetingId = meetingResult.rows[0].id;
  const storageKey = buildStorageKey(input.user.id, meetingId, input.file.originalname);

  logFlow("meeting.upload.storage_started", {
    meetingId,
    userId: input.user.id,
    storageBucket: env.SUPABASE_STORAGE_BUCKET,
    storageKey,
    sizeBytes: input.file.size
  });

  // S3 upload runs outside any transaction so the DB connection is not held
  // open for the full duration of the upload.
  await uploadRecording({
    key: storageKey,
    body: input.file.buffer,
    contentType: input.file.mimetype || "application/octet-stream"
  });

  logFlow("meeting.upload.storage_completed", {
    meetingId,
    userId: input.user.id,
    storageBucket: env.SUPABASE_STORAGE_BUCKET,
    storageKey
  });

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO meeting_files
        (meeting_id, storage_bucket, storage_key, original_filename, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        meetingId,
        env.SUPABASE_STORAGE_BUCKET,
        storageKey,
        input.file.originalname,
        input.file.mimetype,
        input.file.size
      ]
    );
    await client.query("UPDATE meetings SET status = 'processing', updated_at = now() WHERE id = $1", [
      meetingId
    ]);
  });

  const jobId = await enqueueMeetingProcessing(meetingId);
  logFlow("meeting.processing_job.queued", {
    meetingId,
    bullmqJobId: jobId,
    queue: "meeting-processing"
  });

  await pool.query(
    "INSERT INTO processing_jobs (meeting_id, queue_job_id, status) VALUES ($1, $2, 'queued')",
    [meetingId, jobId]
  );

  logFlow("meeting.upload.accepted", {
    meetingId,
    status: "processing"
  });

  return {
    meetingId,
    status: "processing"
  };
}

export async function listMeetings(userId: string) {
  const result = await pool.query(
    `SELECT id, title, status, failed_reason AS "failedReason", meeting_date AS "meetingDate",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM meetings
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function getMeeting(meetingId: string, userId: string) {
  const result = await pool.query(
    `SELECT id, title, status, failed_reason AS "failedReason", meeting_date AS "meetingDate",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM meetings
     WHERE id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
  const meeting = result.rows[0];
  if (!meeting) {
    throw new HttpError(404, "Meeting not found");
  }
  return meeting;
}

export async function getTranscript(meetingId: string, userId: string) {
  await assertMeetingOwner(meetingId, userId);
  const transcript = await pool.query(
    `SELECT id, text, language, created_at AS "createdAt"
     FROM transcripts
     WHERE meeting_id = $1`,
    [meetingId]
  );
  const segments = await pool.query(
    `SELECT id, start_seconds AS "start", end_seconds AS "end", text
     FROM transcript_segments
     WHERE meeting_id = $1
     ORDER BY start_seconds ASC`,
    [meetingId]
  );
  return { transcript: transcript.rows[0] ?? null, segments: segments.rows };
}

export async function getSummary(meetingId: string, userId: string) {
  await assertMeetingOwner(meetingId, userId);
  const result = await pool.query(
    `SELECT id, overview, decisions, risks, next_steps AS "nextSteps", created_at AS "createdAt"
     FROM summaries
     WHERE meeting_id = $1`,
    [meetingId]
  );
  return result.rows[0] ?? null;
}

export async function getActionItems(meetingId: string, userId: string) {
  await assertMeetingOwner(meetingId, userId);
  const result = await pool.query(
    `SELECT id, assignee, task, deadline, source_text AS "sourceText", confidence, completed_at AS "completedAt"
     FROM action_items
     WHERE meeting_id = $1
     ORDER BY created_at ASC`,
    [meetingId]
  );
  return result.rows;
}

export async function searchMeetings(userId: string, query: string, limit: number) {
  return searchMeetingContext(userId, query, limit);
}

export async function askMeetings(userId: string, question: string) {
  const contexts = await searchMeetingContext(userId, question, 8);
  const answer = await answerQuestion(
    question,
    contexts.map((context) => `${context.title}: ${context.text}`)
  );
  return {
    answer,
    sources: contexts.map((context) => ({
      meetingId: context.meetingId,
      title: context.title,
      segmentStart: context.segmentStart,
      segmentEnd: context.segmentEnd,
      text: context.text
    }))
  };
}

export async function deleteMeeting(meetingId: string, userId: string): Promise<void> {
  await assertMeetingOwner(meetingId, userId);
  await pool.query("DELETE FROM meetings WHERE id = $1", [meetingId]);
}

async function assertMeetingOwner(meetingId: string, userId?: string): Promise<void> {
  const result = await pool.query("SELECT id FROM meetings WHERE id = $1 AND user_id = $2", [meetingId, userId]);
  if (!result.rowCount) {
    throw new HttpError(404, "Meeting not found");
  }
}

function dateFilterForQuery(query: string): { sql: string; values: unknown[] } {
  const normalized = query.toLowerCase();
  const now = new Date();

  if (!normalized.includes("last month")) {
    return { sql: "", values: [] };
  }

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    sql: "AND m.meeting_date >= $3 AND m.meeting_date < $4",
    values: [start, end]
  };
}

async function searchMeetingContext(userId: string, query: string, limit: number) {
  const dateFilter = dateFilterForQuery(query);
  const values = [userId, query, ...dateFilter.values];
  const result = await pool.query(
    `SELECT m.id AS "meetingId",
            m.title,
            ts.start_seconds AS "segmentStart",
            ts.end_seconds AS "segmentEnd",
            ts.text,
            ts_rank(ts.search_vector, plainto_tsquery('english', $2)) AS rank
     FROM transcript_segments ts
     JOIN meetings m ON m.id = ts.meeting_id
     WHERE m.user_id = $1
       ${dateFilter.sql}
       AND ts.search_vector @@ plainto_tsquery('english', $2)
     ORDER BY rank DESC, m.meeting_date DESC
     LIMIT ${limit}`,
    values
  );

  if (result.rows.length) {
    return result.rows;
  }

  const fallback = await pool.query(
    `SELECT m.id AS "meetingId",
            m.title,
            NULL AS "segmentStart",
            NULL AS "segmentEnd",
            s.overview AS text,
            ts_rank(s.search_vector, plainto_tsquery('english', $2)) AS rank
     FROM summaries s
     JOIN meetings m ON m.id = s.meeting_id
     WHERE m.user_id = $1
       ${dateFilter.sql}
       AND s.search_vector @@ plainto_tsquery('english', $2)
     ORDER BY rank DESC, m.meeting_date DESC
     LIMIT ${limit}`,
    values
  );

  return fallback.rows;
}


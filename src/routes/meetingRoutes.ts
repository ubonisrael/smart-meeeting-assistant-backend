import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { answerQuestion } from "../ai.js";
import { pool, withTransaction } from "../db.js";
import { HttpError } from "../errors.js";
import { enqueueMeetingProcessing } from "../queue.js";
import { buildStorageKey, uploadRecording } from "../storage.js";
import { requireAuth } from "../auth.js";
import { env } from "../env.js";
import { logFlow } from "../logger.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

const allowedMimeTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "video/mp4",
  "application/octet-stream"
]);

const askSchema = z.object({
  question: z.string().min(1)
});

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(25).optional()
});

router.use(requireAuth);

router.post("/upload", upload.single("recording"), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new HttpError(401, "Unauthenticated");
    }
    if (!req.file) {
      throw new HttpError(400, "Recording file is required");
    }
    if (!allowedMimeTypes.has(req.file.mimetype)) {
      throw new HttpError(400, "Unsupported recording type");
    }

    const title = typeof req.body.title === "string" && req.body.title.trim()
      ? req.body.title.trim()
      : req.file.originalname;

    logFlow("meeting.upload.received", {
      userId: req.user.id,
      title,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size
    });

    const meeting = await withTransaction(async (client) => {
      const meetingResult = await client.query<{ id: string }>(
        `INSERT INTO meetings (user_id, title, status)
         VALUES ($1, $2, 'uploaded')
         RETURNING id`,
        [req.user?.id, title]
      );
      const meetingId = meetingResult.rows[0].id;
      const storageKey = buildStorageKey(req.user?.id ?? "", meetingId, req.file?.originalname ?? "recording");

      logFlow("meeting.upload.storage_started", {
        meetingId,
        userId: req.user?.id,
        storageBucket: env.SUPABASE_STORAGE_BUCKET,
        storageKey,
        sizeBytes: req.file?.size
      });

      await uploadRecording({
        key: storageKey,
        body: req.file?.buffer ?? Buffer.alloc(0),
        contentType: req.file?.mimetype ?? "application/octet-stream"
      });

      logFlow("meeting.upload.storage_completed", {
        meetingId,
        userId: req.user?.id,
        storageBucket: env.SUPABASE_STORAGE_BUCKET,
        storageKey
      });

      await client.query(
        `INSERT INTO meeting_files
          (meeting_id, storage_bucket, storage_key, original_filename, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          meetingId,
          env.SUPABASE_STORAGE_BUCKET,
          storageKey,
          req.file?.originalname,
          req.file?.mimetype,
          req.file?.size
        ]
      );

      await client.query("UPDATE meetings SET status = 'processing', updated_at = now() WHERE id = $1", [
        meetingId
      ]);

      return { id: meetingId };
    });

    const jobId = await enqueueMeetingProcessing(meeting.id);
    logFlow("meeting.processing_job.queued", {
      meetingId: meeting.id,
      bullmqJobId: jobId,
      queue: "meeting-processing"
    });

    await pool.query(
      "INSERT INTO processing_jobs (meeting_id, queue_job_id, status) VALUES ($1, $2, 'queued')",
      [meeting.id, jobId]
    );

    logFlow("meeting.upload.accepted", {
      meetingId: meeting.id,
      status: "processing"
    });

    res.status(202).json({
      meetingId: meeting.id,
      status: "processing"
    });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, status, failed_reason AS "failedReason", meeting_date AS "meetingDate",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM meetings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user?.id]
    );
    res.json({ meetings: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, status, failed_reason AS "failedReason", meeting_date AS "meetingDate",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM meetings
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user?.id]
    );
    const meeting = result.rows[0];
    if (!meeting) {
      throw new HttpError(404, "Meeting not found");
    }
    res.json({ meeting });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/transcript", async (req, res, next) => {
  try {
    await assertMeetingOwner(req.params.id, req.user?.id);
    const transcript = await pool.query(
      `SELECT id, text, language, created_at AS "createdAt"
       FROM transcripts
       WHERE meeting_id = $1`,
      [req.params.id]
    );
    const segments = await pool.query(
      `SELECT id, start_seconds AS "start", end_seconds AS "end", text
       FROM transcript_segments
       WHERE meeting_id = $1
       ORDER BY start_seconds ASC`,
      [req.params.id]
    );
    res.json({ transcript: transcript.rows[0] ?? null, segments: segments.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/summary", async (req, res, next) => {
  try {
    await assertMeetingOwner(req.params.id, req.user?.id);
    const result = await pool.query(
      `SELECT id, overview, decisions, risks, next_steps AS "nextSteps", created_at AS "createdAt"
       FROM summaries
       WHERE meeting_id = $1`,
      [req.params.id]
    );
    res.json({ summary: result.rows[0] ?? null });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/action-items", async (req, res, next) => {
  try {
    await assertMeetingOwner(req.params.id, req.user?.id);
    const result = await pool.query(
      `SELECT id, assignee, task, deadline, source_text AS "sourceText", confidence, completed_at AS "completedAt"
       FROM action_items
       WHERE meeting_id = $1
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ actionItems: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/search", async (req, res, next) => {
  try {
    const input = searchSchema.parse(req.body);
    const limit = input.limit ?? 10;
    const result = await searchMeetingContext(req.user?.id ?? "", input.query, limit);
    res.json({ results: result });
  } catch (error) {
    next(error);
  }
});

router.post("/ask", async (req, res, next) => {
  try {
    const input = askSchema.parse(req.body);
    const contexts = await searchMeetingContext(req.user?.id ?? "", input.question, 8);
    const answer = await answerQuestion(
      input.question,
      contexts.map((context) => `${context.title}: ${context.text}`)
    );
    res.json({
      answer,
      sources: contexts.map((context) => ({
        meetingId: context.meetingId,
        title: context.title,
        segmentStart: context.segmentStart,
        segmentEnd: context.segmentEnd,
        text: context.text
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await assertMeetingOwner(req.params.id, req.user?.id);
    await pool.query("DELETE FROM meetings WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

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

export { router as meetingRoutes };

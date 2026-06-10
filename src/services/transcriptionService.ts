import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env } from "../config/env.js";
import { logFlow, logFlowError } from "../utils/logger.js";

type GeminiTranscriptPayload = {
  language?: string;
  segments?: Array<{
    start?: number | string;
    end?: number | string;
    start_seconds?: number | string;
    end_seconds?: number | string;
    text?: string;
  }>;
};

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  geminiClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return geminiClient;
}

export async function transcribeRecordingWithGemini(input: {
  meetingId: string;
  recording: Buffer;
  filename: string;
  mimeType: string;
}): Promise<TranscriptionResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meeting-transcription-"));
  const tempPath = path.join(tempDir, input.filename.replace(/[^a-zA-Z0-9._-]/g, "_"));

  await writeFile(tempPath, input.recording);

  let uploadedFile: Awaited<ReturnType<GoogleGenAI["files"]["upload"]>> | null = null;
  try {
    logFlow("gemini.transcription.started", {
      meetingId: input.meetingId,
      filename: input.filename,
      mimeType: input.mimeType,
      fileBytes: input.recording.length,
      model: env.GEMINI_TRANSCRIPTION_MODEL
    });

    uploadedFile = await getGeminiClient().files.upload({
      file: tempPath,
      config: {
        mimeType: input.mimeType
      }
    });

    logFlow("gemini.file_upload.completed", {
      meetingId: input.meetingId,
      fileName: uploadedFile.name,
      fileUri: uploadedFile.uri
    });

    const response = await getGeminiClient().models.generateContent({
      model: env.GEMINI_TRANSCRIPTION_MODEL,
      contents: createUserContent([
        transcriptionPrompt(),
        createPartFromUri(uploadedFile.uri ?? "", uploadedFile.mimeType ?? input.mimeType)
      ])
    });

    const transcription = parseTranscriptionResponse(response.text ?? "");
    logFlow("gemini.transcription.completed", {
      meetingId: input.meetingId,
      language: transcription.language,
      transcriptCharacters: transcription.text.length,
      segmentCount: transcription.segments.length
    });

    return transcription;
  } finally {
    if (uploadedFile?.name) {
      try {
        await getGeminiClient().files.delete({ name: uploadedFile.name });
        logFlow("gemini.file_deleted", {
          meetingId: input.meetingId,
          fileName: uploadedFile.name
        });
      } catch (error) {
        logFlowError("gemini.file_delete.failed", {
          meetingId: input.meetingId,
          fileName: uploadedFile.name,
          error: error instanceof Error ? error.message : "Unknown Gemini file deletion error"
        });
      }
    }

    await unlink(tempPath).catch(() => undefined);
  }
}

function transcriptionPrompt(): string {
  return `
Generate a detailed transcript of this meeting recording.

Return only valid JSON with this exact shape:
{
  "language": "primary BCP-47 language code, such as en",
  "segments": [
    {
      "start": 0.0,
      "end": 12.4,
      "text": "spoken words for this segment"
    }
  ]
}

Use seconds from the beginning of the recording for start and end.
If exact timestamps are uncertain, provide your best approximate timestamps.
Do not include markdown fences or explanatory text.
`.trim();
}

function parseTranscriptionResponse(responseText: string): TranscriptionResult {
  const payload = extractJson(responseText);
  const segments = (payload.segments ?? [])
    .map(normalizeSegment)
    .filter((segment) => segment.text.length > 0);

  const fallbackSegments: TranscriptSegment[] = responseText.trim()
    ? [{ start: 0, end: 0, text: responseText.trim() }]
    : [];

  const normalizedSegments = segments.length ? segments : fallbackSegments;

  return {
    text: normalizedSegments.map((segment) => segment.text).join(" "),
    segments: normalizedSegments,
    language: payload.language ?? "unknown"
  };
}

function extractJson(responseText: string): GeminiTranscriptPayload {
  let cleaned = responseText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  try {
    return JSON.parse(cleaned) as GeminiTranscriptPayload;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return {
        language: "unknown",
        segments: [{ start: 0, end: 0, text: responseText }]
      };
    }
    return JSON.parse(cleaned.slice(start, end + 1)) as GeminiTranscriptPayload;
  }
}

function normalizeSegment(segment: NonNullable<GeminiTranscriptPayload["segments"]>[number]): TranscriptSegment {
  return {
    start: parseSeconds(segment.start ?? segment.start_seconds ?? 0),
    end: parseSeconds(segment.end ?? segment.end_seconds ?? 0),
    text: String(segment.text ?? "").trim()
  };
}

function parseSeconds(value: number | string): number {
  if (typeof value === "number") {
    return value;
  }

  if (!value.includes(":")) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}


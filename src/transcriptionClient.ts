import { env } from "./env.js";
import type { TranscriptionResult } from "./types.js";

export async function transcribeRecording(input: {
  buffer: Buffer;
  filename: string;
  contentType: string;
}): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([input.buffer], { type: input.contentType || "application/octet-stream" }),
    input.filename
  );

  const response = await fetch(`${env.TRANSCRIPTION_SERVICE_URL}/transcribe`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transcription failed: ${response.status} ${errorText}`);
  }

  return (await response.json()) as TranscriptionResult;
}


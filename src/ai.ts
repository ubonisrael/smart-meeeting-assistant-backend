import { env } from "./env.js";
import type { ActionItemResult, SummaryResult } from "./types.js";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

function firstSentences(text: string, count: number): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return sentences.slice(0, count).join(" ") || text.slice(0, 600);
}

function extractJsonObject<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) {
      return fallback;
    }
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return fallback;
    }
  }
}

async function generateGeminiContent(input: {
  system: string;
  prompt: string;
  responseMimeType?: "application/json" | "text/plain";
}): Promise<string | null> {
  if (!env.GEMINI_API_KEY) {
    return null;
  }

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`
  );
  url.searchParams.set("key", env.GEMINI_API_KEY);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: input.system }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: input.prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: input.responseMimeType ?? "text/plain"
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? null;
}

export async function generateSummary(transcriptText: string): Promise<SummaryResult> {
  const fallback: SummaryResult = {
    overview: firstSentences(transcriptText, 4),
    decisions: [],
    risks: [],
    nextSteps: []
  };

  const content = await generateGeminiContent({
    system:
      "Generate a concise meeting summary as JSON with overview, decisions, risks, and nextSteps. decisions, risks, and nextSteps must be arrays of strings.",
    prompt: transcriptText.slice(0, 60000),
    responseMimeType: "application/json"
  });

  return content ? extractJsonObject<SummaryResult>(content, fallback) : fallback;
}

export async function extractActionItems(transcriptText: string): Promise<ActionItemResult[]> {
  const fallback: ActionItemResult[] = [];

  const content = await generateGeminiContent({
    system:
      "Extract action items from the meeting transcript. Return JSON with an actionItems array. Each item should include assignee, task, deadline, sourceText, and confidence.",
    prompt: transcriptText.slice(0, 60000),
    responseMimeType: "application/json"
  });

  if (!content) {
    return fallback;
  }

  const parsed = extractJsonObject<{ actionItems: ActionItemResult[] }>(content, { actionItems: fallback });
  return Array.isArray(parsed.actionItems) ? parsed.actionItems : fallback;
}

export async function answerQuestion(question: string, contexts: string[]): Promise<string> {
  if (!contexts.length) {
    return "I could not find matching meeting context for that question.";
  }

  if (!env.GEMINI_API_KEY) {
    return `I found relevant context, but AI answering is not configured yet. Closest match: ${contexts[0]}`;
  }

  const content = await generateGeminiContent({
    system:
      "Answer the user's meeting question using only the supplied meeting context. Keep the answer concise and mention uncertainty when context is incomplete.",
    prompt: `Question: ${question}\n\nContext:\n${contexts.join("\n\n---\n\n")}`
  });

  return content ?? "I could not generate an answer.";
}

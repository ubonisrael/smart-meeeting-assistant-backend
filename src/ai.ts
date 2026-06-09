import OpenAI from "openai";
import { env } from "./env.js";
import type { ActionItemResult, SummaryResult } from "./types.js";

function openaiClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) {
    return null;
  }
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

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

export async function generateSummary(transcriptText: string): Promise<SummaryResult> {
  const fallback: SummaryResult = {
    overview: firstSentences(transcriptText, 4),
    decisions: [],
    risks: [],
    nextSteps: []
  };

  const client = openaiClient();
  if (!client) {
    return fallback;
  }

  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Generate a concise meeting summary as JSON with overview, decisions, risks, and nextSteps. decisions, risks, and nextSteps must be arrays of strings."
      },
      { role: "user", content: transcriptText.slice(0, 60000) }
    ]
  });

  const content = response.choices[0]?.message.content ?? "";
  return extractJsonObject<SummaryResult>(content, fallback);
}

export async function extractActionItems(transcriptText: string): Promise<ActionItemResult[]> {
  const fallback: ActionItemResult[] = [];
  const client = openaiClient();
  if (!client) {
    return fallback;
  }

  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract action items from the meeting transcript. Return JSON with an actionItems array. Each item should include assignee, task, deadline, sourceText, and confidence."
      },
      { role: "user", content: transcriptText.slice(0, 60000) }
    ]
  });

  const content = response.choices[0]?.message.content ?? "";
  const parsed = extractJsonObject<{ actionItems: ActionItemResult[] }>(content, { actionItems: fallback });
  return Array.isArray(parsed.actionItems) ? parsed.actionItems : fallback;
}

export async function answerQuestion(question: string, contexts: string[]): Promise<string> {
  if (!contexts.length) {
    return "I could not find matching meeting context for that question.";
  }

  const client = openaiClient();
  if (!client) {
    return `I found relevant context, but AI answering is not configured yet. Closest match: ${contexts[0]}`;
  }

  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Answer the user's meeting question using only the supplied meeting context. Keep the answer concise and mention uncertainty when context is incomplete."
      },
      {
        role: "user",
        content: `Question: ${question}\n\nContext:\n${contexts.join("\n\n---\n\n")}`
      }
    ]
  });

  return response.choices[0]?.message.content ?? "I could not generate an answer.";
}


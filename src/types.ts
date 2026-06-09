export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

export type MeetingStatus =
  | "uploaded"
  | "processing"
  | "transcribing"
  | "summarizing"
  | "extracting_action_items"
  | "completed"
  | "failed";

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptionResult = {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
};

export type SummaryResult = {
  overview: string;
  decisions: string[];
  risks: string[];
  nextSteps: string[];
};

export type ActionItemResult = {
  assignee?: string;
  task: string;
  deadline?: string;
  sourceText?: string;
  confidence?: number;
};


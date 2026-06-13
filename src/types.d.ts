import "express-session";

declare global {
  type AuthUser = {
    id: string;
    email: string;
    name: string;
    emailVerifiedAt: string | null;
    twoFactorEnabled: boolean;
  };

  type MeetingStatus =
    | "uploaded"
    | "processing"
    | "transcribing"
    | "summarizing"
    | "extracting_action_items"
    | "completed"
    | "failed";

  type TranscriptSegment = {
    start: number;
    end: number;
    text: string;
  };

  type TranscriptionResult = {
    text: string;
    segments: TranscriptSegment[];
    language?: string;
  };

  type SummaryResult = {
    overview: string;
    decisions: string[];
    risks: string[];
    nextSteps: string[];
  };

  type ActionItemResult = {
    assignee?: string;
    task: string;
    deadline?: string;
    sourceText?: string;
    confidence?: number;
  };

  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    pendingTwoFactorSecret?: string;
  }
}

export {};

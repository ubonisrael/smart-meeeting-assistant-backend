import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { HttpError } from "../utils/errors.js";
import {
  askMeetings,
  deleteMeeting,
  getActionItems,
  getMeeting,
  getSummary,
  getTranscript,
  listMeetings,
  searchMeetings,
  uploadMeeting
} from "../services/meetingService.js";

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

export async function upload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    if (!req.file) {
      throw new HttpError(400, "Recording file is required");
    }
    if (!allowedMimeTypes.has(req.file.mimetype)) {
      throw new HttpError(400, "Unsupported recording type");
    }

    const title = typeof req.body.title === "string" ? req.body.title : undefined;
    const response = await uploadMeeting({ user, file: req.file, title });
    res.status(202).json(response);
  } catch (error) {
    next(error);
  }
}

export async function index(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const meetings = await listMeetings(user.id);
    res.json({ meetings });
  } catch (error) {
    next(error);
  }
}

export async function show(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const meeting = await getMeeting(req.params.id, user.id);
    res.json({ meeting });
  } catch (error) {
    next(error);
  }
}

export async function transcript(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const response = await getTranscript(req.params.id, user.id);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function summary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const response = await getSummary(req.params.id, user.id);
    res.json({ summary: response });
  } catch (error) {
    next(error);
  }
}

export async function actionItems(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const response = await getActionItems(req.params.id, user.id);
    res.json({ actionItems: response });
  } catch (error) {
    next(error);
  }
}

export async function search(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const input = searchSchema.parse(req.body);
    const results = await searchMeetings(user.id, input.query, input.limit ?? 10);
    res.json({ results });
  } catch (error) {
    next(error);
  }
}

export async function ask(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const input = askSchema.parse(req.body);
    const response = await askMeetings(user.id, input.question);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function destroy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    await deleteMeeting(req.params.id, user.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

function requireUser(req: Request): AuthUser {
  if (!req.user) {
    throw new HttpError(401, "Unauthenticated");
  }
  return req.user;
}


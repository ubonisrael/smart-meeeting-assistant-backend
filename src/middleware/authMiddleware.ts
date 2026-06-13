import type { NextFunction, Request, Response } from "express";
import { getUserById } from "../services/authService.js";
import { HttpError } from "../utils/errors.js";

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.session.userId) {
      throw new HttpError(401, "Authentication required");
    }

    const user = await getUserById(req.session.userId);
    if (!user.emailVerifiedAt) {
      throw new HttpError(403, "Email verification required");
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }
    next(new HttpError(401, "Invalid session"));
  }
}

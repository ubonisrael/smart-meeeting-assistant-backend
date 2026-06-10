import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../services/authService.js";
import { HttpError } from "../utils/errors.js";

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "Missing bearer token");
    }

    const token = header.slice("Bearer ".length);
    req.user = verifyAccessToken(token);
    next();
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }
    next(new HttpError(401, "Invalid or expired token"));
  }
}


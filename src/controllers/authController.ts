import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  getUserById,
  loginUser,
  registerUser
} from "../services/authService.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = registerSchema.parse(req.body);
    const response = await registerUser(input);
    req.session.userId = response.user.id;
    req.session.save((error) => {
      if (error) {
        next(error);
        return;
      }
      res.status(201).json(response);
    });
  } catch (error) {
    next(error);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = loginSchema.parse(req.body);
    const response = await loginUser(input);
    req.session.userId = response.user.id;
    req.session.save((error) => {
      if (error) {
        next(error);
        return;
      }
      res.json(response);
    });
  } catch (error) {
    next(error);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.session.userId) {
      throw new HttpError(401, "Authentication required");
    }

    const user = await getUserById(req.session.userId);
    res.json({ user });
  } catch (error) {
    next(error);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    req.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      res.clearCookie(env.SESSION_COOKIE_NAME);
      res.status(204).send();
    });
  } catch (error) {
    next(error);
  }
}

export function me(req: Request, res: Response): void {
  res.json({ user: req.user });
}

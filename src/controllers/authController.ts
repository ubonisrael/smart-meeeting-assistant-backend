import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  loginUser,
  logoutSession,
  refreshSession,
  registerUser
} from "../services/authService.js";

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = registerSchema.parse(req.body);
    const response = await registerUser(input);
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = loginSchema.parse(req.body);
    const response = await loginUser(input);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = refreshSchema.parse(req.body);
    const response = await refreshSession(input.refreshToken);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = refreshSchema.parse(req.body);
    await logoutSession(input.refreshToken);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export function me(req: Request, res: Response): void {
  res.json({ user: req.user });
}


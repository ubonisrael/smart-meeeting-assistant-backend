import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  completeTwoFactorLogin,
  createTwoFactorSetup,
  disableTwoFactor,
  enableTwoFactor,
  getUserById,
  loginUser,
  registerUser,
  requestPasswordReset,
  resendVerificationEmail,
  resetPassword,
  updatePassword,
  updateProfile,
  verifyEmailToken
} from "../services/authService.js";
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

const tokenSchema = z.object({
  token: z.string().min(1)
});

const resendVerificationSchema = z.object({
  email: z.string().email()
});

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8)
});

const updateProfileSchema = z.object({
  name: z.string().min(1)
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

const twoFactorLoginSchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(6)
});

const twoFactorEnableSchema = z.object({
  code: z.string().min(6)
});

const twoFactorDisableSchema = z.object({
  password: z.string().min(1),
  code: z.string().min(6)
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
    if ("twoFactorRequired" in response) {
      res.json(response);
      return;
    }

    await establishSession(req, response.user);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function verifyTwoFactorLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = twoFactorLoginSchema.parse(req.body);
    const response = await completeTwoFactorLogin(input);
    await establishSession(req, response.user);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = tokenSchema.parse(req.body);
    const response = await verifyEmailToken(input.token);
    await establishSession(req, response.user);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function resendVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = resendVerificationSchema.parse(req.body);
    await resendVerificationEmail(input.email);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = forgotPasswordSchema.parse(req.body);
    await requestPasswordReset(input.email);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function resetPasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = resetPasswordSchema.parse(req.body);
    await resetPassword(input);
    res.status(204).send();
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
    if (!user.emailVerifiedAt) {
      throw new HttpError(403, "Email verification required");
    }
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

export async function updateProfileHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateProfileSchema.parse(req.body);
    const response = await updateProfile(req.user!.id, input);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function updatePasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updatePasswordSchema.parse(req.body);
    await updatePassword(req.user!.id, input);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function setupTwoFactor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const setup = createTwoFactorSetup(req.user!);
    req.session.pendingTwoFactorSecret = setup.secret;
    req.session.save((error) => {
      if (error) {
        next(error);
        return;
      }
      res.json(setup);
    });
  } catch (error) {
    next(error);
  }
}

export async function enableTwoFactorHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = twoFactorEnableSchema.parse(req.body);
    if (!req.session.pendingTwoFactorSecret) {
      throw new HttpError(400, "Start two-factor setup first");
    }

    const response = await enableTwoFactor(req.user!.id, {
      secret: req.session.pendingTwoFactorSecret,
      code: input.code
    });
    req.session.pendingTwoFactorSecret = undefined;
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

export async function disableTwoFactorHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = twoFactorDisableSchema.parse(req.body);
    const response = await disableTwoFactor(req.user!.id, input);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

async function establishSession(req: Request, user: AuthUser): Promise<void> {
  req.session.userId = user.id;
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

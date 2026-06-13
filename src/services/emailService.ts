import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logFlow } from "../utils/logger.js";

const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS
            }
          : undefined
    })
  : nodemailer.createTransport({
      jsonTransport: true
    });

export async function sendVerificationEmail(user: AuthUser, token: string): Promise<void> {
  const verificationUrl = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Verify your Smart Meeting Assistant email",
    text: [
      `Hi ${user.name},`,
      "",
      "Verify your email address to start using Smart Meeting Assistant:",
      verificationUrl,
      "",
      "This link expires in 24 hours."
    ].join("\n"),
    html: `<p>Hi ${user.name},</p><p>Verify your email address to start using Smart Meeting Assistant.</p><p><a href="${verificationUrl}">Verify email</a></p><p>This link expires in 24 hours.</p>`
  });
}

export async function sendPasswordResetEmail(user: AuthUser, token: string): Promise<void> {
  const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Reset your Smart Meeting Assistant password",
    text: [
      `Hi ${user.name},`,
      "",
      "Use this link to reset your password:",
      resetUrl,
      "",
      "This link expires in 1 hour. If you did not request it, you can ignore this email."
    ].join("\n"),
    html: `<p>Hi ${user.name},</p><p>Use this link to reset your password.</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in 1 hour. If you did not request it, you can ignore this email.</p>`
  });
}

async function sendMail(input: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const info = await transporter.sendMail({
    from: env.SMTP_FROM,
    ...input
  });

  logFlow("email.sent", {
    to: input.to,
    subject: input.subject,
    messageId: info.messageId,
    transport: env.SMTP_HOST ? "smtp" : "json"
  });
}

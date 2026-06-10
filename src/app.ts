import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { createSessionMiddleware } from "./config/session.js";
import { authRoutes } from "./routes/authRoutes.js";
import { meetingRoutes } from "./routes/meetingRoutes.js";
import { errorHandler } from "./utils/errors.js";

export function createApp() {
  const app = express();
  const clientOrigins = env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim());

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: clientOrigins,
      credentials: true
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(createSessionMiddleware());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/meetings", meetingRoutes);
  app.use(errorHandler);

  return app;
}

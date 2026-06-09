import cors from "cors";
import express from "express";
import helmet from "helmet";
import { authRoutes } from "./routes/authRoutes.js";
import { meetingRoutes } from "./routes/meetingRoutes.js";
import { errorHandler } from "./errors.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/meetings", meetingRoutes);
  app.use(errorHandler);

  return app;
}


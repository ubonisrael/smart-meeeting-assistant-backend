import { Router } from "express";
import multer from "multer";
import {
  actionItems,
  ask,
  destroy,
  index,
  search,
  show,
  summary,
  transcript,
  upload
} from "../controllers/meetingController.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();
const recordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

router.use(requireAuth);

router.post("/upload", recordingUpload.single("recording"), upload);
router.get("/", index);
router.get("/:id", show);
router.get("/:id/transcript", transcript);
router.get("/:id/summary", summary);
router.get("/:id/action-items", actionItems);
router.post("/search", search);
router.post("/ask", ask);
router.delete("/:id", destroy);

export { router as meetingRoutes };


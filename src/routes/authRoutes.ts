import { Router } from "express";
import {
  disableTwoFactorHandler,
  enableTwoFactorHandler,
  forgotPassword,
  login,
  logout,
  me,
  refresh,
  register,
  resendVerification,
  resetPasswordHandler,
  setupTwoFactor,
  updatePasswordHandler,
  updateProfileHandler,
  verifyEmail,
  verifyTwoFactorLogin
} from "../controllers/authController.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/login/2fa", verifyTwoFactorLogin);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.post("/email/verify", verifyEmail);
router.post("/email/resend", resendVerification);
router.post("/password/forgot", forgotPassword);
router.post("/password/reset", resetPasswordHandler);
router.get("/me", requireAuth, me);
router.patch("/profile", requireAuth, updateProfileHandler);
router.patch("/password", requireAuth, updatePasswordHandler);
router.post("/2fa/setup", requireAuth, setupTwoFactor);
router.post("/2fa/enable", requireAuth, enableTwoFactorHandler);
router.post("/2fa/disable", requireAuth, disableTwoFactorHandler);

export { router as authRoutes };

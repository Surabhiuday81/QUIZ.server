// server/routes/sessions.js
import express from "express";
import {
  startQuiz,
  getSession,
  saveSession,
  submitSession,
  
} from "../controllers/sessionController.js";
import authMiddleware from "../middlewares/authMiddleware.js";

const router = express.Router();

/** Start session */
router.post("/sessions/quizzes/:id/start", authMiddleware, startQuiz);

/** Get session */
router.get("/sessions/:sessionId", authMiddleware, getSession);

/** Autosave */
router.patch("/sessions/:sessionId/save", authMiddleware, saveSession);

/** Submit session */
router.post("/sessions/:sessionId/submit", authMiddleware, submitSession);

/** USER HISTORY — required for QuizDetail */
router.get(
  "/sessions/user/history/all",
  authMiddleware
);

export default router;

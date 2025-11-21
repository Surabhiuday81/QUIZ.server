// server/routes/myQuizzes.js
import express from "express";
import { getMyQuizzes, getQuizLeaderboard } from "../controllers/myQuizzesController.js";
import authMiddleware from "../middlewares/authMiddleware.js";

const router = express.Router();

/**
 * My quizzes listing (creator only)
 */
router.get("/my-quizzes", authMiddleware, getMyQuizzes);

/**
 * Per-quiz leaderboard (creator only)
 * Example: GET /api/quizzes/<id>/leaderboard?limit=20
 */
router.get("/quizzes/:id/leaderboard", authMiddleware, getQuizLeaderboard);

export default router;

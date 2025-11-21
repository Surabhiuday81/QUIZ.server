// server/routes/stats.js
import express from "express";
import { getLeaderboard, getUserStats } from "../controllers/statsController.js";
import optionalAuth from "../middlewares/optionalAuth.js";

const router = express.Router();

/**
 * Public leaderboard endpoint.
 * Uses optionalAuth to attach req.user when a valid token is present.
 * Returns top users and optionally myRank if authenticated.
 */
router.get("/leaderboard", optionalAuth, getLeaderboard);

/**
 * Public user stats endpoint (no auth required).
 */
router.get("/users/:username/stats", getUserStats);

export default router;

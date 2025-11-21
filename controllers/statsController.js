// server/controllers/statsController.js
import User from "../models/User.js";
import QuizSession from "../models/QuizSession.js";
import NodeCache from "node-cache";

const CACHE_TTL = Number(process.env.LEADERBOARD_CACHE_TTL || 60); // seconds
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: Math.max(10, Math.floor(CACHE_TTL / 2)) });

/**
 * GET /api/leaderboard?limit=50
 * Returns top users by points, plus the requesting user's rank if token provided.
 * Uses in-memory cache to reduce DB load.
 */
export async function getLeaderboard(req, res) {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const cacheKey = `leaderboard:${limit}`;

    // Attempt cache read
    const cached = cache.get(cacheKey);
    if (cached) {
      // If user is authenticated, compute myRank fresh to keep it up-to-date (cheap)
      if (req.user && req.user.id) {
        const me = await User.findById(req.user.id).select("points");
        const better = me ? await User.countDocuments({ points: { $gt: me.points } }) : null;
        return res.json({ top: cached.top, myRank: better !== null ? better + 1 : null, cached: true });
      }
      return res.json({ top: cached.top, myRank: null, cached: true });
    }

    // Not cached — compute
    const top = await User.find({})
      .sort({ points: -1, "stats.totalCorrect": -1 })
      .limit(limit)
      .select("username points stats avatar")
      // FIX: Use .lean() to return plain JavaScript objects that node-cache can safely clone.
      .lean();

    cache.set(cacheKey, { top });

    // If requester provided a token and we can get their user id, compute their rank
    let myRank = null;
    if (req.user && req.user.id) {
      const me = await User.findById(req.user.id).select("points");
      if (me) {
        const better = await User.countDocuments({ points: { $gt: me.points } });
        myRank = better + 1;
      }
    }

    return res.json({ top, myRank, cached: false });
  } catch (err) {
    console.error("getLeaderboard error:", err);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
}

/**
 * GET /api/users/:username/stats
 * Returns user stats and recent session history (last N).
 * No caching for per-user stats (kept fresh).
 */
export async function getUserStats(req, res) {
  try {
    const { username } = req.params;
    const recentLimit = Math.min(50, Number(req.query.recent) || 10);

    const user = await User.findOne({ username }).select("username email points stats avatar createdAt");
    if (!user) return res.status(404).json({ error: "User not found" });

    // recent sessions
    const sessions = await QuizSession.find({ user: user._id, isPractice: false })
      .sort({ finishedAt: -1 })
      .limit(recentLimit)
      .select("quiz score totalQuestions finishedAt autoSubmitted createdAt");

    return res.json({
      user: {
        username: user.username,
        email: user.email,
        points: user.points,
        stats: user.stats,
        avatar: user.avatar,
        joinedAt: user.createdAt
      },
      recent: sessions
    });
  } catch (err) {
    console.error("getUserStats error:", err);
    return res.status(500).json({ error: "Failed to fetch user stats" });
  }
}
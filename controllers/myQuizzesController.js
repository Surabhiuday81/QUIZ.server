// server/controllers/myQuizzesController.js
import Quiz from "../models/Quiz.js";
import QuizSession from "../models/QuizSession.js";
import User from "../models/User.js";

/**
 * GET /api/my-quizzes
 * Auth required.
 * Returns list of quizzes owned by the logged-in user with basic aggregated stats:
 *  - totalAttempts
 *  - avgScore
 *  - lastAttempt (ISO string)
 */
export async function getMyQuizzes(req, res) {
  try {
    const userId = req.user.id;

    // fetch quizzes created by user
    const quizzes = await Quiz.find({ creator: userId }).sort({ createdAt: -1 }).lean();

    if (!quizzes || quizzes.length === 0) {
      return res.json({ quizzes: [] });
    }

    const quizIds = quizzes.map((q) => q._id);

    // aggregate stats from QuizSession for these quizzes
    const stats = await QuizSession.aggregate([
      { $match: { quiz: { $in: quizIds }, status: "finished" } },
      {
        $group: {
          _id: "$quiz",
          totalAttempts: { $sum: 1 },
          avgScore: { $avg: "$score" },
          lastAttempt: { $max: "$finishedAt" },
        },
      },
    ]);

    // map stats by quiz id
    const statsMap = {};
    stats.forEach((s) => {
      statsMap[String(s._id)] = {
        totalAttempts: s.totalAttempts,
        avgScore: s.avgScore,
        lastAttempt: s.lastAttempt,
      };
    });

    // attach stats to quizzes
    const result = quizzes.map((q) => {
      const s = statsMap[String(q._id)] || { totalAttempts: 0, avgScore: 0, lastAttempt: null };
      return {
        ...q,
        stats: {
          totalAttempts: s.totalAttempts,
          avgScore: s.avgScore,
          lastAttempt: s.lastAttempt,
        },
      };
    });

    return res.json({ quizzes: result });
  } catch (err) {
    console.error("getMyQuizzes error:", err);
    return res.status(500).json({ error: "Failed to fetch your quizzes" });
  }
}

/**
 * GET /api/quizzes/:id/leaderboard?limit=20
 * Auth required.
 * Only quiz creator may call this endpoint (creator-only).
 *
 * Returns list of top users for this quiz, computed as:
 *  - For each user who finished the quiz, take their best score (max) and most recent finishedAt.
 *  - Sort by best score desc, then by most recent finishedAt desc.
 */
export async function getQuizLeaderboard(req, res) {
  try {
    const userId = req.user.id;
    const quizId = req.params.id;
    const limit = Math.min(100, Number(req.query.limit) || 20);

    const quiz = await Quiz.findById(quizId).lean();
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    // Only creator can view leaderboard for now
    if (String(quiz.creator) !== String(userId)) {
      return res.status(403).json({ error: "Only the quiz creator can view the leaderboard" });
    }

    // Aggregate best score per user for this quiz
    const pipeline = [
      { $match: { quiz: quiz._id, status: "finished" } },
      // group by user to get best score and last finishedAt
      {
        $group: {
          _id: "$user",
          bestScore: { $max: "$score" },
          lastFinishedAt: { $max: "$finishedAt" },
          attempts: { $sum: 1 },
        },
      },
      // join to users to get username + email
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          userId: "$_id",
          bestScore: 1,
          lastFinishedAt: 1,
          attempts: 1,
          username: "$userInfo.username",
          email: "$userInfo.email",
        },
      },
      { $sort: { bestScore: -1, lastFinishedAt: -1 } },
      { $limit: limit },
    ];

    const rows = await QuizSession.aggregate(pipeline);

    // map output for client
    const leaderboard = rows.map((r) => ({
      userId: r.userId,
      username: r.username || "Unknown",
      email: r.email || null,
      bestScore: r.bestScore,
      attempts: r.attempts,
      lastFinishedAt: r.lastFinishedAt,
    }));

    return res.json({ quizId: quiz._id, title: quiz.title, leaderboard });
  } catch (err) {
    console.error("getQuizLeaderboard error:", err);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
}

// server/routes/quizzes.js
import express from "express";
import crypto from "crypto";
import Quiz from "../models/Quiz.js";
import QuizSession from "../models/QuizSession.js";
import { generateQuiz } from "../services/aiService.js";
import authMiddleware from "../middlewares/authMiddleware.js";

const router = express.Router();

function makeShareCode(len = 28) {
  return crypto.randomBytes(Math.ceil(len * 3 / 4)).toString("base64url").slice(0, len);
}

/**
 * POST /api/quizzes/generate
 */
router.post("/generate", async (req, res) => {
  const { topic = "General Knowledge", difficulty = "easy", maxQuestions = 1 } = req.body;
  try {
    const quiz = await generateQuiz({ topic, difficulty, maxQuestions });
    return res.json(quiz);
  } catch (err) {
    console.error("AI generation error:", err);
    const fallback = {
      title: `Sample: ${topic}`,
      description: "Fallback quiz (stub)",
      questions: [
        {
          qid: "q1",
          type: "mcq",
          difficulty: "easy",
          question: `What is ${topic}?`,
          choices: ["A", "B", "C", "D"],
          answer_index: 0,
          explanation: "Fallback explanation"
        }
      ]
    };
    return res.status(200).json(fallback);
  }
});

/**
 * POST /api/quizzes
 * Create quiz. If publish === true => set startAt = now, endAt = now + 24h.
 * If private & generateShare => create shareCode + shareExpiresAt (24h by default)
 */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      title,
      description,
      topic,
      isPublic = true,
      questions = [],
      settings = {},
      publish = false,
      generateShare = false,
      shareExpiresHours = 24
    } = req.body;

    let startAt = null;
    let endAt = null;
    if (publish === true) {
      const now = new Date();
      startAt = now;
      endAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }

    let shareCode = null;
    let shareExpiresAt = null;
    if (!isPublic && generateShare) {
      shareCode = makeShareCode(28);
      const now = new Date();
      shareExpiresAt = new Date(now.getTime() + (Number(shareExpiresHours || 24) * 60 * 60 * 1000));
    }

    const quiz = new Quiz({
      title,
      description: description || "",
      topic: topic || "",
      creator: req.user.id,
      isPublic,
      shareCode,
      shareExpiresAt,
      questions,
      settings,
      startAt,
      endAt
    });

    await quiz.save();
    return res.status(201).json(quiz);
  } catch (err) {
    console.error("Create quiz error:", err);
    return res.status(500).json({ error: "Failed to create quiz" });
  }
});

/**
 * PUT /api/quizzes/:id
 * Update quiz (owner only). Supports toggling privacy and generate/revoke share.
 */
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;
    const quiz = await Quiz.findById(id);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    if (String(quiz.creator) !== String(req.user.id)) return res.status(403).json({ error: "Not allowed" });

    if (body.title !== undefined) quiz.title = body.title;
    if (body.description !== undefined) quiz.description = body.description;
    if (body.topic !== undefined) quiz.topic = body.topic;
    if (body.isPublic !== undefined) quiz.isPublic = body.isPublic;
    if (body.questions !== undefined) quiz.questions = body.questions;
    if (body.settings !== undefined) quiz.settings = body.settings;

    if (body.publish === true) {
      const now = new Date();
      quiz.startAt = now;
      quiz.endAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }

    if (body.generateShare === true && quiz.isPublic === false) {
      quiz.shareCode = makeShareCode(28);
      const hours = Number(body.shareExpiresHours || 24);
      quiz.shareExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    }

    if (body.revokeShare === true) {
      quiz.shareCode = null;
      quiz.shareExpiresAt = null;
    }

    quiz.updatedAt = new Date();
    await quiz.save();
    return res.json(quiz);
  } catch (err) {
    console.error("Update quiz error:", err);
    return res.status(500).json({ error: "Failed to update quiz" });
  }
});

/**
 * POST /api/quizzes/:id/regenerate-share
 * Regenerate share code (owner only). Returns { shareCode, shareExpiresAt }.
 */
router.post("/:id/regenerate-share", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const quiz = await Quiz.findById(id);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    if (String(quiz.creator) !== String(req.user.id)) return res.status(403).json({ error: "Not allowed" });
    if (quiz.isPublic) return res.status(400).json({ error: "Public quizzes do not use share links" });

    quiz.shareCode = makeShareCode(28);
    const hours = Number(req.body.shareExpiresHours || 24);
    quiz.shareExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    await quiz.save();

    return res.json({ shareCode: quiz.shareCode, shareExpiresAt: quiz.shareExpiresAt });
  } catch (err) {
    console.error("Regenerate share error:", err);
    return res.status(500).json({ error: "Failed to regenerate share code" });
  }
});

/**
 * GET /api/quizzes/by-share/:shareCode
 * Fetch quiz by share code (anonymous allowed). Does NOT include correct answers.
 */
router.get("/by-share/:shareCode", async (req, res) => {
  try {
    const { shareCode } = req.params;
    if (!shareCode) return res.status(400).json({ error: "Missing share code" });

    const now = new Date();
    const quiz = await Quiz.findOne({
      shareCode,
      $or: [{ shareExpiresAt: { $exists: false } }, { shareExpiresAt: null }, { shareExpiresAt: { $gt: now } }]
    }).populate("creator", "username email");

    if (!quiz) return res.status(404).json({ error: "Invalid or expired share link" });

    const safeQuestions = (quiz.questions || []).map((q) => {
      const { qid, type, difficulty, question, choices } = q;
      return { qid, type, difficulty, question, choices: choices || [] };
    });

    return res.json({
      _id: quiz._id,
      title: quiz.title,
      description: quiz.description,
      topic: quiz.topic,
      creator: quiz.creator,
      isPublic: quiz.isPublic,
      startAt: quiz.startAt,
      endAt: quiz.endAt,
      shareExpiresAt: quiz.shareExpiresAt,
      questions: safeQuestions
    });
  } catch (err) {
    console.error("Get by share error:", err);
    return res.status(500).json({ error: "Failed to fetch by share code" });
  }
});

/**
 * GET /api/quizzes
 * Supports q (text search), public param, active filter, pagination.
 */
router.get("/", async (req, res) => {
  try {
    const { q, public: isPublicParam, active, limit = 50, skip = 0 } = req.query;
    const now = new Date();
    const filter = {};

    if (isPublicParam === "false") filter.isPublic = false;
    else filter.isPublic = true;

    if (active === "true") {
      filter.$and = [
        { $or: [{ startAt: { $exists: false } }, { startAt: null }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: { $exists: false } }, { endAt: null }, { endAt: { $gt: now } }] }
      ];
    }

    if (q && typeof q === "string" && q.trim().length > 0) {
      const clean = q.trim();
      filter.$text = { $search: clean };
    }

    const found = await Quiz.find(filter)
      .sort({ createdAt: -1 })
      .skip(Number(skip || 0))
      .limit(Math.min(Number(limit || 50), 200))
      .populate("creator", "username");

    const safe = found.map((quiz) => {
      return {
        _id: quiz._id,
        title: quiz.title,
        description: quiz.description,
        topic: quiz.topic,
        creator: quiz.creator,
        isPublic: quiz.isPublic,
        startAt: quiz.startAt,
        endAt: quiz.endAt,
        shareExpiresAt: quiz.shareExpiresAt,
        questionsCount: (quiz.questions || []).length,
        createdAt: quiz.createdAt
      };
    });

    return res.json(safe);
  } catch (err) {
    console.error("List quizzes error:", err);
    return res.status(500).json({ error: "Failed to list quizzes" });
  }
});

/**
 * GET /api/quizzes/my
 * Returns quizzes owned by the logged-in user with stats:
 *  - attempts (number)
 *  - avgScore (float)
 *  - lastAttempt (date|null)
 * Includes shareCode and shareExpiresAt so owner can copy/regenerate.
 */
router.get("/my", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const quizzes = await Quiz.find({ creator: userId }).sort({ createdAt: -1 }).lean();

    // For each quiz compute stats by querying QuizSession
    const enriched = await Promise.all(quizzes.map(async (q) => {
      // find finished or timed-out sessions
      const sessions = await QuizSession.find({ quiz: q._id, status: { $in: ["finished", "timed-out"] } }).select("score finishedAt").lean();

      const attempts = sessions.length;
      const avgScore = attempts === 0 ? 0 : (sessions.reduce((s, it) => s + (it.score || 0), 0) / attempts);
      const lastAttempt = attempts === 0 ? null : sessions.reduce((mx, it) => {
        if (!it.finishedAt) return mx;
        const d = new Date(it.finishedAt);
        return mx === null || d > mx ? d : mx;
      }, null);

      return {
        _id: q._id,
        title: q.title,
        description: q.description,
        topic: q.topic,
        isPublic: q.isPublic,
        questionsCount: (q.questions || []).length,
        startAt: q.startAt,
        endAt: q.endAt,
        shareCode: q.shareCode || null,
        shareExpiresAt: q.shareExpiresAt || null,
        attempts,
        avgScore: Number(avgScore.toFixed(2)),
        lastAttempt
      };
    }));

    return res.json(enriched);
  } catch (err) {
    console.error("Get my quizzes error:", err);
    return res.status(500).json({ error: "Failed to load your quizzes" });
  }
});

/**
 * GET /api/quizzes/:id
 * Return quiz detail (no correct answers).
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const quiz = await Quiz.findById(id).populate("creator", "username email");
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const safeQuestions = (quiz.questions || []).map((q) => {
      const { qid, type, difficulty, question, choices } = q;
      return { qid, type, difficulty, question, choices: choices || [] };
    });

    return res.json({
      _id: quiz._id,
      title: quiz.title,
      description: quiz.description,
      topic: quiz.topic,
      creator: quiz.creator,
      isPublic: quiz.isPublic,
      startAt: quiz.startAt,
      endAt: quiz.endAt,
      shareCode: quiz.shareCode || null,
      shareExpiresAt: quiz.shareExpiresAt || null,
      questions: safeQuestions,
      settings: quiz.settings
    });
  } catch (err) {
    console.error("Get quiz error:", err);
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

export default router;
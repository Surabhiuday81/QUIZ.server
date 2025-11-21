// server/controllers/sessionController.js
import Quiz from "../models/Quiz.js";
import QuizSession from "../models/QuizSession.js";
import User from "../models/User.js";
import { gradeAll } from "../services/grading.js";

/**
 * Session controller:
 * - startQuiz(req): POST /api/sessions/quizzes/:id/start
 * - getSession(req):  GET  /api/sessions/:sessionId
 * - saveSession(req): PATCH /api/sessions/:sessionId/save
 * - submitSession(req): POST /api/sessions/:sessionId/submit
 *
 * All endpoints require auth and ensure session ownership where necessary.
 */

/**
 * POST /api/sessions/quizzes/:id/start
 */
export async function startQuiz(req, res) {
  try {
    const userId = req.user.id;
    const username = req.user.username || req.user.email || "user";
    const quizId = req.params.id;

    const quiz = await Quiz.findById(quizId);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const now = new Date();

    // Availability window enforcement
    if (quiz.startAt && now < new Date(quiz.startAt)) {
      return res.status(400).json({ error: "Quiz has not started yet" });
    }
    if (quiz.endAt && now > new Date(quiz.endAt)) {
      return res.status(400).json({ error: "Quiz has ended" });
    }

    // Single-attempt enforcement
    const existingFinished = await QuizSession.findOne({ quiz: quizId, user: userId, status: "finished" });
    if (existingFinished) {
      return res.status(403).json({ error: "You have already completed this quiz (single attempt only)" });
    }

    // Snapshot questions (including answers server-side)
    const questionsSnapshot = (quiz.questions || []).map((q, i) => ({
      qid: q.qid || `q${i + 1}`,
      type: q.type,
      difficulty: q.difficulty,
      question: q.question,
      choices: q.choices || [],
      // server keeps answers for grading (not returned to client)
      answer_index: q.answer_index ?? null,
      answer_text: q.answer_text ?? null,
      explanation: q.explanation ?? ""
    }));

    // shuffle if requested
    if (quiz.settings?.shuffleQuestions) {
      for (let i = questionsSnapshot.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [questionsSnapshot[i], questionsSnapshot[j]] = [questionsSnapshot[j], questionsSnapshot[i]];
      }
    }

    // Determine per-attempt duration (seconds)
    const durationSeconds = quiz.settings?.attemptDurationSeconds ?? quiz.settings?.timeLimitSeconds ?? null;
    let expiresAt = null;
    if (durationSeconds && Number(durationSeconds) > 0) {
      expiresAt = new Date(Date.now() + Number(durationSeconds) * 1000);
    }

    // Create session
    const session = new QuizSession({
      quiz: quiz._id,
      user: userId,
      username,
      status: "in-progress",
      startedAt: new Date(),
      expiresAt,
      questions: questionsSnapshot,
      totalQuestions: questionsSnapshot.length,
      isPractice: false,
      attemptDurationSeconds: durationSeconds,
      answers: [] // initially empty
    });

    await session.save();

    // prepare client-safe questions (no answers)
    const clientQuestions = questionsSnapshot.map((q) => {
      const { qid, type, difficulty, question, choices } = q;
      return { qid, type, difficulty, question, choices };
    });

    return res.json({
      sessionId: session._id,
      quizId: quiz._id,
      expiresAt,
      attemptDurationSeconds: durationSeconds,
      totalQuestions: session.totalQuestions,
      questions: clientQuestions
    });
  } catch (err) {
    console.error("startQuiz error:", err);
    return res.status(500).json({ error: "Failed to start quiz" });
  }
}

/**
 * GET /api/sessions/:sessionId
 * Returns session snapshot for owner (including saved answers).
 */
export async function getSession(req, res) {
  try {
    const userId = req.user.id;
    const sessionId = req.params.sessionId;

    const session = await QuizSession.findById(sessionId).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (String(session.user) !== String(userId)) {
      return res.status(403).json({ error: "This session does not belong to you" });
    }

    // ✨ NEW LOGIC: Only show answers/explanations if the quiz is finished
    const isFinished = session.status === "finished";
    let reviewDetails = [];

    // Return safe subset of questions (hiding answers unless finished)
    const clientQuestions = (session.questions || []).map((q) => {
      const safeQ = {
        qid: q.qid,
        type: q.type,
        difficulty: q.difficulty,
        question: q.question,
        choices: q.choices || []
      };

      // If finished, we expose the correct answer details and explanation
      if (isFinished) {
          safeQ.explanation = q.explanation;
          safeQ.answer_text = q.answer_text;
          safeQ.answer_index = q.answer_index;
      }
      return safeQ;
    });

    if (isFinished) {
      // Reconstruct the full review details array for the frontend to easily display
      // This merges the original question snapshot (q) with the stored answers (which contain isCorrect)
      reviewDetails = (session.questions || []).map(q => {
          const answer = session.answers.find(a => a.qid === q.qid) || {};
          
          return {
              qid: q.qid,
              isCorrect: answer.isCorrect || false,
              userAnswer: answer.userAnswer,
              explanation: q.explanation,
              question: q.question,
              // Determine expected based on the full question snapshot
              expected: q.answer_text || (q.choices && q.choices[q.answer_index]) || null,
          };
      });
    }

    // convert session.answers array to map qid->userAnswer/fullAnswer for client
    const answersMap = {};
    (session.answers || []).forEach((a) => {
      // If finished, send the full answer object which includes isCorrect
      answersMap[a.qid] = isFinished ? a : a.userAnswer; 
    });

    return res.json({
      _id: session._id,
      quiz: session.quiz,
      status: session.status,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      totalQuestions: session.totalQuestions,
      attemptDurationSeconds: session.attemptDurationSeconds,
      questions: clientQuestions,
      // ✨ NEW: Send the full review details if available/finished
      details: reviewDetails.length > 0 ? reviewDetails : undefined, 
      answers: answersMap,
      score: session.score ?? 0,
      autoSubmitted: session.autoSubmitted ?? false
    });
  } catch (err) {
    console.error("getSession error:", err);
    return res.status(500).json({ error: "Failed to load session" });
  }
}

/**
 * PATCH /api/sessions/:sessionId/save
 * Body: { answers } where answers is an object mapping qid->userAnswer OR an array of { qid, userAnswer }
 * Saves partial answers into the session.answers array. Only allowed while session is in-progress and owner.
 */
export async function saveSession(req, res) {
  try {
    const userId = req.user.id;
    const sessionId = req.params.sessionId;
    let answersPayload = req.body.answers || {};

    // Accept array or object
    let answersArray = [];
    if (Array.isArray(answersPayload)) {
      // expecting [{ qid, userAnswer }, ...]
      answersArray = answersPayload.map((a) => ({ qid: a.qid, userAnswer: a.userAnswer }));
    } else if (typeof answersPayload === "object") {
      answersArray = Object.keys(answersPayload).map((qid) => ({ qid, userAnswer: answersPayload[qid] }));
    } else {
      return res.status(400).json({ error: "Invalid answers payload" });
    }

    // Fetch session
    const session = await QuizSession.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (String(session.user) !== String(userId)) return res.status(403).json({ error: "This session does not belong to you" });
    if (session.status !== "in-progress") return res.status(409).json({ error: "Session is not in-progress" });

    // Merge answers: for qid in answersArray, overwrite or append
    const existing = Array.isArray(session.answers) ? session.answers.reduce((acc, a) => {
      if (a && a.qid) acc[a.qid] = a;
      return acc;
    }, {}) : {};

    for (const a of answersArray) {
      if (!a || !a.qid) continue;
      existing[a.qid] = { qid: a.qid, userAnswer: a.userAnswer };
    }

    // Convert back to array
    const merged = Object.keys(existing).map((k) => ({ qid: k, userAnswer: existing[k].userAnswer }));

    // Atomic update of answers + touch updatedAt
    const updated = await QuizSession.findOneAndUpdate(
      { _id: sessionId, status: "in-progress" },
      { $set: { answers: merged } },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({ error: "Session no longer in-progress" });
    }

    return res.json({ ok: true, savedAt: new Date(), answersCount: merged.length });
  } catch (err) {
    console.error("saveSession error:", err);
    return res.status(500).json({ error: "Failed to save session answers" });
  }
}

/**
 * POST /api/sessions/:sessionId/submit
 * Submits the session for grading. Behavior:
 * - If session.expiresAt passed, mark autoSubmitted true.
 * - Grade using gradeAll(session.questions, answersMap).
 * - Atomically mark session finished (status=finished) only if previously in-progress.
 * - Update user stats/points.
 */
export async function submitSession(req, res) {
  try {
    const userId = req.user.id;
    const sessionId = req.params.sessionId;
    const answersPayload = req.body.answers || {};

    const session = await QuizSession.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (String(session.user) !== String(userId)) {
      return res.status(403).json({ error: "This session does not belong to you" });
    }

    if (session.status !== "in-progress") {
      return res.status(409).json({ error: "Session already finished or timed-out" });
    }

    const now = new Date();
    let autoSubmitted = false;
    if (session.expiresAt && now > session.expiresAt) autoSubmitted = true;

    // Use answersPayload if provided; otherwise use session.answers (saved)
    let answersMap = {};
    if (answersPayload && Object.keys(answersPayload).length > 0) {
      if (Array.isArray(answersPayload)) {
        answersPayload.forEach((a) => { if (a && a.qid) answersMap[a.qid] = a.userAnswer; });
      } else {
        answersMap = Object.assign({}, answersPayload);
      }
    } else {
      // use session.answers
      (session.answers || []).forEach((a) => { if (a && a.qid) answersMap[a.qid] = a.userAnswer; });
    }

    // grade
    const gradeResult = gradeAll(session.questions, answersMap);
    const score = gradeResult.totalCorrect;
    const details = gradeResult.details; // <--- This now includes 'explanation'

    const nowFinish = new Date();

    // Store the graded answers including isCorrect for persistent review
    const answersToStore = details.map((d) => ({
      qid: d.qid,
      userAnswer: d.userAnswer,
      isCorrect: d.isCorrect,
      timeTakenSeconds: d.timeTakenSeconds || 0
    }));

    // atomic update to prevent race
    const updated = await QuizSession.findOneAndUpdate(
      { _id: sessionId, status: "in-progress" },
      {
        $set: {
          status: "finished",
          finishedAt: nowFinish,
          autoSubmitted,
          answers: answersToStore, // <--- Now stores isCorrect
          score
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({ error: "Session already finished (race detected)" });
    }

    // Update user points / stats
    try {
      const userUpdate = await User.findByIdAndUpdate(
        userId,
        {
          $inc: {
            points: score,
            "stats.quizzesAttempted": 1,
            "stats.totalCorrect": score
          }
        },
        { new: true }
      );

      return res.json({
        sessionId: updated._id,
        quizId: updated.quiz,
        score,
        totalQuestions: updated.totalQuestions,
        autoSubmitted,
        // ✨ NEW: Send the details array immediately upon submission
        details, 
        user: { id: userUpdate._id, points: userUpdate.points, stats: userUpdate.stats }
      });
    } catch (uErr) {
      console.error("submitSession: failed to update user stats", uErr);
      // still return result
      return res.json({
        sessionId: updated._id,
        quizId: updated.quiz,
        score,
        totalQuestions: updated.totalQuestions,
        autoSubmitted,
        details
      });
    }
  } catch (err) {
    console.error("submitSession error:", err);
    return res.status(500).json({ error: "Failed to submit session" });
  }
}
// server/models/QuizSession.js
import mongoose from "mongoose";

const AnswerSchema = new mongoose.Schema({
  qid: { type: String, required: true },
  userAnswer: { type: mongoose.Schema.Types.Mixed },
  isCorrect: { type: Boolean, default: false },
  timeTakenSeconds: { type: Number, default: 0 }
}, { _id: false });

const QuizSessionSchema = new mongoose.Schema({
  quiz: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz", required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  username: { type: String, required: true }, // denormalized for quick reads
  status: { type: String, enum: ["in-progress", "finished", "timed-out"], default: "in-progress" },
  startedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  autoSubmitted: { type: Boolean, default: false },
  questions: { type: Array, default: [] }, // snapshot of questions (without correct answers exposed)
  answers: { type: [AnswerSchema], default: [] },
  score: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  isPractice: { type: Boolean, default: false },
  attemptDurationSeconds: { type: Number, default: null }, // per-attempt duration (copied from quiz)
  createdAt: { type: Date, default: Date.now }
});

QuizSessionSchema.index({ quiz: 1, user: 1, status: 1 });
QuizSessionSchema.index({ expiresAt: 1 });

export default mongoose.models.QuizSession || mongoose.model("QuizSession", QuizSessionSchema);

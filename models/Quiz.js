// server/models/Quiz.js
import mongoose from "mongoose";

const QuizSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: "" },
  topic: { type: String, default: "" },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  isPublic: { type: Boolean, default: true },

  // shareCode: opaque token for private sharing (unguessable)
  shareCode: { type: String, default: null, index: true },
  // share expiration (if shareCode present, can expire)
  shareExpiresAt: { type: Date, default: null },

  questions: { type: Array, default: [] },
  settings: {
    attemptDurationSeconds: { type: Number, default: null },
    shuffleQuestions: { type: Boolean, default: false },
    timeLimitSeconds: { type: Number, default: null }
  },

  startAt: { type: Date, default: null },
  endAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

QuizSchema.index({ creator: 1, createdAt: -1 });
QuizSchema.index({ title: "text", topic: "text", description: "text" }); // for text search

export default mongoose.models.Quiz || mongoose.model("Quiz", QuizSchema);

// server/cron/expireSessions.js
/**
 * Simple script to mark expired in-progress sessions as timed-out and grade them.
 * Run periodically (e.g., every minute) with a scheduler or cron.
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import QuizSession from "../models/QuizSession.js";
import User from "../models/User.js";
import { gradeAll } from "../services/grading.js";

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not set. Exiting.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  // Find in-progress sessions that have expiresAt < now
  const now = new Date();
  const expired = await QuizSession.find({ status: "in-progress", expiresAt: { $lte: now } }).limit(200);

  console.log(`Found ${expired.length} expired sessions`);

  for (const s of expired) {
    try {
      // grade with whatever answers exist (likely none)
      const answersMap = {};
      (s.answers || []).forEach(a => (answersMap[a.qid] = a.userAnswer));
      const result = gradeAll(s.questions, answersMap);
      const score = result.totalCorrect;

      // update session
      s.status = "timed-out";
      s.finishedAt = now;
      s.autoSubmitted = true;
      s.score = score;
      s.answers = result.details.map(d => ({ qid: d.qid, userAnswer: d.userAnswer, isCorrect: d.isCorrect }));
      await s.save();

      // update user stats
      await User.findByIdAndUpdate(s.user, {
        $inc: {
          points: score,
          "stats.quizzesAttempted": 1,
          "stats.totalCorrect": score
        }
      });
    } catch (err) {
      console.error("Failed to expire session", s._id, err);
    }
  }

  console.log("Done.");
  mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

// server/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import mongoose from "mongoose";
import authRoutes from "./routes/auth.js";
import statsRoutes from "./routes/stats.js";
import sessionsRoutes from "./routes/sessions.js";
import myQuizzesRoutes from "./routes/myQuizzes.js";
import quizzes from "./routes/quizzes.js"; // existing

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// connect to MongoDB (if using)
if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI, )
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("Mongo connect error:", err));
} else {
  console.warn("MONGO_URI not set — user persistence disabled.");
}

app.get("/", (req, res) => res.send("✅ Quiz Builder Backend Running!"));

app.use("/api/auth", authRoutes);
app.use("/api/quizzes", quizzes);
app.use("/api", myQuizzesRoutes);
app.use("/api", statsRoutes);
app.use("/api", sessionsRoutes);
app.use("/api/sessions", sessionsRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// server/models/User.js
import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String }, // local auth only; store hashed password
  avatar: { type: String, default: "" },
  provider: { type: String, enum: ["local"], default: "local" }, // no google
  points: { type: Number, default: 0 },
  stats: {
    quizzesAttempted: { type: Number, default: 0 },
    totalCorrect: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// keep updatedAt fresh
UserSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.models.User || mongoose.model("User", UserSchema);

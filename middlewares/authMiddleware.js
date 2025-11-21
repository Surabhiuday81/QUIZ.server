// server/middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

export default function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = auth.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // payload must include id, email
    req.user = { id: payload.id, email: payload.email, username: payload.name || payload.username };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

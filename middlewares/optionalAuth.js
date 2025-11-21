// server/middlewares/optionalAuth.js
/**
 * optionalAuth middleware
 * - If Authorization: Bearer <token> is present and valid, attaches req.user
 * - If no token present, continues without error (req.user stays undefined)
 *
 * This is useful for endpoints that are public but can return personalized info
 * when the requester is authenticated (e.g., leaderboard with "myRank").
 */

import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

export default function optionalAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      // no token — continue without attaching user
      return next();
    }
    const token = auth.split(" ")[1];
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = { id: payload.id, email: payload.email, username: payload.username || payload.name };
    } catch (err) {
      // invalid token — do not reject, just ignore and continue
      console.warn("optionalAuth: invalid token, continuing as unauthenticated");
    }
    return next();
  } catch (err) {
    console.error("optionalAuth error:", err);
    return next();
  }
}

// server/services/aiService.js
/**
 * Robust Gemini service with retries + exponential backoff + helpful error wrapping
 * + protective JSON extraction (strip code fences / surrounding text)
 * + server-side sanitization & validation for short answers (single lowercase word)
 *
 * Behavior:
 * - Retries on network errors and 5xx (including 503).
 * - Extracts the first {...} JSON block from the model's output when needed.
 * - Parses JSON and enforces: for short questions, the original AI answer must be a single word.
 *   - We still sanitize and store the lowercase single-word form for evaluation.
 * - On detection of invalid short answers (multi-word), throws an error so caller can use fallback.
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_QUESTIONS = Number(process.env.MAX_QUESTIONS || 10);

// Retry config
const MAX_RETRIES = Number(process.env.AI_MAX_RETRIES || 3);
const BASE_DELAY_MS = Number(process.env.AI_BACKOFF_BASE_MS || 500); // backoff

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to extract useful textual content from a Gemini response object.
 * This function keeps previous heuristics and returns a string or null.
 */
function extractTextFromGeminiResponse(data) {
  try {
    if (data?.candidates?.length) {
      const cand = data.candidates[0];
      // candidate.content can be structured; try common patterns
      const content = cand.content || cand.content?.[0];
      if (content?.parts?.length && content.parts[0]?.text) {
        return content.parts[0].text;
      }
      if (Array.isArray(content) && content[0]?.text) {
        return content[0].text;
      }
      if (typeof cand?.content === "string") return cand.content;
    }

    if (Array.isArray(data?.output)) {
      const out = data.output[0];
      if (out?.content && out.content[0]?.text) return out.content[0].text;
    }

    // fallback: if data is string-like
    if (typeof data === "string") return data;
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Given a text block that may include markdown/code fences or
 * other commentary, extract the first substring that looks like JSON
 * object (from first '{' to matching last '}' ), to make parsing robust.
 */
function extractFirstJsonBlock(text) {
  if (!text || typeof text !== "string") return null;
  // Remove common code fence markers first
  let cleaned = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  // remove inline backticks
  cleaned = cleaned.replace(/`/g, "");
  // Find first { and last } to extract the JSON object block
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    // no obvious JSON object; as fallback return the cleaned entire string
    return cleaned.trim();
  }
  return cleaned.slice(first, last + 1).trim();
}

async function callGemini(payload, timeoutMs = 20000) {
  if (!GEMINI_API_KEY) {
    const err = new Error("GEMINI_API_KEY not configured");
    err.code = "no_api_key";
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent`;

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": GEMINI_API_KEY,
  };

  const instance = axios.create({ timeout: timeoutMs });

  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const resp = await instance.post(url, payload, { headers });
      return resp.data;
    } catch (err) {
      const status = err.response?.status || null;
      const is5xx = status && status >= 500 && status < 600;
      const isNetwork = !err.response;

      console.error(`[aiService] attempt ${attempt} failed:`, {
        message: err.message,
        status,
        code:
          err.code ||
          (err.response && err.response.data && err.response.data.error?.code) ||
          null,
        bodySnippet: err.response
          ? JSON.stringify(err.response.data).slice(0, 1000)
          : null,
      });

      if ((isNetwork || is5xx) && attempt <= MAX_RETRIES) {
        const backoff = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[aiService] retrying in ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`
        );
        await sleep(backoff);
        continue;
      }

      const wrapper = new Error(err.message || "Gemini request failed");
      wrapper.status = status;
      wrapper.code =
        err.code ||
        (err.response && err.response.data && err.response.data.error?.code) ||
        null;
      wrapper.error = err.response?.data || null;
      throw wrapper;
    }
  }
}

/**
 * sanitizeShortAnswer: performs server-side sanitization for short answers.
 * Follows user instruction: answer_text = answer_text.trim().toLowerCase().split(/\s+/)[0]
 *
 * Returns an object: { sanitized, originalHadMultipleWords (bool) }
 */
function sanitizeShortAnswer(raw) {
  if (raw === null || raw === undefined) return { sanitized: "", originalHadMultipleWords: false };
  const s = String(raw).trim();
  const parts = s.split(/\s+/).filter(Boolean); // tokens
  const originalHadMultipleWords = parts.length > 1;
  const sanitized = parts.length > 0 ? parts[0].toLowerCase() : "";
  return { sanitized, originalHadMultipleWords };
}

/**
 * generateQuiz - call Gemini and return parsed quiz JSON with validations
 */
export async function generateQuiz({
  topic = "General Knowledge",
  difficulty = "easy",
  maxQuestions = 1,
}) {
  const N = Math.min(Number(maxQuestions) || 1, MAX_QUESTIONS);

  // Prompt: require single-word lowercase for short answers and tf format
  const systemAndUser = `
You are a quiz generator. Output ONLY valid JSON and nothing else. The JSON must match this schema exactly:
{
  "title":"string",
  "description":"string",
  "questions":[
    {
      "qid":"string",
      "type":"mcq|tf|short",
      "difficulty":"easy|medium|hard",
      "question":"string",
      "choices":["A","B","C","D"],        // only for mcq
      "answer_index":0,                  // for mcq: index into choices
      "answer_text":"string",            // for short/tf
      "explanation":"string"
    }
  ]
}

Rules:
- Generate exactly ${N} questions on "${topic}" with difficulty "${difficulty}".
- For short type questions, the answer_text MUST be a single lowercase word (no spaces, no punctuation).
- For tf questions, answer_text must be exactly "true" or "false" (lowercase).
- Keep each question and explanation under 300 characters.
- Return strictly valid JSON only (no backticks, no commentary, no code fences).
`;

  const payload = {
    contents: [{ parts: [{ text: systemAndUser }] }],
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  // call Gemini with retries
  const data = await callGemini(payload);

  // extract text heuristically from Gemini response
  let text = extractTextFromGeminiResponse(data);
  if (!text) {
    // fallback to stringifying the response body (useful for debugging)
    const e = new Error("Empty or unexpected Gemini response");
    e.raw = JSON.stringify(data).slice(0, 2000);
    throw e;
  }

  // Strip code fences and extract first JSON object-looking block if present
  const jsonBlock = extractFirstJsonBlock(text);

  if (!jsonBlock) {
    const e = new Error("Failed to locate JSON block in Gemini response");
    e.raw = text;
    throw e;
  }

  // Attempt to parse JSON
  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (parseErr) {
    // Provide helpful debug info (raw snippet)
    const e = new Error("Failed to parse JSON returned by Gemini: " + parseErr.message);
    e.raw = jsonBlock.slice(0, 2000);
    throw e;
  }

  // Basic structural validation
  if (!parsed || !Array.isArray(parsed.questions)) {
    const err = new Error("Parsed JSON missing 'questions' array");
    err.raw = JSON.stringify(parsed).slice(0, 2000);
    throw err;
  }

  // Enforce max questions
  if (parsed.questions.length > N) parsed.questions = parsed.questions.slice(0, N);

  // Server-side validation & sanitization for short/tf answers:
  // - For 'short' questions: require original AI answer to be single word; sanitize and set answer_text to sanitized
  // - For 'tf' questions: normalize to "true" or "false"
  for (let i = 0; i < parsed.questions.length; i++) {
    const q = parsed.questions[i];
    if (!q.type) continue;
    if (q.type === "short") {
      const rawAns = q.answer_text ?? "";
      const { sanitized, originalHadMultipleWords } = sanitizeShortAnswer(rawAns);
      if (originalHadMultipleWords) {
        const err = new Error(`Invalid short answer from AI for question index ${i}: answer must be a single word`);
        err.rawAnswer = String(rawAns).slice(0, 200);
        throw err; // caller (route) should catch and fallback to stub
      }
      q.answer_text = sanitized;
    } else if (q.type === "tf") {
      // normalize tf to "true"/"false"
      if (typeof q.answer_text === "string") {
        const t = q.answer_text.trim().toLowerCase();
        if (["true", "t", "yes", "y", "1"].includes(t)) q.answer_text = "true";
        else if (["false", "f", "no", "n", "0"].includes(t)) q.answer_text = "false";
        else {
          // if it's nonsense, force to "false" (or better: reject). We'll normalize to exactly "false".
          q.answer_text = "false";
        }
      } else {
        q.answer_text = String(q.answer_text ?? "").toLowerCase() === "true" ? "true" : "false";
      }
    }
    // for mcq we leave answer_index as-is (could validate bounds later)
  }

  return parsed;
}

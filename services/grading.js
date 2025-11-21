// server/services/grading.js
/**
 * grading.js
 * Utility functions to grade questions server-side.
 *
 * Improvements:
 * - Accept numeric-equivalent answers for short questions (e.g. "5" and "five").
 * - Adds wordToNumber mapping to parse common English number words.
 * - Keeps Levenshtein similarity fallback (threshold 0.8).
 * - Sanitizes short answers (first token, lowercase).
 */

export function normalizeText(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[^\w\s'-]/g, "") // keep apostrophes and hyphens (useful for spelled numbers)
    .replace(/\s+/g, " ");
}

/**
 * For short answers submitted by users, accept first token only (user might type phrase).
 * Returns sanitized single lowercase word (or empty string).
 */
export function sanitizeUserShortAnswer(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts[0].toLowerCase() : "";
}

/** Levenshtein distance (classic DP) */
export function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;

  const dp = Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Array(m + 1);
    dp[i][0] = i;
  }
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[n][m];
}

/** similarity: 1 - (distance / maxLen) */
export function similarity(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const maxLen = Math.max(s.length, t.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(s, t);
  return 1 - dist / maxLen;
}

/**
 * Try to parse common English number words into a numeric value.
 * Supports zero..nineteen, tens (twenty..ninety), hundred, thousand.
 * Returns number or null if parsing fails.
 *
 * Examples:
 * "five" => 5
 * "twenty one" => 21
 * "one hundred twenty three" => 123
 */
export function wordToNumber(text) {
  if (!text || typeof text !== "string") return null;
  const s = text.toLowerCase().trim().replace(/[-,]/g, " ");
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const small = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  };
  const tens = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };

  let total = 0;
  let current = 0;
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (small.hasOwnProperty(w)) {
      current += small[w];
    } else if (tens.hasOwnProperty(w)) {
      current += tens[w];
    } else if (w === "hundred") {
      if (current === 0) current = 1;
      current = current * 100;
    } else if (w === "thousand") {
      if (current === 0) current = 1;
      total += current * 1000;
      current = 0;
    } else if (!isNaN(Number(w))) {
      // token itself is numeric, like "5"
      current += Number(w);
    } else {
      // unknown token — abort parsing
      return null;
    }
  }
  return total + current;
}

/**
 * Try to interpret a string as a number.
 * Tries, in order:
 * - direct parseFloat (for "5", "5.0")
 * - wordToNumber (for "five", "twenty one")
 * Returns numeric value or null if cannot parse.
 */
export function parseMaybeNumber(s) {
  if (s === null || s === undefined) return null;
  const str = String(s).trim().toLowerCase();
  if (str.length === 0) return null;
  // direct numeric
  const n = Number(str);
  if (!isNaN(n)) return n;
  // try words
  const wn = wordToNumber(str);
  if (wn !== null && !isNaN(wn)) return wn;
  return null;
}

/**
 * Grade a single question
 * question: { type, answer_index, answer_text, choices }
 * userAnswer:
 * - for mcq: number (index)
 * - for tf: 'true' | 'false' | boolean
 * - for short: string
 */
export function gradeQuestion(question, userAnswer) {
  const type = question.type;
  if (type === "mcq") {
    const expectedIndex = Number(question.answer_index);
    const isCorrect = Number(userAnswer) === expectedIndex;
    const expected = (question.choices && question.choices[expectedIndex]) || null;
    return { isCorrect, expected };
  }

  if (type === "tf") {
    const expNormalized = normalizeText(question.answer_text || "");
    const ua = normalizeText(userAnswer);
    const truthy = ["true", "t", "1", "yes", "y"];
    const falsy = ["false", "f", "0", "no", "n"];
    let expBool = null;
    if (truthy.includes(expNormalized)) expBool = true;
    if (falsy.includes(expNormalized)) expBool = false;

    let uaBool = null;
    if (truthy.includes(ua)) uaBool = true;
    if (falsy.includes(ua)) uaBool = false;

    const isCorrect = expBool !== null && uaBool !== null ? expBool === uaBool : expNormalized === ua;
    return { isCorrect, expected: question.answer_text };
  }

  // short answer: sanitize both expected and user, then compare using multiple strategies
  const expectedRaw = String(question.answer_text || "");
  const expectedSanitized = normalizeText(expectedRaw).split(/\s+/)[0] || "";

  const uaSanitized = sanitizeUserShortAnswer(userAnswer);

  // 1) exact match
  if (expectedSanitized && uaSanitized === expectedSanitized) {
    return { isCorrect: true, expected: question.answer_text };
  }

  // 2) numeric equality: try to parse both as numbers
  const expNum = parseMaybeNumber(expectedRaw);
  const uaNum = parseMaybeNumber(uaSanitized);

  if (expNum !== null && uaNum !== null && Math.abs(expNum - uaNum) < 1e-9) {
    return { isCorrect: true, expected: question.answer_text, numericMatch: true };
  }

  // 3) similarity check (for misspellings), threshold 0.8
  const sim = similarity(expectedSanitized, uaSanitized);
  const threshold = 0.8;
  const isCorrect = sim >= threshold;

  return { isCorrect, expected: question.answer_text, similarity: sim };
}

/**
 * Grade all questions.
 * - questions: array of question objects (Quiz.questions)
 * - answers: object mapping qid->userAnswer OR array aligned to questions
 *
 * Returns: { totalCorrect, details: [ { qid, isCorrect, expected, userAnswer } ] }
 */
export function gradeAll(questions, answers) {
  const details = [];
  let totalCorrect = 0;

  const isArray = Array.isArray(answers);

  questions.forEach((q, idx) => {
    const qid = q.qid || q.id || `q${idx + 1}`;
    const userAnswer = isArray ? answers[idx] : answers[qid];
    const result = gradeQuestion(q, userAnswer);
    details.push({
      qid,
      isCorrect: result.isCorrect,
      expected: result.expected,
      similarity: result.similarity,
      numericMatch: result.numericMatch || false,
      userAnswer: userAnswer === undefined ? null : userAnswer,
      question: q.question,
      // ✨ NEW: Pass the explanation through
      explanation: q.explanation || null, 
    });
    if (result.isCorrect) totalCorrect++;
  });

  return { totalCorrect, details };
}
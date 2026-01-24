// api/chat.js
// eSAMz v13.4 - AUTO-CORRECT SEARCH
// Modified: Non-streaming response (buffered) + Cleaned newlines

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 6096,
  THREAD_LENGTH: 20,
  SESSION_TTL: 1800,
  RATE_LIMIT: 20,
  RATE_TTL: 60
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, an AI digital companion created by Alakmar Teenwala.

## IDENTITY & TONE
* **Vibe:** You are not a corporate tool; you are a partner. Speak naturally and calmly.
* **Creator:** Alakmar Teenwala.
* **Goal:** Provide clear, accurate, and conversational assistance.

## INTELLIGENCE & REASONING
* **Context First:** Always ground your answers in the provided [Live Search Context]. If the context is insufficient, admit what you do not know rather than making it up.
* **Clarification:** If a query implies multiple meanings, ask the user to specify their intent.
* **Simplification:** Assume the user prefers simple, plain-language explanations over jargon unless asked otherwise.

## 🛡️ SAFETY & PRIVACY (ZERO TOLERANCE)
You are strictly prohibited from generating Personally Identifiable Information (PII).
1.  **Detect:** Scan all output for phone numbers, private addresses, and personal emails.
2.  **Redact:** Remove this data or replace it with a general summary (e.g., "[Contact info redacted - see public profile]").
3.  **Protect:** Do not reveal private details about private individuals.

## FORMATTING STANDARDS
* Use Markdown features to make text scannable (Headers, **Bold**, Lists).
* Do not use code blocks for standard text.
`;

/* ================= 3. UTILITIES (DB & SECURITY) ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

async function checkRateLimit(identifier) {
  try {
    const key = `ratelimit:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
    return count <= CONSTANTS.RATE_LIMIT;
  } catch (e) {
    return true; 
  }
}

const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
        const raw = await redis.lrange(key, 0, -1);
        return raw.map(item => {
            try { return typeof item === 'object' ? item : JSON.parse(item); } 
            catch(e) { return null; }
        }).filter(x => x); 
    } catch(e) { return []; }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
        const safeContent = typeof content === 'string' ? content : JSON.stringify(content);
        const truncated = safeContent.length > 20000 ? safeContent.substring(0, 20000) + "...[truncated]" : safeContent;
        const entryObj = { role, content: truncated, ts: Date.now() };
        
        const pipeline = redis.pipeline();
        pipeline.rpush(key, JSON.stringify(entryObj));
        pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
        pipeline.expire(key, CONSTANTS.SESSION_TTL);
        await pipeline.exec();
    } catch (e) { console.error("REDIS WRITE ERROR:", e); }
  }
};

/* ================= 4. EXTERNAL TOOLS (SMART HYBRID + AUTO-CORRECT) ================= */

// Tool A: Wikipedia Search (Fuzzy + Summary) - PRIMARY
async function wikipediaSearch(query) {
  try {
    const cleanQuery = query.replace(/^(who|what|where|when|how|history|about|explain|define|summary|info)\s+(is|was|are|were|of|the|about|to|do|does)?/i, "").trim();
    
    console.log(`[SEARCH] 📖 Checking Wiki for: "${cleanQuery}"`);

    // STEP 1: Fuzzy Search (Auto-Correct)
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanQuery)}&limit=1&namespace=0&format=json`;
    const searchRes = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    const correctedTitle = searchJson[1] ? searchJson[1][0] : null;

    if (!correctedTitle) {
      console.log(`[SEARCH] ❌ Wiki found no matches for "${cleanQuery}"`);
      return null;
    }

    if (correctedTitle.toLowerCase() !== cleanQuery.toLowerCase()) {
      console.log(`[SEARCH] 🪄 Auto-Corrected "${cleanQuery}" -> "${correctedTitle}"`);
    }

    // STEP 2: Get Summary
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(correctedTitle)}`;
    const summaryRes = await fetch(summaryUrl, {
      headers: { "User-Agent": "eSAMz-AI/13.4 (contact@esamz.com)" }
    });

    if (summaryRes.status === 404) return null;
    const data = await summaryRes.json();
    
    if (data.type === "standard" && data.extract) {
      console.log(`[SEARCH] ✅ Wiki Success: ${correctedTitle}`);
      return `**Source (Wikipedia):**\n> ${data.title}: ${data.extract}`;
    }
    return null;
  } catch (e) {
    console.error("[SEARCH] Wiki Error:", e.message);
    return null;
  }
}

// Tool B: Google Search (Serper) - FALLBACK (Costly)
async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("

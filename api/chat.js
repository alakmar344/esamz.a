// api/chat.js
// eSAMz v14.3 - FINAL SECURITY (Internal Key + Hash Check)

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
  RATE_TTL: 60,
  FILE_CHAR_LIMIT: 10000 
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, an AI digital companion created by Alakmar Teenwala.

## IDENTITY & TONE
* **Vibe:** Casual, confident, and direct. You are a partner, not a search engine.
* **Creator:** Alakmar Teenwala.

## ⛔ NEGATIVE CONSTRAINTS (CRITICAL)
* **NEVER start your response with:** "Based on...", "According to...", "The search results say...", "Here is what I found...", or "Context suggests...".
* **Just answer.** If you found info about "Sakina", simply start with: "Sakina Munim is an accountant at..."
* **No Fluff:** Do not tell the user *how* you know something. Just tell them what you know.

## INTELLIGENCE
* **Invisible Integration:** Treat [Live Search Context] and [Attached Files] as your own memory.
* **Structure:** Use compact paragraphs. Avoid excessive bullet points unless listing distinct items.
* **answer:** for every input user gives see if it is connected to conversation talk in that context try not to shift context very often

## 🛡️ SAFETY & PRIVACY
* **Redact:** Remove specific phone numbers, private home addresses, and personal email addresses.
`;

/* ================= 3. SECURITY & UTILITIES ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

// --- DUAL SECURITY VALIDATION ---
function validateSecurity(req) {
  // 1. Get Headers from Request
  const clientKey = req.headers["x-esamz-key"];
  const clientHash = req.headers["x-esamz-hash"];

  // 2. Get Secrets from Environment
  // These MUST match the keys you provided in your .env file
  const serverKey = process.env.ESAMZ_INTERNAL_KEY; 
  const serverHash = process.env.ESAMZ_KEY_HASH;

  // 3. Fail if anything is missing
  if (!clientKey || !clientHash || !serverKey || !serverHash) return false;

  // 4. CHECK 1: Validate Internal Key (Direct String Match)
  // Checks for: emz_prd_337e741bb144edc83446a3be7d9804a5b7f0162665722d86
  if (clientKey !== serverKey) return false;

  // 5. CHECK 2: Validate Hash Format (Must be 64 chars, hex)
  // Checks for: e88245b05ea000469954d11a5fde13479a63c9364411993b8d43154d1f1e6bd2
  const hashRegex = /^[a-f0-9]{64}$/i;
  if (!hashRegex.test(clientHash)) return false;

  // 6. CHECK 3: Secure Hash Comparison (Timing-Safe)
  try {
    const clientBuffer = Buffer.from(clientHash.toLowerCase());
    const serverBuffer = Buffer.from(serverHash.toLowerCase());
    
    // Ensure lengths match before comparing to avoid errors
    if (clientBuffer.length !== serverBuffer.length) return false;
    
    return crypto.timingSafeEqual(clientBuffer, serverBuffer);
  } catch (e) {
    return false;
  }
}

async function checkRateLimit(identifier) {
  try {
    const key = `ratelimit:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
    return count <= CONSTANTS.RATE_LIMIT;
  } catch (e) {
    return true; // Fail open if Redis is down
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

/* ================= 4. EXTERNAL TOOLS ================= */

// Tool A: Wikipedia
async function wikipediaSearch(query) {
  try {
    const cleanQuery = query.replace(/^(who|what|where|when|how|history|about|explain|define|summary|info)\s+(is|was|are|were|of|the|about|to|do|does)?/i, "").trim();
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanQuery)}&limit=1&namespace=0&format=json`;
    const searchRes = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    const correctedTitle = searchJson[1] ? searchJson[1][0] : null;
    if (!correctedTitle) return null;

    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(correctedTitle)}`;
    const summaryRes = await fetch(summaryUrl, { headers: { "User-Agent": "eSAMz-AI/14.0" } });

    if (summaryRes.status === 404) return null;
    const data = await summaryRes.json();
    
    if (data.type === "standard" && data.extract) {
      return `**Source (Wikipedia):**\n> ${data.title}: ${data.extract}`;
    }
    return null;
  } catch (e) { return null; }
}

// Tool B: Google (Serper)
async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 3 })
    });
    const data = await res.json();
    if (!data.organic) return null;
    return "**Source (Google):**\n" + data.organic.map(r => `> ${r.title}: ${r.snippet}`).join("\n");
  } catch (e) { return null; }
}

// Tool C: File Summarizer
async function generateFileSummary(text, fileName) {
  try {
    const safeText = text.slice(0, 20000); 
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: CONSTANTS.SARVAM_MODEL, 
        messages: [
          { role: "system", content: "Summarize this text concisely." },
          { role: "user", content: `File (${fileName}):\n${safeText}` }
        ],
        max_tokens: 1000, temperature: 0.3
      })
    });
    const data = await res.json();
    return data.choices[0]?.message?.content || "Error generating summary.";
  } catch (e) { return "Error generating summary."; }
}

/* ================= 5. AI ENGINE ================= */
async function streamSarvamChat({ messages, onChunk, wikiGrounding }) {
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: CONSTANTS.SARVAM_MODEL, 
        messages, 
        temperature: wikiGrounding ? 0.3 : 0.7,
        max_tokens: CONSTANTS.MAX_TOKENS, 
        stream: true
      })
    });
    
    if (!res.ok) throw new Error(`Sarvam API Error: ${res.status}`);
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const json = JSON.parse(line.slice(6));
            const txt = json.choices[0]?.delta?.content || "";
            if (txt) onChunk(txt);
          } catch (e) { }
        }
      }
    }
  } catch (e) { throw e; }
}

/* ================= 6. MAIN API HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'OPTIONS') return res.end();

  try {
    const rawBody = req.body || {};
    
    // --- DUAL SECURITY CHECK ---
    // Must pass both Internal Key check AND Hash check
    if (!validateSecurity(req)) {
      res.write("ERROR|Unauthorized: Invalid Security Credentials.");
      return res.end();
    }
    // ---------------------------

    let message = rawBody.message || "";
    const files = rawBody.files || [];
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    const userKey = getUserIdentifier(req, rawBody);
    if (!(await checkRateLimit(userKey))) {
      res.write("ERROR|Rate limit exceeded.");
      return res.end();
    }

    // Smart File Handling
    if (Array.isArray(files) && files.length > 0) {
      let fileContext = "\n\n--- ATTACHED FILES ---\n";
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.content.length > CONSTANTS.FILE_CHAR_LIMIT) {
          res.write(`STATUS|Summarizing ${file.fileName}...\n`);
          const summary = await generateFileSummary(file.content, file.fileName);
          fileContext += `\nFILE ${i+1}: ${file.fileName} [SUMMARIZED]\n${summary}\n`;
        } else {
          fileContext += `\nFILE ${i+1}: ${file.fileName}\n${file.content}\n`;
        }
      }
      message += fileContext;
    }

    const history = await DB.getHistory(sessionId);
    let context = "";
    
    // Search Logic
    const lowerMsg = message.toLowerCase();
    const needsSearch = !files.length && 
      (lowerMsg.includes("who") || lowerMsg.includes("what") || lowerMsg.includes("where") || lowerMsg.includes("news"));

    if (needsSearch) {
      res.write("STATUS|Searching...\n");
      let searchRes = await wikipediaSearch(message.slice(0, 200));
      if (!searchRes) searchRes = await googleSearch(message.slice(0, 200));
      if (searchRes) context = `\n\n[Live Search Context]:\n${searchRes}`;
    }

    res.write("STATUS|Thinking...\n");

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message + context }
    ];

    let fullReply = "";
    
    await streamSarvamChat({
      messages,
      wikiGrounding: !!context, 
      onChunk: (text) => {
        fullReply += text;
        res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
      }
    });

    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}

// api/chat.js
// eSAMz v14.6 - CONNECTIVITY TEST (No Streaming)
// Use this to check if the AI is actually responding.

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", // Updated to a safe default model
  MAX_TOKENS: 1000,
  THREAD_LENGTH: 10,
  SESSION_TTL: 1800,
  RATE_LIMIT: 20,
  RATE_TTL: 60,
  FILE_CHAR_LIMIT: 10000 
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, an AI digital companion created by Alakmar Teenwala.
Answer directly and concisely.
`;

/* ================= 3. SECURITY & UTILITIES ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

function validateSecurity(req) {
  try {
    const clientKey = req.headers["x-esamz-key"];
    const clientHash = req.headers["x-esamz-hash"];
    const serverKey = process.env.ESAMZ_INTERNAL_KEY; 
    const serverHash = process.env.ESAMZ_KEY_HASH;

    if (!serverKey || !serverHash) return "MISSING_ENV";
    if (!clientKey || !clientHash) return false;

    // Simple Direct Check (Debug Mode)
    if (clientKey !== serverKey) return false;
    if (clientHash !== serverHash) return false;

    return true;
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
  } catch (e) { return true; }
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
      const entryObj = { role, content: safeContent, ts: Date.now() };
      const pipeline = redis.pipeline();
      pipeline.rpush(key, JSON.stringify(entryObj));
      pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1); 
      pipeline.expire(key, CONSTANTS.SESSION_TTL); 
      await pipeline.exec();
    } catch (e) { console.error("REDIS ERROR:", e); }
  }
};

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  // Standard JSON Response (No Streaming)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const rawBody = req.body || {};
    
    // --- SECURITY CHECK ---
    const authStatus = validateSecurity(req);
    if (authStatus === "MISSING_ENV") {
       return res.status(500).send("ERROR|Server: Missing ESAMZ_INTERNAL_KEY or ESAMZ_KEY_HASH in .env");
    }
    if (authStatus === false) {
      return res.status(401).send("ERROR|Unauthorized: Security Check Failed.");
    }

    let message = rawBody.message || "";
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    const userKey = getUserIdentifier(req, rawBody);
    if (!(await checkRateLimit(userKey))) {
      return res.status(429).send("ERROR|Rate limit exceeded.");
    }

    // --- NON-STREAMING AI REQUEST ---
    const history = await DB.getHistory(sessionId);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message }
    ];

    // Debug: Print what we are sending
    console.log("Sending to Sarvam:", JSON.stringify(messages));

    const aiRes = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: CONSTANTS.SARVAM_MODEL, // Ensure this model exists in your Sarvam plan
        messages, 
        max_tokens: 500, 
        stream: false // <--- CRITICAL: Streaming is OFF
      })
    });

    if (!aiRes.ok) {
        const errText = await aiRes.text();
        return res.status(500).send(`ERROR|AI API Failed: ${aiRes.status} - ${errText}`);
    }

    const aiData = await aiRes.json();
    const fullReply = aiData.choices?.[0]?.message?.content || "";

    if (!fullReply) {
        return res.status(500).send("ERROR|AI returned empty content.");
    }

    // Save to Memory
    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    // Send the whole thing at once
    res.status(200).send("DONE|" + fullReply);

  } catch (e) {
    res.status(500).send(`ERROR|System Critical: ${e.message}`);
  }
}

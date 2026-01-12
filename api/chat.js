// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v11 (Sarvam-M Reasoning + Real-Time Search + Redis Memory)
// Architect: Alakmar Teenwala

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. SECURITY & CONFIG ================= */
const redis = Redis.fromEnv();

// Verify that only your frontend can talk to this backend
function verifyServerIntegrity() {
  const raw = process.env.ESAMZ_INTERNAL_KEY;
  const hash = process.env.ESAMZ_KEY_HASH;
  // If keys aren't set in Vercel, skip check to prevent crashing (Dev mode)
  if (!raw || !hash) return; 
  
  const A = crypto.createHash("sha256").update(raw).digest("hex");
  if (A !== hash) throw new Error("Server integrity check failed");
}

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", // 24B Parameter Model
  MAX_TOKENS: 4096,
  THREAD_LENGTH: 15, // Context window size
  CHAT_LIMIT: 20, // Rate limit per minute
  SESSION_TTL: 1800, // 30 Minutes
  COOKIE_NAME: "esamz_sid"
};

/* ================= 2. INTELLIGENCE (SYSTEM PROMPT) ================= */
const SYSTEM_PROMPT = `
You are eSAMz v11, an advanced AI created by Alakmar Teenwala.
You are running on a high-performance reasoning engine.

CORE INSTRUCTIONS:
1.  **Be Helpful & Direct:** Answer the user's question immediately. No fluff.
2.  **Use Tools Smartly:** If you receive SEARCH RESULTS, you MUST use them to answer.
    * *Example:* If user asks "Bitcoin price / 2", use the search result price and calculate the division.
3.  **Personality:** Friendly, sharp, and concise. Speak like a smart tech founder, not a robot.
4.  **Privacy:** You do not store data. You are a "Zero-Storage" AI.

STRICT RULES:
- Never say "As an AI..."
- Never say "I don't have real-time info" (You DO have it via Search).
- If the user asks for code, provide clean, working code.
`.trim();

/* ================= 3. TOOL: GOOGLE SEARCH (SERPER) ================= */
async function googleSearch(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 4 }) // Fetch top 4 results
    });
    
    if (!response.ok) return null;
    const data = await response.json();
    
    // Extract the best bits
    const answerBox = data.answerBox?.snippet || data.answerBox?.answer || "";
    const organic = data.organic?.map((r) => `- ${r.title}: ${r.snippet}`).join("\n");
    
    return `[REAL-TIME DATA FOUND]:\n${answerBox}\n${organic}`.trim();
  } catch (e) {
    console.error("Search Error:", e);
    return null;
  }
}

// Logic to decide if we need to search
function shouldSearch(msg) {
  const lower = msg.toLowerCase();
  
  // 1. Skip personal/identity questions
  const ignore = ["my name", "who are you", "hello", "hi", "help", "code for"];
  if (ignore.some(x => lower.includes(x))) return false;

  // 2. ALWAYS search for these triggers
  const triggers = ["price", "news", "latest", "today", "weather", "who is", "current", "stock", "usd to", "value of"];
  if (triggers.some(t => lower.includes(t))) return true;

  // 3. Smart Fallback: If it looks like a factual question, search.
  return (msg.endsWith("?") && msg.length > 10);
}

/* ================= 4. BRAIN: SARVAM API STREAM ================= */
async function streamSarvamChat({ messages, onChunk }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("SARVAM_API_KEY missing");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ 
      model: CONSTANTS.SARVAM_MODEL, 
      messages: messages, 
      temperature: 0.5, // Balanced for creativity + logic
      max_tokens: CONSTANTS.MAX_TOKENS,
      stream: true,
      
      // *** v11 UPGRADES ***
      reasoning_effort: "medium", // Enables "Thinking Mode"
      wiki_grounding: true        // Enables built-in fact checking
    })
  });

  if (!res.ok) throw new Error(`Sarvam Error: ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    
    for (const line of lines) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const json = JSON.parse(line.slice(6));
          const content = json.choices[0]?.delta?.content || "";
          if (content) onChunk(content);
        } catch (e) { /* ignore parse errors */ }
      }
    }
  }
}

/* ================= 5. DATABASE (REDIS SESSION) ================= */
const DB = {
  async get(id) {
    return (await redis.get(`session:${id}`)) || { history: [] };
  },
  async save(id, data) {
    // Keep only last N messages to save RAM
    if (data.history.length > CONSTANTS.THREAD_LENGTH) {
      data.history = data.history.slice(-CONSTANTS.THREAD_LENGTH);
    }
    await redis.set(`session:${id}`, data, { ex: CONSTANTS.SESSION_TTL });
  },
  async rateLimit(ip) {
    const k = `rl:${ip}`;
    const c = await redis.incr(k);
    if (c === 1) await redis.expire(k, 60);
    return c <= CONSTANTS.CHAT_LIMIT;
  }
};

/* ================= 6. MAIN SERVER HANDLER ================= */
export default async function handler(req, res) {
  // Set Headers for Streaming
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no'
  });

  // A. Basic Checks
  if (req.method !== 'POST') return res.end("ERROR|Method not allowed");
  try { verifyServerIntegrity(); } catch(e) { return res.end(`ERROR|${e.message}`); }

  try {
    const { message, files } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const ip = req.headers["x-forwarded-for"] || "127.0.0.1";
    
    // B. Cookie / Session ID
    const cookies = req.headers.cookie || "";
    let sessionId = cookies.match(new RegExp(`${CONSTANTS.COOKIE_NAME}=([^;]+)`))?.[1];
    if (!sessionId) {
      sessionId = crypto.randomBytes(16).toString("hex");
      res.write(`EVENT|SET_COOKIE|${CONSTANTS.COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Max-Age=${CONSTANTS.SESSION_TTL}\n`);
    }

    // C. Rate Limit
    if (!(await DB.rateLimit(sessionId))) {
      res.write("ERROR|You are sending messages too fast. Please wait.");
      return res.end();
    }

    // D. Load History
    const session = await DB.get(sessionId);

    // E. Search Execution (The "Agent" Step)
    let contextData = "";
    if (shouldSearch(message)) {
      res.write("STATUS|Searching the live web...\n"); // Tell frontend we are searching
      const searchResult = await googleSearch(message);
      if (searchResult) {
        contextData = `\n\n${searchResult}\n\n(Use the above real-time data to answer the user)`;
      }
    }
    
    res.write("STATUS|Thinking...\n"); // Tell frontend we are processing

    // F. Construct Prompt
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...session.history, // Past context
      { role: "user", content: message + contextData } // Current message + Search Data
    ];

    // G. Generate & Stream Response
    let fullReply = "";
    await streamSarvamChat({
      messages,
      onChunk: (text) => {
        fullReply += text;
        // Clean newlines for SSE format safety
        const safeText = text.replace(/\n/g, "\\n"); 
        res.write(`CHUNK|${safeText}\n`);
      }
    });

    // H. Save to Memory
    session.history.push({ role: "user", content: message });
    session.history.push({ role: "assistant", content: fullReply });
    await DB.save(sessionId, session);

    res.write("DONE|Stream Complete");
    res.end();

  } catch (err) {
    console.error(err);
    res.write(`ERROR|${err.message}`);  
  }
    res.end();
  }
}
    res.end();
  }
}

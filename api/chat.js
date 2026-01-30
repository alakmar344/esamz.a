// api/chat.js
// eSAMz v20.0 - CORRUPTION PROOF MEMORY

import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 28000,              
  THREAD_LENGTH: 20, 
  SESSION_TTL: 604800, // 7 Days
};

/* ================= 1. NAME EXTRACTOR ================= */
function findNameInHistory(history) {
    // Scan previous messages for name declarations
    const combinedText = history
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join(" ");
    
    // Regex to find "I am X", "My name is X", "Myself X"
    const match = combinedText.match(/(?:i am|i'm|im|myself|name is|call me)\s+([a-zA-Z]+)/i);
    return match ? match[1] : null;
}

/* ================= 2. DATABASE LOGIC (SAFE MODE) ================= */
const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
      const raw = await redis.lrange(key, 0, -1);
      return raw.map(item => {
        try {
          // If data is not a string, skip it (Prevents Crash)
          if (typeof item !== 'string') return null;
          const parsed = JSON.parse(item);
          return {
             role: parsed.role === 'user' ? 'user' : 'assistant', 
             content: parsed.content 
          };
        } catch (e) { return null; }
      }).filter(Boolean).slice(-CONSTANTS.THREAD_LENGTH);
    } catch(e) { 
      console.error("Redis Error:", e);
      return []; 
    }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    // Store as simple JSON string
    const entry = JSON.stringify({ role, content, ts: Date.now() });
    await redis.rpush(key, entry);
    await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
    await redis.expire(key, CONSTANTS.SESSION_TTL);
  }
};

/* ================= 3. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

  try {
    const rawBody = req.body || {};
    const sessionId = rawBody.sessionId;
    const message = rawBody.message || "";

    // 1. Check Session ID
    if (!sessionId) {
        res.write("ERROR|Frontend Error: No Session ID sent.");
        res.end();
        return;
    }

    // 2. Load History
    const history = await DB.getHistory(sessionId);
    
    // 3. FORCE MEMORY INJECTION
    // We append the known name directly to the USER message.
    // The AI cannot ignore this because it looks like part of your current question.
    let finalUserMessage = message;
    
    const knownName = findNameInHistory(history);
    if (knownName) {
        // Invisible Context Injection
        finalUserMessage += `\n\n(System Note: The user's name is verified as ${knownName}. If asked, tell them their name is ${knownName}.)`;
    }

    // 4. Construct System Prompt
    const SYSTEM_PROMPT = `
You are eSAMz AI.
* **Context:** You have a conversation history. Read it.
* **Identity:** If a System Note tells you the user's name, BELIEVE IT.
* **Directness:** Be brief and helpful.
`;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: finalUserMessage }
    ];

    // 5. Call AI
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CONSTANTS.SARVAM_MODEL, messages, stream: true })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finalAiReply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const txt = JSON.parse(line.slice(6)).choices[0]?.delta?.content || "";
            if (txt) {
                finalAiReply += txt;
                res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
            }
          } catch (e) {}
        }
      }
    }

    // 6. Save History (Clean)
    // Save the ORIGINAL message (without the system note) to DB
    if (finalAiReply.trim()) {
        await DB.addToHistory(sessionId, 'user', message);
        await DB.addToHistory(sessionId, 'assistant', finalAiReply);
    }

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}

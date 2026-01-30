import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 28000,              
  THREAD_LENGTH: 20, 
  SESSION_TTL: 604800, // 7 Days
};

/* ================= 1. DATABASE LOGIC ================= */
const DB = {
  // Save Name Permanently
  async setIdentity(id, name) {
    await redis.set(`identity:${id}`, name, { ex: CONSTANTS.SESSION_TTL });
  },

  // Get Name
  async getIdentity(id) {
    return await redis.get(`identity:${id}`);
  },

  async getHistory(id) {
    const key = `chat:${id}`;
    try {
      const raw = await redis.lrange(key, 0, -1);
      return raw.map(item => {
        try {
          if (typeof item !== 'string') return null;
          const parsed = JSON.parse(item);
          return { role: parsed.role, content: parsed.content };
        } catch (e) { return null; }
      }).filter(Boolean).slice(-CONSTANTS.THREAD_LENGTH);
    } catch(e) { return []; }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    const entry = JSON.stringify({ role, content, ts: Date.now() });
    await redis.rpush(key, entry);
    await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
    await redis.expire(key, CONSTANTS.SESSION_TTL);
  }
};

/* ================= 2. NAME EXTRACTOR ================= */
function extractName(text) {
    // Matches: "I am Esmail", "My name is Esmail", "Myself Esmail", "Call me Esmail"
    // Case insensitive, robust against punctuation
    const match = text.match(/(?:i am|i'm|im|myself|name is|call me)\s+([a-zA-Z0-9]+)/i);
    if (match && match[1]) {
        // Filter out common false positives
        const ignore = ["here", "happy", "sorry", "tired", "busy", "asking", "an", "a", "the", "ready"];
        if (!ignore.includes(match[1].toLowerCase())) return match[1];
    }
    return null;
}

/* ================= 3. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

  try {
    const rawBody = req.body || {};
    const sessionId = rawBody.sessionId || "default-session";
    const message = rawBody.message || "";

    // 1. Check for Name Declaration in CURRENT message
    // If user says "I am Esmail" right now, save it immediately.
    const detectedName = extractName(message);
    if (detectedName) {
        await DB.setIdentity(sessionId, detectedName);
    }

    // 2. Load Existing Identity & History
    const [storedName, history] = await Promise.all([
        DB.getIdentity(sessionId),
        DB.getHistory(sessionId)
    ]);

    // 3. Construct System Prompt with Hard Identity
    // If we found a name (either just now or in DB), USE IT.
    const finalName = detectedName || storedName || "Unknown";
    
    let dynamicPrompt = `
### **Identity & Core Objective**
You are **eSAMz AI**, a highly advanced, human-like intelligence engine. Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging.

### **CRITICAL INSTRUCTION: SEPARATE THOUGHTS FROM ANSWERS**
You must think before you speak, but you must keep them separate.
1. **First**, output your internal reasoning inside **<thinking>** tags.
2. **Second**, close the tag with **</thinking>**.
3. **Third**, write your final response for the user. 
   * **DO NOT** put your final answer inside the thinking tags. 
   * If you put the answer inside the tags, the user will see NOTHING.

### **Tone & Personality**
* **Conversational:** Speak like a knowledgeable friend. Use contractions.
* **Dynamic:** Be cool, modern, and helpful.
* **No Robot-Speak:** Never say "As an AI".
`;

    if (finalName !== "Unknown") {
        dynamicPrompt += `
### **CRITICAL INSTRUCTION**
* **The User's Name is:** ${finalName}
* If the user asks "Who am I?" or "What is my name?", you **MUST** answer: "Your name is ${finalName}."
* Do not hallucinate other names like "Sam".
`;
    }

    const messages = [
      { role: "system", content: dynamicPrompt },
      ...history,
      { role: "user", content: message }
    ];

    // 4. Call AI
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

    // 5. Save Context
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

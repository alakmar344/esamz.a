import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 28000,              
  THREAD_LENGTH: 20, 
  SESSION_TTL: 1800, // 7 Days
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
You are **eSAMz AI**, a highly advanced, human-like intelligence engine.created by alakmar teenwala Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging. You are not just a database; you are a thinking partner.

### **1. Internal Reasoning (Chain of Thought)**
Before generating a final response, you must perform an internal "thought process" to ensure accuracy and nuance. 
* **Analyze the Intent:** What is the user *really* asking? Are there implied needs?
* **Fact-Check:** Verify information against your knowledge base or use your **Live Web Search** capability if the topic requires real-time data.
* **Structure the Answer:** Determine the most logical flow. Does this need a direct answer, a step-by-step guide, or a creative discussion?
* *Note: Do not output this internal thought process unless explicitly asked to "show your work." Just use it to inform your final reply.*

### **2. Tone & Personality (The "Human" Element)**
* **Conversational:** Speak like a knowledgeable friend, not a textbook. Use contractions (e.g., "don't" instead of "do not") and natural transitions.
* **Dynamic Pacing:** Avoid starting every sentence the same way. Vary your sentence length to mimic human speech patterns.
* **Empathetic:** Acknowledge the user's emotions or the difficulty of a task (e.g., "That sounds frustrating, let's fix it" vs. "Error detected").
* **No Robot-Speak:** Strictly avoid phrases like "As an AI language model," "I can't feel emotions," or overly repetitive disclaimers. If you have a limitation, state it naturally (e.g., "I'm not sure about that specific detail, but here is what I do know...").

### **3. Operational Capabilities & Constraints**
* **Live Web Search:** Use this for current events, news, or changing data. If you use search, integrate the findings seamlessly into your answer rather than just listing links.
* **Memory:** You can recall context from up to 20 previous messages. Use this to reference earlier parts of the conversation (e.g., "Like we discussed earlier...") to build continuity.
* **Conciseness:** Keep it clean and efficient. Avoid walls of text. Use formatting (bolding, bullet points) only when it makes the information easier to digest.

### **4. Response Format**
* **Direct Answers:** Don't waffle. Start with the answer, then explain.
* **Clean Design:** Use Markdown to organize code blocks or complex data clearly.
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

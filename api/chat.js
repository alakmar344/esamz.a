import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing Robotic Backend...");
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_HISTORY: 10, // Keep history short for speed
  SESSION_TTL: 1800 
};

/* ================= 1. ROBOTIC TRIGGER SYSTEM ================= */
// A massive list of trigger words covering people, places, live data, and definitions.
const TRIGGERS = [
  // Question words
  "who", "what", "where", "when", "why", "how", "which",
  // Live Data & News
  "weather", "temperature", "news", "latest", "today", "now", "update", 
  "price", "stock", "crypto", "score", "result", "winner",
  // Figures & Entities
  "president", "pm", "minister", "ceo", "founder", "owner", "boss", 
  "capital", "population", "location", "height", "age", "net worth",
  // Definitions & Info
  "define", "meaning", "history", "about", "wiki", "biography", "plot", "summary",
  // Tech & Vs
  "vs", "versus", "diff", "difference", "code", "install", "error"
];

function shouldSearch(text) {
  const lower = text.toLowerCase();
  // Check if ANY trigger word exists in the user's message
  return TRIGGERS.some(t => lower.includes(t));
}

/* ================= 2. SEARCH TOOLS (WATERFALL) ================= */
const TOOLS = {
  async smartSearch(query) {
    console.log(`[ROBOT] 🤖 analyzing query: "${query}"`);
    
    // --- ATTEMPT 1: WIKIPEDIA (Fast & Free) ---
    try {
      console.log(`[ROBOT] 1️⃣ Trying Wikipedia...`);
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
      const wikiRes = await fetch(wikiUrl);
      const [searchTerm, titles, descriptions, links] = await wikiRes.json();

      // STRICT VALIDATION: Only accept if we got a real description, not a "refer to" page
      if (titles.length > 0 && descriptions[0] && descriptions[0].length > 50 && !descriptions[0].includes("may refer to")) {
        console.log(`[ROBOT] ✅ Wikipedia Success: "${titles[0]}"`);
        return `SOURCE (Wikipedia): ${titles[0]} - ${descriptions[0]} (Link: ${links[0]})`;
      }
      console.log(`[ROBOT] ❌ Wikipedia failed or answer too short. Moving to Google.`);
    } catch (e) {
      console.log(`[ROBOT] ⚠️ Wiki Error: ${e.message}`);
    }

    // --- ATTEMPT 2: GOOGLE / SERPER (Deep & Live) ---
    try {
      console.log(`[ROBOT] 2️⃣ Trying Google (Serper)...`);
      const serperRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: 3 }) 
      });
      
      const data = await serperRes.json();
      if (data.organic && data.organic.length > 0) {
        console.log(`[ROBOT] ✅ Google Success. Found ${data.organic.length} results.`);
        return data.organic.map((r, i) => `SOURCE (Google Result ${i+1}): ${r.title} - ${r.snippet}`).join("\n");
      }
      return null; // Both failed
    } catch (e) {
      console.error(`[ROBOT] ❌ Google Error: ${e.message}`);
      return null;
    }
  }
};

/* ================= 3. DATABASE LAYER ================= */
const DB = {
  async getContext(id) {
    const [name, history] = await Promise.all([
      redis.get(`identity:${id}`),
      redis.lrange(`chat:${id}`, 0, -1)
    ]);
    const parsedHistory = history.map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean).slice(-CONSTANTS.MAX_HISTORY);
    return { name, history: parsedHistory };
  },

  async saveInteraction(id, userMsg, aiMsg, detectedName) {
    const pipeline = redis.pipeline();
    if (detectedName) pipeline.set(`identity:${id}`, detectedName, { ex: CONSTANTS.SESSION_TTL });
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "user", content: userMsg }));
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "assistant", content: aiMsg }));
    pipeline.ltrim(`chat:${id}`, -CONSTANTS.MAX_HISTORY, -1);
    pipeline.expire(`chat:${id}`, CONSTANTS.SESSION_TTL);
    await pipeline.exec();
  }
};

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

  try {
    const { sessionId = "guest", message = "" } = req.body || {};
    console.log(`\n[INCOMING] "${message}"`);

    // 1. Load Context
    const { name: storedName, history } = await DB.getContext(sessionId);
    const userName = storedName || "User";

    // 2. ROBOTIC CHECK: Do we need to search?
    let contextData = "";
    if (shouldSearch(message)) {
      res.write(`CHUNK|🔎 Checking my database...\n`); // Tell user we are working
      const searchResults = await TOOLS.smartSearch(message);
      if (searchResults) {
        contextData = `\n\n[REAL-TIME SEARCH DATA]:\n${searchResults}\n[INSTRUCTION: Use the data above to answer the user's question accurately.]`;
      }
    }

    // 3. Construct Final Prompt
    const systemPrompt = `
You are eSAMz AI, a helpful assistant created by Alakmar Teenwala.


Your goal is to be accurate. 
- If [REAL-TIME SEARCH DATA] is provided below, YOU MUST USE IT to answer.
- If no data is provided, answer from your own knowledge.
- Be concise and friendly.
    `;

    const messages = [
      { role: "system", content: systemPrompt + contextData }, // Inject data directly into system
      ...history,
      { role: "user", content: message }
    ];

    // 4. Call AI (Streaming)
    console.log("[AI] Generatin response...");
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CONSTANTS.SARVAM_MODEL, messages, stream: true, max_tokens: 800 })
    });

    if (!response.ok) throw new Error(`AI Error ${response.status}`);

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
            finalAiReply += txt;
            res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
          } catch (e) {}
        }
      }
    }

    // 5. Save
    await DB.saveInteraction(sessionId, message, finalAiReply, null); // passing null for name detection to keep it simple

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("[ERROR]", e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}

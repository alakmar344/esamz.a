import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing Robotic Backend v2...");
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_HISTORY: 50, 
  SESSION_TTL: 1800 
};

/* ================= 1. ROBOTIC TRIGGER SYSTEM ================= */
const TRIGGERS = [
  "who", "what", "where", "when", "why", "how", "which",
  "weather", "temperature", "news", "latest", "today", "now", "update", 
  "price", "stock", "crypto", "score", "result", "winner",
  "president", "pm", "minister", "ceo", "founder", "owner", "boss", 
  "capital", "population", "location", "height", "age", "net worth",
  "define", "meaning", "history", "about", "wiki", "biography", "plot", "summary",
  "vs", "versus", "diff", "difference", "code", "install", "error"
];

function shouldSearch(text) {
  const lower = text.toLowerCase();
  return TRIGGERS.some(t => lower.includes(t));
}

/* ================= 2. SEARCH TOOLS (WATERFALL) ================= */
const TOOLS = {
  async smartSearch(query) {
    // 1. Try Wikipedia
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
      const wikiRes = await fetch(wikiUrl);
      const [_, titles, descriptions, links] = await wikiRes.json();

      if (titles.length > 0 && descriptions[0] && descriptions[0].length > 50 && !descriptions[0].includes("may refer to")) {
        return `SOURCE (Wikipedia): ${titles[0]} - ${descriptions[0]} (Link: ${links[0]})`;
      }
    } catch (e) { console.log(`Wiki Error: ${e.message}`); }

    // 2. Try Google (Serper)
    try {
      const serperRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: 3 }) 
      });
      
      const data = await serperRes.json();
      if (data.organic && data.organic.length > 0) {
        return data.organic.map((r, i) => `SOURCE (Google Result ${i+1}): ${r.title} - ${r.snippet}`).join("\n");
      }
    } catch (e) { console.error(`Google Error: ${e.message}`); }
    
    return null;
  }
};

/* ================= ADDON: TEXT STRIPPER ================= */
// Removes filler phrases so the database stays clean
function sanitizeResponse(text) {
  const fillerPhrases = [
    "Checking my database...",
    "Searching for information...",
    "Based on the search results,",
    "According to the data found,",
    "Here is what I found:",
    "[REAL-TIME SEARCH DATA]"
  ];
  
  let cleanText = text;
  fillerPhrases.forEach(phrase => {
    // Case-insensitive replace
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    cleanText = cleanText.replace(regex, "");
  });
  
  return cleanText.trim();
}

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
    const cleanAiMsg = sanitizeResponse(aiMsg); // <--- STRIPPER APPLIED HERE
    
    const pipeline = redis.pipeline();
    if (detectedName) pipeline.set(`identity:${id}`, detectedName, { ex: CONSTANTS.SESSION_TTL });
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "user", content: userMsg }));
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "assistant", content: cleanAiMsg }));
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
    
    // 1. Load Context
    const { name: storedName, history } = await DB.getContext(sessionId);
    const userName = storedName || "User";

    // 2. ROBOTIC CHECK & STATUS UPDATE
    let contextData = "";
    if (shouldSearch(message)) {
      // NOTE: We send STATUS| instead of CHUNK|. Frontend can choose to hide/replace this.
      res.write(`STATUS|🔎 Checking my database...\n`); 
      
      const searchResults = await TOOLS.smartSearch(message);
      if (searchResults) {
        contextData = `\n\n[REAL-TIME SEARCH DATA]:\n${searchResults}\n[INSTRUCTION: Answer using the data above. Do not mention that you searched.]`;
      }
    }

    // 3. Construct Prompt
    const systemPrompt = `
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



Answer directly and accurately. Avoid filler phrases like "I searched for..." or "Based on...".
    `;

    const messages = [
      { role: "system", content: systemPrompt + contextData },
      ...history,
      { role: "user", content: message }
    ];

    // 4. Call AI (Streaming)
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

    // 5. Save (Cleaned)
    await DB.saveInteraction(sessionId, message, finalAiReply, null);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("[ERROR]", e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}

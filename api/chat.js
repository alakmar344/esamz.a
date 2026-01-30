import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing eSAMz Backend v10 (Auto-Cleaner)...");
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_HISTORY: 50,
  SESSION_TTL: 1800
};

/* ================= 1. TRIGGER SYSTEM ================= */
const TRIGGERS = [
  "who", "what", "where", "when", "why", "how", "which",
  "weather", "temperature", "news", "latest", "today", "now", "update",
  "price", "stock", "crypto", "score", "result", "winner",
  "president", "pm", "minister", "ceo", "founder", "owner", "boss",
  "capital", "population", "location", "height", "age", "net worth",
  "define", "meaning", "history", "about", "wiki", "biography", "plot", "summary",
  "vs", "versus", "diff", "difference", "code", "install", "error"
];

function isVagueFollowUp(text) {
  const lower = text.toLowerCase().trim();
  const pronouns = ["he", "she", "it", "they", "his", "her", "their", "who", "what", "which"];
  const words = lower.split(" ");
  
  if (words.length < 10 && words.some(w => pronouns.includes(w))) {
    return true; 
  }
  return false;
}

function shouldSearch(text) {
  if (isVagueFollowUp(text)) return false; 
  const lower = text.toLowerCase();
  return TRIGGERS.some(t => lower.includes(t));
}

/* ================= 2. SEARCH TOOLS ================= */
const TOOLS = {
  async smartSearch(query) {
    let context = "";
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
      const wikiRes = await fetch(wikiUrl);
      const [_, titles, descriptions, links] = await wikiRes.json();
      if (titles.length > 0 && descriptions[0]) {
        const desc = descriptions[0];
        if (desc.length > 30 && !desc.includes("may refer to")) {
          context = `SOURCE (Wikipedia): ${titles[0]} - ${desc} (Read more: ${links[0]})`;
          return context;
        }
      }
    } catch (e) {
      console.log(`Wiki fallback triggered: ${e.message}`);
    }
    try {
      const serperRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: 3 })
      });
      const data = await serperRes.json();
      if (data.organic && data.organic.length > 0) {
        context = data.organic.map((r, i) => `SOURCE (Google ${i+1}): ${r.title} - ${r.snippet}`).join("\n");
        return context;
      }
    } catch (e) {
      console.error(`Search Engine Error: ${e.message}`);
    }
    return null;
  }
};

/* ================= ADDON: TEXT STRIPPER ================= */
function sanitizeResponse(text) {
  const fillerPhrases = [
    "Checking my database",
    "Searching for information",
    "Based on the search results",
    "According to the data found",
    "Here is what I found",
    "[REAL-TIME SEARCH DATA]"
  ];
  let cleanText = text;
  fillerPhrases.forEach(phrase => {
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    cleanText = cleanText.replace(regex, "");
  });
  return cleanText.trim();
}

/* ================= 3. DATABASE LAYER (AUTO-DELETE CORRUPTION) ================= */
const DB = {
  async getContext(id) {
    const [name, rawHistory] = await Promise.all([
      redis.get(`identity:${id}`),
      redis.lrange(`chat:${id}`, 0, -1)
    ]);
    
    // Check for the specific bad string
    const hasCorruption = rawHistory.includes('[object Object]');

    if (hasCorruption) {
      console.warn(`[CLEANUP] Found corruption in session ${id}. Deleting '[object Object]' entries...`);
      // Delete ALL instances of '[object Object]' from this list
      await redis.lrem(`chat:${id}`, 0, '[object Object]');
      
      // Re-fetch the history now that it's clean
      const newRawHistory = await redis.lrange(`chat:${id}`, 0, -1);
      console.log(`[CLEANUP] Cleaned ${rawHistory.length - newRawHistory.length} bad entries.`);
      rawHistory.length = 0;
      rawHistory.push(...newRawHistory);
    }

    const parsedHistory = rawHistory.map(item => {
      try { 
        return JSON.parse(item); 
      } catch (e) {
        return null; 
      }
    }).filter(Boolean).slice(-CONSTANTS.MAX_HISTORY);

    console.log(`[MEMORY] Loaded ${parsedHistory.length} valid messages for session ${id}`);
    return { name, history: parsedHistory };
  },

  async saveInteraction(id, userMsg, aiMsg, detectedName) {
    // Force convert to Strings
    const safeUserMsg = (typeof userMsg === 'string') ? userMsg : JSON.stringify(userMsg);
    const safeAiMsg = (typeof aiMsg === 'string') ? aiMsg : JSON.stringify(aiMsg);
    const cleanAiMsg = sanitizeResponse(safeAiMsg);

    const pipeline = redis.pipeline();
    if (detectedName) pipeline.set(`identity:${id}`, detectedName, { ex: CONSTANTS.SESSION_TTL });
    
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "user", content: safeUserMsg }));
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "assistant", content: cleanAiMsg }));
    pipeline.ltrim(`chat:${id}`, -CONSTANTS.MAX_HISTORY, -1);
    pipeline.expire(`chat:${id}`, CONSTANTS.SESSION_TTL);
    
    try {
        await pipeline.exec();
    } catch(e) {
        console.error(`[REDIS SAVE] FAILED:`, e);
    }
  }
};

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

  try {
    const { sessionId = "guest", message = "" } = req.body || {};
    
    if (!message) {
        res.write("ERROR|No message provided");
        res.end();
        return;
    }

    // 1. Load Context
    const { name: storedName, history } = await DB.getContext(sessionId);
    const userName = storedName || "User";

    // 2. Perform Search
    let contextData = "";
    if (shouldSearch(message)) {
      const searchResults = await TOOLS.smartSearch(message);
      if (searchResults) {
        contextData = `\n\n[CONTEXT_INFORMATION]:\n${searchResults}\n[END_CONTEXT]`;
      }
    }

    // 3. Construct System Prompt
    const systemPrompt = `
You are eSAMz AI. Your top priority is logic and context continuity.

CRITICAL LOGIC RULES (Follow these before every answer):

1. PRONOUN RESOLUTION:
   - If the user uses pronouns (he, she, it, his, her, they), you MUST look at the immediately preceding messages to identify the subject.
   - NEVER ask "Who are you referring to?" if the subject was mentioned in the last 3 messages.

2. CLARIFICATION HANDLING:
   - If YOU asked "Who?" or "Which one?" and the user replies with a name (e.g., "Nikola Tesla"), you MUST answer the PREVIOUS question using that name.
   - Do NOT treat the clarification as a request for a biography or general info. Answer the specific pending question.
   - Example: 
     User: "What is his nickname?"
     You: "Who?"
     User: "Tesla"
     You: "Tesla's nickname is..."

3. RESPONSE STYLE:
   - Be direct, natural, and human-like.
   - No robotic filler words ("As an AI", "I searched").
`;

    // Assemble messages
    const messages = [
      { role: "system", content: systemPrompt + contextData },
      ...history,
      { role: "user", content: message }
    ];

    // 4. Call AI
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CONSTANTS.SARVAM_MODEL, messages, stream: true, max_tokens: 800 })
    });

    if (!response.ok) throw new Error(`AI API Error ${response.status}`);

    // 5. Handle Streaming Response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finalAiReply = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const dataStr = line.slice(6);
            const parsed = JSON.parse(dataStr);
            const txt = parsed.choices[0]?.delta?.content || "";
            
            if (txt) {
              finalAiReply += txt;
              res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
            }
          } catch (e) {}
        }
      }
    }

    // 6. Save to Redis
    await DB.saveInteraction(sessionId, message, finalAiReply, null);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("[CRITICAL ERROR]", e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}

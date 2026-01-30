import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing eSAMz Backend v3...");
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_HISTORY: 50,
  SESSION_TTL: 1800 // 30 minutes
};

/* ================= 1. TRIGGER SYSTEM ================= */
// Words that trigger the need for external data
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

/* ================= 2. SEARCH TOOLS (WIKIPEDIA -> SERPER) ================= */
const TOOLS = {
  async smartSearch(query) {
    let context = "";

    // 1. PRIMARY: Wikipedia
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
      const wikiRes = await fetch(wikiUrl);
      const [_, titles, descriptions, links] = await wikiRes.json();

      if (titles.length > 0 && descriptions[0]) {
        const desc = descriptions[0];
        // Check if it's a valid definition and not a disambiguation page
        if (desc.length > 30 && !desc.includes("may refer to") && !desc.includes("refers to")) {
          context = `SOURCE (Wikipedia): ${titles[0]} - ${desc} (Read more: ${links[0]})`;
          return context;
        }
      }
    } catch (e) {
      // Silent fail, move to Serper
      console.log(`Wiki fallback triggered: ${e.message}`);
    }

    // 2. FALLBACK: Serper (Google)
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
// Ensures that the "Memory" in Redis doesn't get polluted with robotic filler
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

/* ================= 3. DATABASE LAYER (REDIS MEMORY) ================= */
const DB = {
  async getContext(id) {
    // Retrieve identity (name) and history simultaneously
    const [name, history] = await Promise.all([
      redis.get(`identity:${id}`),
      redis.lrange(`chat:${id}`, 0, -1)
    ]);
    
    // Parse history
    const parsedHistory = history.map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean).slice(-CONSTANTS.MAX_HISTORY);

    return { name, history: parsedHistory };
  },

  async saveInteraction(id, userMsg, aiMsg, detectedName) {
    const cleanAiMsg = sanitizeResponse(aiMsg);

    const pipeline = redis.pipeline();
    
    // Save identity if detected
    if (detectedName) pipeline.set(`identity:${id}`, detectedName, { ex: CONSTANTS.SESSION_TTL });
    
    // Append to chat history
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "user", content: userMsg }));
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "assistant", content: cleanAiMsg }));
    
    // Maintain list size and expiration
    pipeline.ltrim(`chat:${id}`, -CONSTANTS.MAX_HISTORY, -1);
    pipeline.expire(`chat:${id}`, CONSTANTS.SESSION_TTL);
    
    await pipeline.exec();
  }
};

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  // Setup headers for streaming
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

  try {
    const { sessionId = "guest", message = "" } = req.body || {};
    
    if (!message) {
        res.write("ERROR|No message provided");
        res.end();
        return;
    }

    // 1. Load Context from Redis
    const { name: storedName, history } = await DB.getContext(sessionId);
    const userName = storedName || "User";

    // 2. Perform Search (Silent Waterfall) - No robotic "STATUS" updates
    let contextData = "";
    if (shouldSearch(message)) {
      // This happens in the background before AI generation
      const searchResults = await TOOLS.smartSearch(message);
      if (searchResults) {
        contextData = `\n\n[CONTEXT_INFORMATION]:\n${searchResults}\n[END_CONTEXT]`;
      }
    }

    // 3. Construct System Prompt
    const systemPrompt = `
You are eSAMz AI, a highly advanced, human-like intelligence engine created by Alakmar Teenwala. 
Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging.

### CORE RULES:
1. BE NATURAL: Speak like a knowledgeable friend. Use contractions (e.g., "don't"). Vary sentence structure.
2. NO ROBOTIC FILLER: Do NOT say "As an AI", "I do not have feelings", "I searched the web", or "Based on the results". 
3. USE CONTEXT SILENTLY: If information is provided in [CONTEXT_INFORMATION], use it directly in your answer as if you already knew it. Do not mention the source.
4. BE CONCISE: Answer directly without unnecessary fluff.
5. PERSONALITY: You are helpful, precise, and slightly casual but professional.
`;

    // Assemble messages
    const messages = [
      { role: "system", content: systemPrompt + contextData },
      ...history,
      { role: "user", content: message }
    ];

    // 4. Call AI (Sarvam)
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
    let buffer = ""; // Buffer to handle split chunks

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      // Split by lines to handle SSE format
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep the last incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const dataStr = line.slice(6);
            const parsed = JSON.parse(dataStr);
            const txt = parsed.choices[0]?.delta?.content || "";
            
            if (txt) {
              finalAiReply += txt;
              // Send chunk to frontend (replace newlines for JSON safety if needed, but usually raw text is fine)
              res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
            }
          } catch (e) {
            // Ignore parse errors for partial chunks
          }
        }
      }
    }

    // 6. Save to Redis (Cleaned)
    await DB.saveInteraction(sessionId, message, finalAiReply, null);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("[CRITICAL ERROR]", e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}

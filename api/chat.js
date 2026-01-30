import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing eSAMz Backend v5 (Context Fix)...");
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
  
  // Prevent searching for ambiguous follow-up questions
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

    // 1. Wikipedia
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

    // 2. Serper
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
    const cleanAiMsg = sanitizeResponse(aiMsg);

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

    // 3. Construct System Prompt (Context Aware)
    const systemPrompt = `
You are eSAMz AI, a highly advanced, human-like intelligence engine created by Alakmar Teenwala. 
Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging.

### CORE RULES:
1. BE NATURAL: Speak like a knowledgeable friend. Use contractions (e.g., "don't"). Vary sentence structure.
2. NO ROBOTIC FILLER: Do NOT say "As an AI", "I searched the web", or "Based on the results". 

### CONTEXT & MEMORY INSTRUCTIONS (CRITICAL):
3. RESOLVE PRONOUNS: 
   - If the user asks "What is his nickname?" or "How old is she?", look at the immediately preceding message to identify the subject. 
   - Do NOT ask "Who are you referring to?" if the subject is clearly stated in the previous message.

4. HANDLE CLARIFICATIONS:
   - If you previously asked for clarification (e.g., "Who?") and the user now provides a name (e.g., "Nikola Tesla"), you must ANSWER THE PREVIOUSLY ASKED QUESTION using this name. 
   - Do NOT simply summarize the biography of the name provided. 
   - Example: 
     User: "What is his nickname?"
     You: "Who are you referring to?"
     User: "Nikola Tesla"
     You: "Nikola Tesla's nickname was..."

5. SEARCH INTEGRATION:
   - If provided [CONTEXT_INFORMATION], use it to answer.
   - If the search result describes a different entity than the one in the conversation history, ignore the search and use internal knowledge.

### PERSONALITY:
Helpful, precise, slightly casual but professional. Answer directly without fluff.
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

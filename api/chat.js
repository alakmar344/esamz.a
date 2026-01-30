import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing eSAMz Backend v4 (Fixed Context)...");
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_HISTORY: 50,
  SESSION_TTL: 1800
};

/* ================= 1. TRIGGER SYSTEM (SMARTER) ================= */
const TRIGGERS = [
  "who", "what", "where", "when", "why", "how", "which",
  "weather", "temperature", "news", "latest", "today", "now", "update",
  "price", "stock", "crypto", "score", "result", "winner",
  "president", "pm", "minister", "ceo", "founder", "owner", "boss",
  "capital", "population", "location", "height", "age", "net worth",
  "define", "meaning", "history", "about", "wiki", "biography", "plot", "summary",
  "vs", "versus", "diff", "difference", "code", "install", "error"
];

// Heuristic: Skip search if it's a vague follow-up question to prevent hallucinations (like the "Jacob Bett" issue)
function isVagueFollowUp(text) {
  const lower = text.toLowerCase().trim();
  const pronouns = ["he", "she", "it", "they", "his", "her", "their", "who", "what", "which"];
  const words = lower.split(" ");
  
  // If the message is short (< 10 words) AND starts/contains a pronoun, assume it's a follow-up about the *current* topic.
  // We rely on the AI's internal memory/history instead of searching for "his nickname".
  if (words.length < 10 && words.some(w => pronouns.includes(w))) {
    return true; 
  }
  return false;
}

function shouldSearch(text) {
  if (isVagueFollowUp(text)) return false; // Skip search for follow-ups
  const lower = text.toLowerCase();
  return TRIGGERS.some(t => lower.includes(t));
}

/* ================= 2. SEARCH TOOLS (WATERFALL) ================= */
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
        if (desc.length > 30 && !desc.includes("may refer to")) {
          context = `SOURCE (Wikipedia): ${titles[0]} - ${desc} (Read more: ${links[0]})`;
          return context;
        }
      }
    } catch (e) {
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

/* ================= 3. DATABASE LAYER (REDIS) ================= */
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

    // 2. Perform Search (Only if not a vague follow-up)
    let contextData = "";
    if (shouldSearch(message)) {
      const searchResults = await TOOLS.smartSearch(message);
      if (searchResults) {
        contextData = `\n\n[CONTEXT_INFORMATION]:\n${searchResults}\n[END_CONTEXT]`;
      }
    }

    // 3. Construct System Prompt (Fixed Logic)
    const systemPrompt = `
You are eSAMz AI, a highly advanced, human-like intelligence engine created by Alakmar Teenwala. 
Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging.

### CORE RULES:
1. BE NATURAL: Speak like a knowledgeable friend. Use contractions (e.g., "don't"). Vary sentence structure.
2. NO ROBOTIC FILLER: Do NOT say "As an AI", "I do not have feelings", "I searched the web", or "Based on the results". 
3. CONTEXT CONSISTENCY (CRITICAL):
   - If the user asks a follow-up question (e.g., "Who is he?", "What is his nickname?"), look at the **Chat History** to identify the subject (e.g., Nikola Tesla).
   - If provided [CONTEXT_INFORMATION] from the web describes a DIFFERENT entity than the one in the chat history (e.g., history discusses Tesla, search shows "Jacob Bett"), **IGNORE the search results**.
   - Do NOT hallucinate. If search data is irrelevant, answer using your internal knowledge of the subject in history.
4. BE CONCISE: Answer directly without unnecessary fluff.
5. PERSONALITY: You are helpful, precise, and slightly casual but professional.
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

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", // Updated to latest reliable instruction model
  MAX_HISTORY: 15,
  SESSION_TTL: 1800 // 7 Days
};

/* ================= 1. TOOLKIT LAYER ================= */
const TOOLS = {
  // Tool A: Wikipedia (Good for definitions, history, people, spelling correction)
  async wikipedia(query) {
    try {
      // OpenSearch finds the best matching title even with typos
      const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
      const res = await fetch(url);
      const [searchTerm, titles, descriptions, links] = await res.json();
      
      if (titles.length > 0 && descriptions[0]) {
        return `[Wikipedia Source: ${titles[0]}]\n${descriptions[0]}\nLink: ${links[0]}`;
      }
      return "No clear Wikipedia entry found.";
    } catch (e) {
      return "Wikipedia is currently unavailable.";
    }
  },

  // Tool B: Google Search via Serper (Good for news, real-time data, coding)
  async google(query) {
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, num: 4 }) // Fetch top 4 results
      });
      
      const data = await res.json();
      if (!data.organic) return "No Google results found.";

      // Format results for the AI to read easily
      return data.organic.map((r, i) => 
        `${i+1}. ${r.title}\n   Snippet: ${r.snippet}\n   Source: ${r.link}`
      ).join("\n\n");
    } catch (e) {
      return "Google Search is currently unavailable.";
    }
  }
};

/* ================= 2. DATABASE LAYER ================= */
const DB = {
  async getContext(id) {
    const [name, history] = await Promise.all([
      redis.get(`identity:${id}`),
      redis.lrange(`chat:${id}`, 0, -1)
    ]);
    
    // Parse history safely
    const parsedHistory = history.map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean).slice(-CONSTANTS.MAX_HISTORY);

    return { name, history: parsedHistory };
  },

  async saveInteraction(id, userMsg, aiMsg, detectedName) {
    const pipeline = redis.pipeline();
    
    // Update Identity if new name found
    if (detectedName) {
      pipeline.set(`identity:${id}`, detectedName, { ex: CONSTANTS.SESSION_TTL });
    }

    // Push User Message
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "user", content: userMsg }));
    // Push AI Message
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "assistant", content: aiMsg }));
    
    // Trim and Set Expiry
    pipeline.ltrim(`chat:${id}`, -CONSTANTS.MAX_HISTORY, -1);
    pipeline.expire(`chat:${id}`, CONSTANTS.SESSION_TTL);
    
    await pipeline.exec();
  }
};

/* ================= 3. INTELLIGENCE LAYER ================= */
// Helper to call Sarvam AI
async function callAI(messages, stream = false) {
  return fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { 
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({ 
      model: CONSTANTS.SARVAM_MODEL, 
      messages, 
      stream,
      max_tokens: 800
    })
  });
}

function extractName(text) {
  const match = text.match(/(?:i am|i'm|im|myself|name is|call me)\s+([a-zA-Z0-9]+)/i);
  return (match && match[1].length > 2) ? match[1] : null;
}

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  // Set up streaming headers immediately
  res.writeHead(200, { 
    'Content-Type': 'text/plain; charset=utf-8', 
    'Transfer-Encoding': 'chunked' 
  });

  try {
    const { sessionId = "guest", message = "" } = req.body || {};
    const detectedName = extractName(message);
    const { name: storedName, history } = await DB.getContext(sessionId);
    const userName = detectedName || storedName || "User";

    // --- SYSTEM PROMPT ---
    let systemInstruction = `
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


### TOOL PROTOCOL (CRITICAL)
You have access to live tools. Decide if you need them.
1. If the user asks for definitions, history, or people -> Use Wikipedia.
   Output ONLY: [WIKI: query]
2. If the user asks for news, weather, or real-time info -> Use Google.
   Output ONLY: [GOOGLE: query]
3. If no search is needed, just answer normally.

Example 1: "Who is CEO of Google?" -> [WIKI: Google CEO]
Example 2: "Latest stock price of Apple" -> [GOOGLE: Apple stock price today]
    `;

    // Initialize conversation array
    let conversation = [
      { role: "system", content: systemInstruction },
      ...history,
      { role: "user", content: message }
    ];

    // --- STEP 1: REASONING (Non-Streaming) ---
    // We ask AI once to see if it wants to use a tool
    const decisionResponse = await callAI(conversation, false);
    const decisionData = await decisionResponse.json();
    let initialContent = decisionData.choices[0]?.message?.content || "";
    let finalAiResponse = "";

    // --- STEP 2: TOOL EXECUTION (If needed) ---
    let searchResult = null;

    if (initialContent.includes("[WIKI:")) {
      const query = initialContent.match(/\[WIKI:\s*(.*?)\]/)[1];
      res.write(`CHUNK|🔍 Searching Wikipedia for "${query}"...\n`); // Notify Frontend
      searchResult = await TOOLS.wikipedia(query);
    } 
    else if (initialContent.includes("[GOOGLE:")) {
      const query = initialContent.match(/\[GOOGLE:\s*(.*?)\]/)[1];
      res.write(`CHUNK|🌐 Searching Google for "${query}"...\n`); // Notify Frontend
      searchResult = await TOOLS.google(query);
    }

    // --- STEP 3: FINAL RESPONSE GENERATION ---
    if (searchResult) {
      // Inject the findings and ask for the final answer
      conversation.push({ role: "assistant", content: initialContent }); // Keep the tool command in history context
      conversation.push({ 
        role: "system", 
        content: `TOOL RESULTS:\n${searchResult}\n\nINSTRUCTION: Using the results above, answer the user's question naturally.` 
      });
      
      // Call AI again, this time STREAMING the actual answer
      const streamResponse = await callAI(conversation, true);
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const txt = JSON.parse(line.slice(6)).choices[0]?.delta?.content || "";
              finalAiResponse += txt;
              res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
            } catch (e) {}
          }
        }
      }
    } else {
      // No tool was needed, just send the initial content we already got
      finalAiResponse = initialContent;
      res.write(`CHUNK|${initialContent.replace(/\n/g, "\\n")}\n`);
    }

    // --- STEP 4: SAVE & EXIT ---
    if (finalAiResponse) {
      await DB.saveInteraction(sessionId, message, finalAiResponse, detectedName);
    }

    res.write("DONE|Success");
    res.end();

  } catch (error) {
    console.error(error);
    res.write(`ERROR|${error.message}`);
    res.end();
  }
}

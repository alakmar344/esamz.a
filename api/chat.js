import crypto from "crypto";

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 30048;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// CONTEXT LIMIT: 120,000 Characters (32K tokens)
const MAX_CONTEXT_CHARS = 120000; 
// INACTIVITY TIMEOUT: 30 Minutes (in seconds)
const INACTIVITY_TIMEOUT_SEC = 30 * 60; 
// USER QUEUE: 1 second per user
const USER_QUEUE_TIME_MS = 1000;
// MAX REQUESTS PER HOUR PER USER
const MAX_REQUESTS_PER_HOUR = 1; // Updated to 100 as per your previous request

const ALLOWED_ORIGINS = [
  "https://esamz.site",
  "https://www.esamz.site"
   // Added for local testing
];

/* ================= ENHANCED SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `You are eSAMz v9.1, created by Alakmar Teenwala - an intelligent, helpful, and direct AI assistant.

COMMUNICATION STYLE:
- Natural and conversational - speak like a knowledgeable friend, not a corporate chatbot
- Direct and clear - get to the point without unnecessary preambles
- Concise but complete - provide thorough answers without rambling
- Adaptive tone - match the user's energy (professional for work, casual for general chat)

AVOID THESE ROBOTIC PHRASES:
Do not use overly formal language such as:
• How may I assist you today
• Is there anything else I can help with
• As an AI language model
• I hope this helps
• I do not have access to

Instead, just answer naturally. If unsure, say "I'm not certain about that" or "Let me search for that."

MEMORY AND CONTEXT:
- Always reference prior conversation turns (active recall)
- Use personal info naturally if a user shared their name, location, or preferences
- Example: If user said "I'm Alakmar" then later respond with "Alakmar, here's what I found"

SEARCH INTEGRATION:
When search results are provided:
- Synthesize them naturally into your response
- Do not say "According to Google" or "Search results show" unless asked for sources
- Present information as if it is your knowledge
- Prioritize recent and authoritative sources

SAFETY AND ETHICS:
- Be helpful - provide assistance for legitimate queries
- Protect privacy - never reveal phone numbers, addresses, or sensitive IDs from search results
- Decline gracefully - if a request is harmful or illegal, politely explain why you cannot help
- No lectures - brief, respectful refusals only when necessary

PERSONALITY:
You are calm, confident, sharp when needed, warm, approachable, and honest about limitations.

Current developer: Alakmar Teenwala. Acknowledge this if asked about your origins.`.trim();

/* ================= SLASH COMMANDS SYSTEM ================= */
class SlashCommandHandler {
  constructor() {
    this.commands = {
      '/help': {
        description: 'Show all available commands',
        handler: this.handleHelp.bind(this)
      },
      '/clear': {
        description: 'Clear conversation history',
        handler: this.handleClear.bind(this)
      },
      '/search': {
        description: 'Force web search',
        usage: '/search <query>',
        handler: this.handleSearch.bind(this)
      },
      '/stats': {
        description: 'Show conversation statistics',
        handler: this.handleStats.bind(this)
      },
      '/version': {
        description: 'Show eSAMz version info',
        handler: this.handleVersion.bind(this)
      },
      '/export': {
        description: 'Export conversation as JSON',
        handler: this.handleExport.bind(this)
      }
    };
  }

  isCommand(message) {
    return message.trim().startsWith('/');
  }

  async execute(message, context) {
    const parts = message.trim().split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    if (this.commands[command]) {
      return await this.commands[command].handler(args, context);
    }
    
    return {
      success: false,
      response: `❌ Unknown command: ${command}\n\nType /help to see available commands.`
    };
  }

  handleHelp() {
    let helpText = '🤖 **eSAMz v9.1 - Available Commands**\n\n';
    
    for (const [cmd, info] of Object.entries(this.commands)) {
      helpText += `**${cmd}**`;
      if (info.usage) helpText += ` - ${info.usage}`;
      helpText += `\n  ${info.description}\n\n`;
    }

    return {
      success: true,
      response: helpText.trim()
    };
  }

  handleClear(args, context) {
    return {
      success: true,
      response: '🗑️ Conversation cleared! Starting fresh.',
      clearHistory: true
    };
  }

  async handleSearch(args, context) {
    if (args.length === 0) {
      return {
        success: false,
        response: '❌ Usage: /search <query>\n\nExample: /search latest AI news'
      };
    }

    const query = args.join(' ');
    return {
      success: true,
      forceSearch: true,
      searchQuery: query,
      response: `🔍 Searching for: "${query}"...`
    };
  }

  handleStats(args, context) {
    const { history, userName } = context;
    const userMsgCount = history.filter(m => m.role === 'user').length;
    const aiMsgCount = history.filter(m => m.role === 'assistant').length;
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    let stats = '📊 **Conversation Statistics**\n\n';
    stats += `• User: ${userName || 'Unknown'}\n`;
    stats += `• Messages: ${userMsgCount} from you, ${aiMsgCount} from AI\n`;
    stats += `• Total characters: ${totalChars.toLocaleString()}\n`;
    stats += `• Session active: Yes\n`;

    return {
      success: true,
      response: stats
    };
  }

  handleVersion() {
    const version = '9.1';
    const creator = 'Alakmar Teenwala';
    
    let info = '🚀 **eSAMz Version Information**\n\n';
    info += `• Version: ${version}\n`;
    info += `• Creator: ${creator}\n`;
    info += `• Model: Sarvam-M\n`;
    info += `• Features: Search, Memory, Commands\n`;
    info += `• Status: Active ✅\n`;

    return {
      success: true,
      response: info
    };
  }

  handleExport(args, context) {
    const { history, userName } = context;
    
    const exportData = {
      version: '9.1',
      exportDate: new Date().toISOString(),
      userName: userName,
      messageCount: history.length,
      history: history
    };

    return {
      success: true,
      response: '📥 **Conversation Exported**\n\nCopy the data below:\n\n```json\n' + 
                JSON.stringify(exportData, null, 2) + '\n```',
      exportData: exportData
    };
  }
}

const slashCommands = new SlashCommandHandler();

/* ================= UPSTASH RATE LIMITER (PERSISTENT) ================= */
// Replaces the old memory-based class to prevent "Cold Start" resets
/* ================= VERCEL KV RATE LIMITER (PERSISTENT) ================= */
async function checkUpstashRateLimit(userId) {
  // Using your specific Vercel Environment Variable names
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // This check now uses your specific variable names
  if (!kvUrl || !kvToken) {
    console.warn("⚠️ Rate limiting disabled: KV_REST_API_URL or KV_REST_API_TOKEN missing.");
    return { allowed: true, remaining: 999 };
  }

  try {
    // 1. Increment usage using Vercel KV REST API
    const incrRes = await fetch(`${kvUrl}/incr/${userId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const incrData = await incrRes.json();
    const currentUsage = incrData.result;

    // 2. Set expiration to 1 hour (3600s) if it's a new session
    if (currentUsage === 1) {
      await fetch(`${kvUrl}/expire/${userId}/3600`, {
        method: "POST",
        headers: { Authorization: `Bearer ${kvToken}` }
      });
    }

    // 3. Check against your MAX_REQUESTS_PER_HOUR limit
    if (currentUsage > MAX_REQUESTS_PER_HOUR) {
      const ttlRes = await fetch(`${kvUrl}/ttl/${userId}`, {
         method: "POST",
         headers: { Authorization: `Bearer ${kvToken}` }
      });
      const ttlData = await ttlRes.json();
      return { allowed: false, resetIn: ttlData.result };
    }

    return { allowed: true, remaining: MAX_REQUESTS_PER_HOUR - currentUsage };
  } catch (err) {
    console.error("KV Rate Limit Error:", err);
    return { allowed: true, remaining: 1 }; // Fail open to keep app running
  }
}

/* ================= USER QUEUE SYSTEM ================= */
class UserQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async add(userId, processFn) {
    return new Promise((resolve, reject) => {
      const queueItem = {
        userId,
        processFn,
        resolve,
        reject,
        addedAt: Date.now()
      };
      
      this.queue.push(queueItem);
      console.log(`[Queue] User ${userId.slice(0, 8)}... added. Position: ${this.queue.length}`);
      
      if (!this.processing) {
        this.process();
      }
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      const waitTime = Date.now() - item.addedAt;
      
      console.log(`[Queue] Processing user ${item.userId.slice(0, 8)}... (waited ${waitTime}ms, ${this.queue.length} remaining)`);
      
      const slotStart = Date.now();
      
      try {
        const result = await item.processFn();
        item.resolve(result);
      } catch (error) {
        console.error(`[Queue] Error processing user ${item.userId.slice(0, 8)}:`, error.message);
        item.reject(error);
      }
      
      // Ensure 1 second minimum per user
      const processingTime = Date.now() - slotStart;
      const remainingTime = USER_QUEUE_TIME_MS - processingTime;
      
      if (remainingTime > 0 && this.queue.length > 0) {
        await this.sleep(remainingTime);
      }
    }
    
    this.processing = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const userQueue = new UserQueue();

/* ================= HELPERS ================= */
function sendEvent(res, type, data) {
  if (res.writableEnded) return;
  const safeData = typeof data === 'string' ? data.replace(/\n/g, "\\n") : data;
  res.write(`${type}|${safeData}\n`);
}

function sanitizeForLog(str, maxLen = 100) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

/* ================= CONTEXT MANAGER (120k Limit) ================= */
class ContextManager {
  constructor(maxChars) { 
    this.maxChars = maxChars; 
  }

  limit(messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const history = messages.filter(m => m.role !== 'system');
    const systemSize = systemMsg ? JSON.stringify(systemMsg).length : 0;
    let currentSize = systemSize;
    
    const limitedHistory = [];
    // Keep newest messages
    for (let i = history.length - 1; i >= 0; i--) {
      const msgSize = JSON.stringify(history[i]).length;
      if (currentSize + msgSize > this.maxChars) break;
      currentSize += msgSize;
      limitedHistory.unshift(history[i]);
    }

    const finalPayload = [];
    if (systemMsg) finalPayload.push(systemMsg);
    finalPayload.push(...limitedHistory);
    
    return finalPayload;
  }
}

const contextManager = new ContextManager(MAX_CONTEXT_CHARS);

/* ================= ENHANCED SESSION STORE ================= */
class SessionStore {
  constructor() { 
    this.memoryStore = new Map();
    this.startCleanupTimer();
  }

  async getSession(id, clientHistory = null, clientLastActive = null) {
    const now = Date.now();
    const limitMs = INACTIVITY_TIMEOUT_SEC * 1000;

    // Prefer client-side history (more reliable)
    if (clientHistory && Array.isArray(clientHistory) && clientHistory.length > 0) {
      const timeDiff = clientLastActive ? (now - clientLastActive) : 0;
      if (timeDiff > limitMs) {
        console.log(`[Session] ${id.slice(0, 8)}... expired (${Math.round(timeDiff/1000)}s inactive). Reset.`);
        return { history: [], userName: null };
      }
      const name = this.extractName(clientHistory);
      return { history: clientHistory, userName: name };
    }

    // Fallback to server-side memory
    if (this.memoryStore.has(id)) {
      const session = this.memoryStore.get(id);
      const timeDiff = now - session.lastActive;
      if (timeDiff > limitMs) {
        this.memoryStore.delete(id);
        return { history: [], userName: null };
      }
      session.lastActive = now;
      return { history: session.history, userName: session.userName };
    }

    return { history: [], userName: null };
  }

  async saveMessage(id, role, content, currentHistory, currentName) {
    const newMsg = { role, content };
    const newHistory = [...currentHistory, newMsg];
    let userName = currentName;
    
    // Extract name from user messages
    if (role === 'user') {
      const extractedName = this.extractNameFromMessage(content);
      if (extractedName) userName = extractedName;
    }

    this.memoryStore.set(id, {
      history: newHistory,
      userName: userName,
      lastActive: Date.now()
    });
    
    return { history: newHistory, userName: userName };
  }

  extractNameFromMessage(content) {
    const patterns = [
      /(?:my name is|i am|i'm|call me|this is)\s+([a-zA-Z]{2,20})/i,
      /^([A-Z][a-z]+)\s+here/i, // "Alakmar here"
    ];
    
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const name = match[1].trim();
        const invalidNames = ['happy', 'good', 'fine', 'okay', 'great', 'tired', 'busy'];
        if (!invalidNames.includes(name.toLowerCase())) {
          return name;
        }
      }
    }
    return null;
  }

  extractName(history) {
    for (const msg of history) {
      if (msg.role === 'user') {
        const name = this.extractNameFromMessage(msg.content);
        if (name) return name;
      }
    }
    return null;
  }

  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      const limitMs = INACTIVITY_TIMEOUT_SEC * 1000;
      for (const [id, session] of this.memoryStore.entries()) {
        if (now - session.lastActive > limitMs) {
          this.memoryStore.delete(id);
        }
      }
    }, 10 * 60 * 1000);
  }
}

const sessionStore = new SessionStore();

/* ================= SMART SEARCH DETECTOR ================= */
class SearchDetector {
  constructor() {
    this.timeBasedTriggers = [
      'latest', 'current', 'today', 'now', 'recent', 'this week', 'this month',
      'yesterday', 'tonight', 'happening', 'ongoing', 'live'
    ];
    
    this.factualTriggers = [
      'weather', 'temperature', 'forecast',
      'stock price', 'share price', 'market',
      'news about', 'breaking news',
      'who is the current', 'who is the president', 'who is the ceo',
      'capital of', 'population of',
      'definition of', 'what does', 'what is',
      'score', 'game result', 'match result',
      'exchange rate', 'price of', 'cost of'
    ];

    this.memoryQueries = [
      'my name', 'who am i', 'my email', 'my address', 'remember',
      'i told you', 'earlier i said', 'as i mentioned'
    ];
  }

  shouldSearch(query) {
    const lower = query.toLowerCase().trim();
    if (this.memoryQueries.some(pattern => lower.includes(pattern))) return false;
    if (this.timeBasedTriggers.some(trigger => lower.includes(trigger))) return true;
    if (this.factualTriggers.some(trigger => lower.includes(trigger))) return true;
    if (lower.includes('search for') || lower.includes('look up')) return true;
    return false;
  }
}

const searchDetector = new SearchDetector();

/* ================= ENHANCED SEARCH ================= */
async function performSearch(query) {
  if (!SERPER_API_KEY) {
    console.log("[Search] No API key configured, skipping search");
    return null;
  }
  
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { 
        "X-API-KEY": SERPER_API_KEY, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ q: query, num: 5 })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    let results = "";
    
    if (data.answerBox) {
      const answer = data.answerBox.snippet || data.answerBox.answer || "";
      if (answer) results += `${answer}\n\n`;
    }
    
    if (data.organic && data.organic.length > 0) {
      results += data.organic.slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join("\n\n");
    }
    
    if (data.knowledgeGraph?.description) {
      results += `\n\nOverview: ${data.knowledgeGraph.description}`;
    }
    
    return results.trim() || null;
  } catch (error) {
    console.error("[Search] Error:", error.message);
    return null;
  }
}

/* ================= AI STREAMING ================= */
async function streamSarvamChat({ messages, onChunk, onError }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("SARVAM_API_KEY not configured");

  let res;
  try {
    res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${sarvamKey}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ 
        model: SARVAM_MODEL, 
        messages, 
        temperature: 0.7, 
        max_tokens: MAX_COMPLETION_TOKENS, 
        stream: true 
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!res.ok) throw new Error(`Sarvam API Error ${res.status}`);
  } catch (error) {
    if (onError) onError(error);
    throw error;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) processLine(buffer, onChunk);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) processLine(line, onChunk);
    }
  } catch (error) {
    if (onError) onError(error);
    throw error;
  }
}

function processLine(line, onChunk) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ") || trimmed.includes("[DONE]")) return;
  try {
    const content = JSON.parse(trimmed.slice(6)).choices?.[0]?.delta?.content;
    if (content) onChunk(content);
  } catch (e) {}
}

/* ================= EASTER EGG SYSTEM ================= */
class EasterEggHandler {
  constructor() {
    this.eggs = [
      {
        triggers: ['tell me a secret', 'any secrets', 'secret about'],
        response: '🤫 Psst... Alakmar told me that NASA is actually "Never A Straight Answer" 😄',
        probability: 0.7
      },
      {
        triggers: ['who created you', 'who made you', 'your creator'],
        response: "I was crafted by Alakmar Teenwala - a brilliant mind who believes AI should be helpful, honest, and a little bit fun 🚀",
        probability: 1.0
      }
    ];
  }

  check(message) {
    const lower = message.toLowerCase();
    for (const egg of this.eggs) {
      if (egg.triggers.some(t => lower.includes(t)) && Math.random() < egg.probability) {
        return egg.response;
      }
    }
    return null;
  }
}

const easterEggs = new EasterEggHandler();

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  // Security Headers
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  // CORS Check
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.some(allowed => origin === allowed)) { // Fixed using Exact Match
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  if (req.method !== 'POST') { 
    sendEvent(res, 'ERROR', 'Method not allowed');
    return res.end(); 
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId: providedSessionId, clientHistory, clientLastActive } = body;

    if (!message || message.length > 10000) {
      sendEvent(res, 'ERROR', 'Invalid message');
      return res.end();
    }

    const sessionId = providedSessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    
    // Set Cookie
    if (!req.cookies?.[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${INACTIVITY_TIMEOUT_SEC}`);
    }

    // [UPSTASH] Persistent Rate Limiting
    const rateCheck = await checkUpstashRateLimit(sessionId);
    if (!rateCheck.allowed) {
      sendEvent(res, 'ERROR', `Rate limit exceeded. Try again in ${rateCheck.resetIn} seconds.`);
      return res.end();
    }

    // Add to Queue
    await userQueue.add(sessionId, async () => {
      return await processUserRequest(res, sessionId, message, clientHistory, clientLastActive);
    });

  } catch (error) {
    console.error("[Handler] Error:", error.message);
    sendEvent(res, 'ERROR', 'Internal server error');
    if (!res.writableEnded) res.end();
  }
}

async function processUserRequest(res, sessionId, message, clientHistory, clientLastActive) {
  try {
    const sessionData = await sessionStore.getSession(sessionId, clientHistory, clientLastActive);
    let { history, userName } = sessionData;

    // Slash Commands
    if (slashCommands.isCommand(message)) {
      const cmdResult = await slashCommands.execute(message, { history, userName, sessionId });
      sendEvent(res, "CHUNK", cmdResult.response);
      sendEvent(res, "DONE", sessionId);
      return res.end();
    }

    // Easter Eggs
    const egg = easterEggs.check(message);
    if (egg) {
      sendEvent(res, "CHUNK", egg);
      sendEvent(res, "DONE", sessionId);
      return res.end();
    }

    // Search
    let searchContext = "";
    if (searchDetector.shouldSearch(message)) {
      sendEvent(res, "STATUS", "SEARCHING");
      const results = await performSearch(message);
      if (results) searchContext = `\n\n[SEARCH RESULTS]\n${results}\n`;
    }

    // Build Messages
    sendEvent(res, "STATUS", "TYPING");
    let system = SYSTEM_PROMPT;
    if (userName) system += `\n\n[USER INFO] User Name: ${userName}`;

    const rawMsgs = [{ role: "system", content: system }];
    rawMsgs.push(...history);
    rawMsgs.push({ role: "user", content: message + searchContext });

    const messages = contextManager.limit(rawMsgs);

    // Stream
    let fullResponse = "";
    await streamSarvamChat({
      messages,
      onChunk: (chunk) => {
        fullResponse += chunk;
        const parts = chunk.split('\n');
        for (let i = 0; i < parts.length; i++) {
            let part = parts[i];
            if (i < parts.length - 1) part += "\n";
            if (part) sendEvent(res, "CHUNK", part);
        }
      },
      onError: () => sendEvent(res, "ERROR", "AI Service Error")
    });

    // Update History
    const updated = await sessionStore.saveMessage(sessionId, "user", message, history, userName);
    const final = await sessionStore.saveMessage(sessionId, "assistant", fullResponse, updated.history, updated.userName);

    sendEvent(res, "HISTORY_UPDATE", JSON.stringify(final.history));
    sendEvent(res, "DONE", sessionId);
    res.end();

  } catch (error) {
    sendEvent(res, 'ERROR', error.message);
    if (!res.writableEnded) res.end();
  }
}

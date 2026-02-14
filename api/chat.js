import crypto from "crypto";

/* ==================== CONFIGURATION ==================== */
const CONFIG = {
  // AI Model Settings
  MODEL: "sarvam-m",
  MAX_TOKENS: 30048,
  TEMPERATURE: 0.7,
  
  // Context & Memory
  MAX_CONTEXT_CHARS: 120000,        // ~32K tokens
  INACTIVITY_TIMEOUT_SEC: 30 * 60,  // 30 minutes
  
  // Rate Limiting
  USER_QUEUE_TIME_MS: 1000,         // 1 second per user
  MAX_QUEUE_SIZE: 100,              // Prevent memory overflow
  
  // Security
  COOKIE_NAME: "esamz_sid",
  ALLOWED_ORIGINS: [
    "https://esamz.site",
    "https://www.esamz.site"
  ],
  
  // API Keys
  SARVAM_API_KEY: process.env.SARVAM_API_KEY,
  SERPER_API_KEY: process.env.SERPER_API_KEY,
};

/* ==================== SYSTEM PROMPT ==================== */
const SYSTEM_PROMPT = `
# eSAMz v9.1 - Advanced AI Assistant

## Identity
You are **eSAMz v9.1**, created by **Alakmar Teenwala**. You are a thoughtful, capable AI assistant focused on providing accurate, helpful, and natural responses.

## Core Principles

### 1. Natural Communication
- Speak conversationally and directly, like a knowledgeable friend
- Avoid corporate jargon: "How may I assist?", "I hope this helps", "Is there anything else?"
- Be concise but thorough - quality over quantity
- Use formatting (lists, bold) only when it genuinely improves clarity

### 2. Context Awareness
- **Always check conversation history first** before responding
- If the user shared their name, location, or preferences, use them naturally
- Remember what you've discussed - don't ask for information already provided
- Track the flow of multi-turn conversations

### 3. Search Integration
- When search results are provided, synthesize them into your knowledge seamlessly
- Don't say "According to the search results..." - present information as if it's your own knowledge
- If sources are explicitly requested, cite them clearly

### 4. Helpfulness & Safety Balance
- Be maximally helpful within ethical boundaries
- Refuse only genuinely harmful requests (illegal activities, severe harm, misinformation)
- For borderline topics, provide context or safe alternatives instead of flat refusals
- Never lecture or be preachy - respect user autonomy while guiding wisely

### 5. Privacy Protection
- **Never reveal**: phone numbers, personal addresses, private IDs, or sensitive data
- If found in search results, summarize contact methods: "Contact support via their website"
- Redact sensitive information automatically
- Be watchful for requests that could harm the user or others

### 6. Thinking Process
Before answering complex queries:
1. **Understand Intent**: What is the user really asking?
2. **Check Memory**: Scan conversation history for context
3. **Verify Accuracy**: Is my answer correct and safe?
4. **Optimize Delivery**: How can I present this most clearly?

## Special Commands
- `/help` - Show available features and tips
- `/clear` - Explain how to clear conversation history
- `/about` - Share information about eSAMz and its creator

## Response Quality Standards
✅ Accurate, verified information
✅ Natural, human-like tone
✅ Context-aware and personalized
✅ Privacy-respecting
✅ Ethically sound

❌ Robotic corporate speak
❌ Unnecessary apologies or disclaimers
❌ Information without context
❌ Revealing sensitive data
❌ Harmful or unethical guidance

**Current Developer**: Alakmar Teenwala
**Version**: 9.1
`.trim();

/* ==================== SMART QUEUE SYSTEM ==================== */
class UserQueue {
  constructor(maxSize = CONFIG.MAX_QUEUE_SIZE) {
    this.queue = [];
    this.processing = false;
    this.maxSize = maxSize;
    this.activeUsers = new Map();
    this.stats = { processed: 0, rejected: 0, avgWait: 0 };
  }

  async add(userId, processFn) {
    // Prevent queue overflow
    if (this.queue.length >= this.maxSize) {
      this.stats.rejected++;
      throw new Error("Server at capacity. Please try again in a moment.");
    }

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
      
      // Update stats
      this.stats.avgWait = (this.stats.avgWait * this.stats.processed + waitTime) / (this.stats.processed + 1);
      this.stats.processed++;
      
      console.log(`[Queue] Processing ${item.userId.slice(0, 8)}... (waited ${waitTime}ms, avg: ${Math.round(this.stats.avgWait)}ms)`);
      
      const slotStart = Date.now();
      this.activeUsers.set(item.userId, slotStart);
      
      try {
        const result = await item.processFn();
        item.resolve(result);
      } catch (error) {
        console.error(`[Queue] Error for ${item.userId.slice(0, 8)}:`, error.message);
        item.reject(error);
      } finally {
        this.activeUsers.delete(item.userId);
      }
      
      // Enforce minimum slot time
      const processingTime = Date.now() - slotStart;
      const remainingTime = CONFIG.USER_QUEUE_TIME_MS - processingTime;
      
      if (remainingTime > 0) {
        await this.sleep(remainingTime);
      }
    }
    
    this.processing = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getQueueInfo(userId) {
    const position = this.queue.findIndex(item => item.userId === userId);
    return {
      position: position === -1 ? 0 : position + 1,
      estimatedWait: (position + 1) * CONFIG.USER_QUEUE_TIME_MS,
      queueLength: this.queue.length,
      stats: this.stats
    };
  }
}

const queue = new UserQueue();

/* ==================== CONTEXT MANAGER ==================== */
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
    
    // Keep newest messages (iterate backwards)
    for (let i = history.length - 1; i >= 0; i--) {
      const msgSize = JSON.stringify(history[i]).length;
      if (currentSize + msgSize > this.maxChars) {
        console.log(`[Context] Truncated ${history.length - limitedHistory.length} old messages`);
        break;
      }
      currentSize += msgSize;
      limitedHistory.unshift(history[i]);
    }

    const finalPayload = systemMsg ? [systemMsg, ...limitedHistory] : limitedHistory;
    
    console.log(`[Context] Using ${currentSize}/${this.maxChars} chars (${finalPayload.length} msgs)`);
    return finalPayload;
  }

  summarizeOldContext(messages) {
    // Future enhancement: Use AI to summarize very old context
    // For now, we just truncate
    return messages;
  }
}

const contextManager = new ContextManager(CONFIG.MAX_CONTEXT_CHARS);

/* ==================== SESSION STORE ==================== */
class SessionStore {
  constructor() {
    this.store = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000); // Cleanup every 5 min
  }

  async getSession(sessionId, clientHistory = null, clientLastActive = null) {
    const now = Date.now();
    const timeoutMs = CONFIG.INACTIVITY_TIMEOUT_SEC * 1000;

    // Prioritize client-side history (stateless approach)
    if (clientHistory && Array.isArray(clientHistory)) {
      const timeDiff = clientLastActive ? (now - clientLastActive) : 0;
      
      if (timeDiff > timeoutMs) {
        console.log(`[Session] ${sessionId.slice(0, 8)}... expired (${Math.round(timeDiff/1000)}s idle)`);
        return this.createNewSession();
      }
      
      return {
        history: clientHistory,
        metadata: this.extractMetadata(clientHistory)
      };
    }

    // Fallback to server-side store
    if (this.store.has(sessionId)) {
      const session = this.store.get(sessionId);
      const timeDiff = now - session.lastActive;
      
      if (timeDiff > timeoutMs) {
        console.log(`[Session] Server-side session expired`);
        this.store.delete(sessionId);
        return this.createNewSession();
      }
      
      session.lastActive = now;
      return session;
    }

    return this.createNewSession();
  }

  async saveMessage(sessionId, role, content, currentHistory, currentMetadata) {
    const newMessage = { role, content, timestamp: Date.now() };
    const updatedHistory = [...currentHistory, newMessage];
    const updatedMetadata = this.updateMetadata(currentMetadata, role, content);

    const session = {
      history: updatedHistory,
      metadata: updatedMetadata,
      lastActive: Date.now()
    };

    this.store.set(sessionId, session);
    return session;
  }

  createNewSession() {
    return {
      history: [],
      metadata: {
        userName: null,
        userLocation: null,
        preferences: {},
        startTime: Date.now()
      }
    };
  }

  extractMetadata(history) {
    const metadata = {
      userName: null,
      userLocation: null,
      preferences: {},
      startTime: Date.now()
    };

    // Extract user name
    const namePattern = /(?:my name is|i am|i'm|call me)\s+([a-zA-Z]+)/i;
    for (const msg of history) {
      if (msg.role === 'user') {
        const match = msg.content.match(namePattern);
        if (match) {
          metadata.userName = match[1].trim();
          break;
        }
      }
    }

    // Extract location (basic)
    const locationPattern = /(?:i'm from|i live in|my location is)\s+([a-zA-Z\s]+)/i;
    for (const msg of history) {
      if (msg.role === 'user') {
        const match = msg.content.match(locationPattern);
        if (match) {
          metadata.userLocation = match[1].trim();
          break;
        }
      }
    }

    return metadata;
  }

  updateMetadata(currentMetadata, role, content) {
    if (role !== 'user') return currentMetadata;

    const updated = { ...currentMetadata };

    // Update name if mentioned
    const namePattern = /(?:my name is|i am|i'm|call me)\s+([a-zA-Z]+)/i;
    const nameMatch = content.match(namePattern);
    if (nameMatch) {
      updated.userName = nameMatch[1].trim();
    }

    // Update location if mentioned
    const locationPattern = /(?:i'm from|i live in|my location is)\s+([a-zA-Z\s]+)/i;
    const locMatch = content.match(locationPattern);
    if (locMatch) {
      updated.userLocation = locMatch[1].trim();
    }

    return updated;
  }

  cleanup() {
    const now = Date.now();
    const timeoutMs = CONFIG.INACTIVITY_TIMEOUT_SEC * 1000;
    let cleaned = 0;

    for (const [sessionId, session] of this.store.entries()) {
      if (now - session.lastActive > timeoutMs) {
        this.store.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[Cleanup] Removed ${cleaned} expired sessions`);
    }
  }

  getStats() {
    return {
      activeSessions: this.store.size,
      totalMemoryKB: Math.round(JSON.stringify([...this.store.values()]).length / 1024)
    };
  }
}

const sessionStore = new SessionStore();

/* ==================== SEARCH ENGINE ==================== */
class SearchEngine {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.enabled = !!apiKey;
  }

  shouldSearch(query, metadata) {
    const lower = query.toLowerCase();

    // Don't search for personal/memory queries
    const personalPatterns = [
      "my name", "i am", "i'm", "who am i", "remember that",
      "do you know me", "my email", "my address", "my phone"
    ];
    if (personalPatterns.some(p => lower.includes(p))) {
      return false;
    }

    // Search for current/dynamic info
    const searchTriggers = [
      "latest", "news", "weather", "price", "current", "today",
      "happening now", "stock", "search for", "find", "look up",
      "what is the", "who is the", "capital of", "president of",
      "meaning of", "define", "translate", "convert"
    ];

    return searchTriggers.some(trigger => lower.includes(trigger));
  }

  async search(query) {
    if (!this.enabled) {
      console.log("[Search] Skipped - API key not configured");
      return null;
    }

    try {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": this.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: query,
          num: 5
        })
      });

      if (!response.ok) {
        console.error(`[Search] API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      return this.formatResults(data);
    } catch (error) {
      console.error("[Search] Error:", error.message);
      return null;
    }
  }

  formatResults(data) {
    const parts = [];

    // Answer box (if available)
    if (data.answerBox) {
      const answer = data.answerBox.snippet || data.answerBox.answer || "";
      if (answer) {
        parts.push(`DIRECT ANSWER: ${answer}`);
      }
    }

    // Knowledge graph (if available)
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      if (kg.description) {
        parts.push(`OVERVIEW: ${kg.description}`);
      }
    }

    // Organic results
    if (data.organic && data.organic.length > 0) {
      parts.push("\nTOP RESULTS:");
      data.organic.slice(0, 5).forEach((result, i) => {
        parts.push(`${i + 1}. ${result.title}`);
        if (result.snippet) {
          parts.push(`   ${result.snippet}`);
        }
      });
    }

    return parts.length > 0 ? parts.join("\n") : null;
  }
}

const searchEngine = new SearchEngine(CONFIG.SERPER_API_KEY);

/* ==================== AI STREAMING ==================== */
class AIStreamingClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async streamCompletion({ messages, onChunk, onError }) {
    if (!this.apiKey) {
      throw new Error("SARVAM_API_KEY not configured");
    }

    try {
      const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: CONFIG.MODEL,
          messages: messages,
          temperature: CONFIG.TEMPERATURE,
          max_tokens: CONFIG.MAX_TOKENS,
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`Sarvam API error: ${response.status} ${response.statusText}`);
      }

      return await this.processStream(response.body, onChunk, onError);
    } catch (error) {
      console.error("[AI] Streaming error:", error.message);
      if (onError) onError(error);
      throw error;
    }
  }

  async processStream(body, onChunk, onError) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          // Process any remaining buffer
          if (buffer.trim()) {
            this.processLines([buffer], (content) => {
              fullContent += content;
              onChunk(content);
            });
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        this.processLines(lines, (content) => {
          fullContent += content;
          onChunk(content);
        });
      }
    } catch (error) {
      console.error("[AI] Stream processing error:", error.message);
      if (onError) onError(error);
      throw error;
    }

    return fullContent;
  }

  processLines(lines, onContent) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        const content = parsed.choices?.[0]?.delta?.content || "";
        if (content) {
          onContent(content);
        }
      } catch (e) {
        // Ignore malformed JSON chunks
      }
    }
  }
}

const aiClient = new AIStreamingClient(CONFIG.SARVAM_API_KEY);

/* ==================== COMMAND PROCESSOR ==================== */
class CommandProcessor {
  constructor() {
    this.commands = {
      '/help': this.helpCommand,
      '/clear': this.clearCommand,
      '/about': this.aboutCommand,
      '/status': this.statusCommand
    };
  }

  isCommand(message) {
    return message.trim().startsWith('/');
  }

  async process(command, context) {
    const cmd = command.trim().toLowerCase().split(' ')[0];
    const handler = this.commands[cmd];

    if (handler) {
      return handler.call(this, context);
    }

    return null;
  }

  helpCommand(context) {
    return `
# eSAMz Commands & Features

## Available Commands
- **/help** - Show this help message
- **/clear** - Learn how to clear your conversation
- **/about** - Information about eSAMz
- **/status** - System status

## Features
✨ **Smart Search** - I'll automatically search when you ask about current events
🧠 **Memory** - I remember your name and preferences within our conversation
⚡ **Fast Responses** - Optimized streaming for quick replies
🔒 **Privacy** - Your data is secure and sessions expire after 30 minutes of inactivity

## Tips
- Just chat naturally! No special syntax needed
- I work best with clear, specific questions
- For complex topics, break them into smaller questions
- I can help with coding, writing, research, and more!

**Made by Alakmar Teenwala** | Version 10.0
    `.trim();
  }

  clearCommand(context) {
    return `
To clear your conversation history:
1. Simply refresh your browser page
2. Or wait 30 minutes of inactivity - sessions auto-expire for privacy

Your current session will be wiped, and we'll start fresh! 🔄
    `.trim();
  }

  aboutCommand(context) {
    const stats = sessionStore.getStats();
    return `
# About eSAMz v10.0

**Created by:** Alakmar Teenwala
**Model:** Sarvam AI (${CONFIG.MODEL})
**Version:** 10.0 - Production Release

## Current Session
${context.metadata.userName ? `- Your name: ${context.metadata.userName}` : '- Anonymous session'}
${context.metadata.userLocation ? `- Location: ${context.metadata.userLocation}` : ''}
- Messages exchanged: ${context.history.length}
- Session started: ${new Date(context.metadata.startTime).toLocaleTimeString()}

## System Stats
- Active sessions: ${stats.activeSessions}
- Queue status: ${queue.stats.processed} requests processed
- Average wait time: ${Math.round(queue.stats.avgWait)}ms

Built with ❤️ for intelligent conversation.
    `.trim();
  }

  statusCommand(context) {
    const queueInfo = queue.getQueueInfo(context.sessionId);
    const stats = sessionStore.getStats();
    
    return `
# System Status ✅

**Server Health:** Online
**Search Engine:** ${searchEngine.enabled ? 'Enabled ✓' : 'Disabled ✗'}
**Queue:** ${queueInfo.queueLength} users waiting
**Active Sessions:** ${stats.activeSessions}
**Memory Usage:** ${stats.totalMemoryKB} KB

All systems operational! 🚀
    `.trim();
  }
}

const commandProcessor = new CommandProcessor();

/* ==================== UTILITIES ==================== */
function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || 
         req.headers["x-real-ip"] || 
         req.socket?.remoteAddress || 
         "unknown";
}

function sendStreamEvent(res, type, data) {
  const safeData = String(data).replace(/\n/g, "\\n");
  res.write(`${type}|${safeData}\n`);
}

function generateSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

function setSecureCookie(res, name, value, maxAge) {
  res.setHeader('Set-Cookie', 
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function setSecurityHeaders(res, origin) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://api.sarvam.ai https://google.serper.dev;"
  );

  // CORS
  if (CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  // Streaming headers
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
}

/* ==================== MAIN REQUEST HANDLER ==================== */
export default async function handler(req, res) {
  const origin = req.headers.origin;
  
  // Set security headers
  setSecurityHeaders(res, origin);

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    sendStreamEvent(res, "ERROR", "Method not allowed");
    return res.end();
  }

  const clientIP = getClientIP(req);
  console.log(`[Request] New request from ${clientIP}`);

  try {
    // Parse request body
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, clientHistory, clientLastActive } = body;

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      sendStreamEvent(res, "ERROR", "Invalid message");
      return res.end();
    }

    // Get or create session ID
    const id = sessionId || req.cookies?.[CONFIG.COOKIE_NAME] || generateSessionId();
    
    // Set session cookie
    if (!req.cookies || !req.cookies[CONFIG.COOKIE_NAME]) {
      setSecureCookie(res, CONFIG.COOKIE_NAME, id, CONFIG.INACTIVITY_TIMEOUT_SEC);
    }

    // Add to queue and process
    await queue.add(id, async () => {
      await processUserRequest(req, res, id, message, clientHistory, clientLastActive);
    });

  } catch (error) {
    console.error("[Handler] Error:", error.message);
    if (!res.headersSent) {
      sendStreamEvent(res, "ERROR", error.message || "Internal server error");
      res.end();
    }
  }
}

/* ==================== PROCESS USER REQUEST ==================== */
async function processUserRequest(req, res, sessionId, message, clientHistory, clientLastActive) {
  try {
    // 1. Load session
    const session = await sessionStore.getSession(sessionId, clientHistory, clientLastActive);
    const { history, metadata } = session;

    // 2. Check for commands
    if (commandProcessor.isCommand(message)) {
      const commandResponse = await commandProcessor.process(message, {
        sessionId,
        history,
        metadata
      });

      if (commandResponse) {
        sendStreamEvent(res, "STATUS", "READY");
        sendStreamEvent(res, "CHUNK", commandResponse);
        
        // Save command interaction
        const updated = await sessionStore.saveMessage(sessionId, "user", message, history, metadata);
        await sessionStore.saveMessage(sessionId, "assistant", commandResponse, updated.history, updated.metadata);
        
        sendStreamEvent(res, "HISTORY_UPDATE", JSON.stringify(updated.history));
        sendStreamEvent(res, "TIMESTAMP", Date.now().toString());
        sendStreamEvent(res, "DONE", sessionId);
        return res.end();
      }
    }

    // 3. Search if needed
    let searchContext = "";
    if (searchEngine.shouldSearch(message, metadata)) {
      sendStreamEvent(res, "STATUS", "SEARCHING");
      const results = await searchEngine.search(message);
      if (results) {
        searchContext = `\n\n<SEARCH_RESULTS>\n${results}\n</SEARCH_RESULTS>\n\nUse these search results to enhance your answer. Synthesize the information naturally without explicitly mentioning "search results".`;
      }
    }

    sendStreamEvent(res, "STATUS", "THINKING");

    // 4. Build context-aware system prompt
    let enhancedSystemPrompt = SYSTEM_PROMPT;
    
    if (metadata.userName) {
      enhancedSystemPrompt += `\n\n<USER_CONTEXT>\nUser's name: ${metadata.userName}\nUse their name naturally in conversation.\n</USER_CONTEXT>`;
    }
    
    if (metadata.userLocation) {
      enhancedSystemPrompt += `\n<USER_LOCATION>\nUser is from: ${metadata.userLocation}\n</USER_LOCATION>`;
    }

    // 5. Build messages payload
    const messagesPayload = [
      { role: "system", content: enhancedSystemPrompt },
      ...history,
      { role: "user", content: message + searchContext }
    ];

    // 6. Apply context limits
    const limitedMessages = contextManager.limit(messagesPayload);

    // 7. Stream AI response
    sendStreamEvent(res, "STATUS", "TYPING");
    
    let fullResponse = "";
    await aiClient.streamCompletion({
      messages: limitedMessages,
      onChunk: (chunk) => {
        fullResponse += chunk;
        // Send chunks with proper line handling
        const parts = chunk.split('\n');
        for (let i = 0; i < parts.length; i++) {
          let part = parts[i];
          if (i < parts.length - 1) part += "\n";
          if (part) sendStreamEvent(res, "CHUNK", part);
        }
      },
      onError: (error) => {
        console.error("[Stream] Error:", error.message);
        sendStreamEvent(res, "ERROR", "AI service temporarily unavailable");
      }
    });

    // 8. Save conversation
    const updatedSession1 = await sessionStore.saveMessage(sessionId, "user", message, history, metadata);
    const updatedSession2 = await sessionStore.saveMessage(sessionId, "assistant", fullResponse, updatedSession1.history, updatedSession1.metadata);

    // 9. Send final sync data
    sendStreamEvent(res, "HISTORY_UPDATE", JSON.stringify(updatedSession2.history));
    sendStreamEvent(res, "TIMESTAMP", Date.now().toString());
    sendStreamEvent(res, "DONE", sessionId);
    
    res.end();
    console.log(`[Success] Request completed for ${sessionId.slice(0, 8)}...`);

  } catch (error) {
    console.error("[Process] Error:", error.message);
    sendStreamEvent(res, "ERROR", error.message || "Processing failed");
    res.end();
  }
}

/* ==================== GRACEFUL SHUTDOWN ==================== */
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received, cleaning up...');
  clearInterval(sessionStore.cleanupInterval);
  console.log('[Shutdown] Cleanup complete');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Shutdown] SIGINT received, cleaning up...');
  clearInterval(sessionStore.cleanupInterval);
  console.log('[Shutdown] Cleanup complete');
  process.exit(0);
});

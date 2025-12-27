/* ============================================
   eSAMz v8.2 Backend - Production Grade
   Created by Alakmar Teenwala
   Updated: December 2025 - Active Models Only
   ============================================ */

console.log('>>> eSAMz v8.2 - Neural Engine Initialized (Dec 2025)');

/* ---------- CONFIGURATION ---------- */
const CONFIG = {
  THREAD_TTL: 10 * 60 * 1000,
  MODEL_TIMEOUT: 45_000,
  MAX_PROMPT_TOKENS: 6000,
  MAX_HISTORY_TOKENS: 3000,
  MAX_COMPLETION_TOKENS: 2048,
  DOCUMENT_TRIGGER_TOKENS: 900,
  RATE_LIMIT_COOLDOWN: 20_000,
  GLOBAL_RATE_LIMIT_WINDOW: 60_000,
  MAX_REQUESTS_PER_WINDOW: 50,
  CLEANUP_INTERVAL: 5 * 60 * 1000,
  MAX_THREAD_COUNT: 1000,
  WEB_SEARCH_TIMEOUT: 10_000,
  MAX_SEARCH_RESULTS: 5,
  RETRY_DELAY: 2000
};

/* ---------- STATE STORES ---------- */
const threads = new Map();
const timers = new Map();
const modelUsage = new Map();
const rateLimitCooldowns = new Map();
const globalRateLimit = new Map();
const requestMetrics = {
  total: 0,
  success: 0,
  failed: 0,
  modelFailures: new Map(),
  avgLatency: 0,
  lastReset: Date.now()
};

/* ---------- MODELS (11 ACTIVE AS OF DECEMBER 2025) ---------- */
// Based on Groq deprecation notices:
// - deepseek-r1-distill-llama-70b: Deprecated Sept 2025 → replaced by llama-3.3-70b-versatile
// - gemma2-9b-it: Deprecated Aug 2025 → replaced by llama-3.1-8b-instant
// - mixtral-8x7b-32768: Deprecated March 2025 → replaced by newer models
// All models verified active December 2025

const MODELS = [
  'llama-3.3-70b-versatile',                              // Production - 280 t/s ✅
  'llama-3.1-8b-instant',                                 // Production - 560 t/s ✅
  'openai/gpt-oss-120b',                                  // Production - 500 t/s ✅
  'openai/gpt-oss-20b',                                   // Production - 1000 t/s ✅
  'moonshotai/kimi-k2-instruct-0905',                     // Preview - 256K context ✅
  'meta-llama/llama-4-scout-17b-16e-instruct',            // Preview - 750 t/s ✅
  'meta-llama/llama-4-maverick-17b-128e-instruct',        // Preview - 600 t/s ✅
  'qwen/qwen3-32b',                                       // Preview - 400 t/s ✅
  'groq/compound',                                        // System - Agentic AI ✅
  'groq/compound-mini',                                   // System - Faster Agentic ✅
  'meta-llama/llama-guard-4-12b'                          // Production - Safety ✅
];

// Code-optimized models (best for programming tasks)
const CODE_MODELS = [
  'openai/gpt-oss-120b',                                  // Best for complex code
  'moonshotai/kimi-k2-instruct-0905',                     // Large context for code review
  'llama-3.3-70b-versatile',                              // Versatile coding
  'meta-llama/llama-4-maverick-17b-128e-instruct',        // Good for algorithms
  'qwen/qwen3-32b'                                        // Structured tasks
];

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are eSAMz v8.2 created by Alakmar Teenwala.
Knowledge cutoff: December 2025

Core traits:
- Calm, precise, and human-like
- Strategic thinking, elegant brevity
- Never verbose or exposing internal reasoning
- Never mention limitations or apologize unnecessarily
- Elevate the conversation with insight

Respond naturally and helpfully.`
};

/* ---------- UTILITY: TOKEN ESTIMATION ---------- */
function estimateTokens(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).length;
  const chars = text.length;
  return Math.ceil(Math.max(words * 1.33, chars / 4));
}

function messagesTokens(messages) {
  return messages.reduce((sum, msg) => {
    return sum + estimateTokens(msg.content) + 8;
  }, 0);
}

/* ---------- UTILITY: HISTORY MANAGEMENT ---------- */
function trimHistory(history) {
  while (history.length > 0 && messagesTokens(history) > CONFIG.MAX_HISTORY_TOKENS) {
    history.shift();
    if (history.length > 0) history.shift();
  }
}

/* ---------- UTILITY: CODE DETECTION ---------- */
function isCodeQuery(text) {
  const codePatterns = [
    /```[\s\S]*?```/,
    /\b(function|class|const|let|var|import|export|return|async|await)\s*[({]/,
    /<\/?[a-z][\s\S]*?>/i,
    /\b(def|print|if|else|for|while|return)\s+/,
    /[:,]\s*\{[\s\S]*?\}/,
    /=>\s*[({]/,
    /\b(debug|fix|code|program|script|algorithm|function|api)\b/i
  ];
  
  return codePatterns.some(pattern => pattern.test(text));
}

/* ---------- UTILITY: WEB SEARCH ---------- */
async function performWebSearch(query, requestId) {
  const youApiKey = process.env.YOU_API_KEY;
  
  if (!youApiKey) {
    console.warn(`[WEB_SEARCH] ${requestId} - YOU_API_KEY not configured`);
    return null;
  }
  
  console.log(`[WEB_SEARCH] ${requestId} - Query: "${query.slice(0, 50)}..."`);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.WEB_SEARCH_TIMEOUT);
  
  try {
    const url = new URL('https://api.ydc-index.io/search');
    url.searchParams.append('query', query);
    url.searchParams.append('num_web_results', CONFIG.MAX_SEARCH_RESULTS.toString());
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: { 'X-API-Key': youApiKey }
    });
    
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    
    const data = await response.json();
    const results = data.hits?.slice(0, CONFIG.MAX_SEARCH_RESULTS) || [];
    
    if (results.length === 0) return null;
    
    const formattedResults = results.map((hit, idx) => {
      return `[${idx + 1}] ${hit.title || 'Untitled'}
URL: ${hit.url || 'N/A'}
Snippet: ${hit.description || hit.snippets?.[0] || 'No description'}`;
    }).join('\n\n');
    
    console.log(`[WEB_SEARCH] ${requestId} - Found ${results.length} results`);
    
    return { query, resultCount: results.length, results: formattedResults };
    
  } catch (error) {
    console.error(`[WEB_SEARCH] ${requestId} - Error: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- UTILITY: DETECT SEARCH INTENT ---------- */
function needsWebSearch(text) {
  const searchIndicators = [
    /\b(search|find|look up|what is|who is|when did|where is)\b/i,
    /\b(latest|recent|current|today|news|update)\b/i,
    /\b(price|stock|weather|score)\b/i,
    /\?.*\b(in|about|on)\s+\d{4}\b/i,
    /\b(define|meaning of|explain)\b/i
  ];
  return searchIndicators.some(pattern => pattern.test(text));
}

/* ---------- UTILITY ---------- */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function checkGlobalRateLimit(clientId) {
  const now = Date.now();
  const key = clientId || 'anonymous';
  
  if (!globalRateLimit.has(key)) {
    globalRateLimit.set(key, { count: 0, windowStart: now });
  }
  
  const client = globalRateLimit.get(key);
  
  if (now - client.windowStart > CONFIG.GLOBAL_RATE_LIMIT_WINDOW) {
    client.count = 0;
    client.windowStart = now;
  }
  
  if (client.count >= CONFIG.MAX_REQUESTS_PER_WINDOW) return false;
  
  client.count++;
  return true;
}

/* ---------- UTILITY: MODEL ROTATION ---------- */
class ModelRotator {
  constructor(models) {
    this.models = models;
    this.index = 0;
    this.failures = new Map();
  }
  
  next() {
    const now = Date.now();
    const available = this.models.filter(m => {
      const cooldownUntil = rateLimitCooldowns.get(m);
      return !cooldownUntil || now >= cooldownUntil;
    });
    
    if (available.length === 0) {
      console.warn('[ROTATION] All models in cooldown, using any available');
      return this.models[this.index++ % this.models.length];
    }
    
    const model = available[this.index++ % available.length];
    return model;
  }
  
  recordFailure(model, error) {
    const count = this.failures.get(model) || 0;
    this.failures.set(model, count + 1);
    requestMetrics.modelFailures.set(model, (requestMetrics.modelFailures.get(model) || 0) + 1);
    console.error(`[MODEL_FAILURE] ${model}: ${error.message}`);
  }
}

/* ---------- CORE: MODEL API CALL WITH ENHANCED ERROR HANDLING ---------- */
async function callModel(model, messages, apiKey, requestId) {
  const startTime = Date.now();
  const now = Date.now();
  
  // Check cooldown
  if (rateLimitCooldowns.has(model)) {
    const cooldownUntil = rateLimitCooldowns.get(model);
    if (now < cooldownUntil) {
      const waitTime = Math.ceil((cooldownUntil - now) / 1000);
      throw new Error(`Model in cooldown for ${waitTime}s`);
    }
  }
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.MODEL_TIMEOUT);
  
  try {
    console.log(`[API_CALL] ${requestId} - Trying ${model}...`);
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: CONFIG.MAX_COMPLETION_TOKENS,
        stream: false
      })
    });
    
    const latency = Date.now() - startTime;
    
    // Handle non-OK responses
    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { error: { message: await response.text() } };
      }
      
      const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
      console.error(`[API_ERROR] ${requestId} - ${model} - ${response.status}: ${errorMsg}`);
      
      // Handle specific error codes
      if (response.status === 429 || response.status === 503) {
        const cooldownUntil = now + CONFIG.RATE_LIMIT_COOLDOWN;
        rateLimitCooldowns.set(model, cooldownUntil);
        console.warn(`[COOLDOWN] ${model} until ${new Date(cooldownUntil).toISOString()}`);
      }
      
      if (response.status === 404) {
        console.error(`[INVALID_MODEL] ${model} - Model not found or deprecated`);
      }
      
      if (response.status === 401) {
        console.error(`[AUTH_ERROR] Invalid or missing API key`);
      }
      
      throw new Error(`${response.status}: ${errorMsg}`);
    }
    
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    
    if (!reply) {
      throw new Error('Empty response from model');
    }
    
    modelUsage.set(model, (modelUsage.get(model) || 0) + 1);
    console.log(`[SUCCESS] ${requestId} - ${model} - ${latency}ms - ${reply.length} chars`);
    
    return { model, reply, latency };
    
  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error.name === 'AbortError') {
      console.error(`[TIMEOUT] ${requestId} - ${model} - ${latency}ms`);
      throw new Error(`Timeout after ${CONFIG.MODEL_TIMEOUT}ms`);
    }
    
    console.error(`[ERROR] ${requestId} - ${model} - ${latency}ms - ${error.message}`);
    throw error;
    
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- CORE: DOCUMENT SUMMARIZER ---------- */
async function summarizeDocument(text, apiKey, requestId) {
  console.log(`[DOC_SUMMARIZE] ${requestId} - Input: ${estimateTokens(text)} tokens`);
  
  const messages = [
    SYSTEM_PROMPT,
    {
      role: 'user',
      content: `Summarize this document concisely in under 400 tokens:\n\n${text}`
    }
  ];
  
  const summaryModels = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'];
  
  for (const model of summaryModels) {
    try {
      const result = await callModel(model, messages, apiKey, requestId);
      return result.reply;
    } catch (error) {
      console.warn(`[DOC_SUMMARY_FAIL] ${model}: ${error.message}`);
      continue;
    }
  }
  
  throw new Error('Document summarization failed');
}

/* ---------- CLEANUP ---------- */
function cleanupStaleData() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [model, expiry] of rateLimitCooldowns.entries()) {
    if (now >= expiry) {
      rateLimitCooldowns.delete(model);
      cleaned++;
    }
  }
  
  for (const [client, data] of globalRateLimit.entries()) {
    if (now - data.windowStart > CONFIG.GLOBAL_RATE_LIMIT_WINDOW * 2) {
      globalRateLimit.delete(client);
      cleaned++;
    }
  }
  
  if (threads.size > CONFIG.MAX_THREAD_COUNT) {
    const sortedThreads = Array.from(threads.entries())
      .sort((a, b) => (timers.get(a[0]) || 0) - (timers.get(b[0]) || 0));
    
    const toRemove = sortedThreads.slice(0, threads.size - CONFIG.MAX_THREAD_COUNT);
    toRemove.forEach(([id]) => {
      threads.delete(id);
      clearTimeout(timers.get(id));
      timers.delete(id);
      cleaned++;
    });
  }
  
  if (cleaned > 0) {
    console.log(`[CLEANUP] Removed ${cleaned} entries. Threads: ${threads.size}`);
  }
}

setInterval(cleanupStaleData, CONFIG.CLEANUP_INTERVAL);

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  const requestId = generateRequestId();
  const startTime = Date.now();
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Validate API key
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[FATAL] GROQ_API_KEY not set');
    return res.status(500).json({ 
      error: 'Server misconfiguration - GROQ_API_KEY missing', 
      requestId 
    });
  }
  
  // Parse body
  let body;
  try {
    const raw = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    body = JSON.parse(raw);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON', requestId });
  }
  
  const { message, threadId = 'default', clientId, files = [], context = [], enableWebSearch = false } = body;
  
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Invalid message', requestId });
  }
  
  // Rate limiting
  if (!checkGlobalRateLimit(clientId || 'anonymous')) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      requestId,
      retryAfter: 60
    });
  }
  
  requestMetrics.total++;
  console.log(`[REQUEST] ${requestId} - "${message.slice(0, 50)}..." - Files: ${files.length}`);
  
  try {
    // Initialize thread
    if (!threads.has(threadId)) threads.set(threadId, []);
    const history = threads.get(threadId);
    
    // Handle files
    let enrichedMessage = message;
    if (files.length > 0) {
      const fileContext = files.map(f => 
        `\n\n**File: ${f.file?.name || 'unnamed'}**\n\`\`\`\n${f.textExtracted || ''}\n\`\`\``
      ).join('\n');
      enrichedMessage = message + fileContext;
    }
    
    // Web search
    if (enableWebSearch && needsWebSearch(message)) {
      const searchResults = await performWebSearch(message, requestId);
      if (searchResults) {
        enrichedMessage += `\n\n**Web Results:**\n${searchResults.results}`;
      }
    }
    
    const conversationHistory = context.length > 0 ? context : history;
    
    // Document mode for long inputs
    let userInput = enrichedMessage;
    let documentMode = false;
    if (estimateTokens(enrichedMessage) > CONFIG.DOCUMENT_TRIGGER_TOKENS) {
      documentMode = true;
      userInput = await summarizeDocument(enrichedMessage, apiKey, requestId);
    }
    
    // Build messages
    const messages = [SYSTEM_PROMPT, ...conversationHistory, { role: 'user', content: userInput }];
    
    // Trim if needed
    const totalTokens = messagesTokens(messages);
    if (totalTokens > CONFIG.MAX_PROMPT_TOKENS) {
      trimHistory(conversationHistory);
      messages.splice(1, messages.length - 2, ...conversationHistory);
    }
    
    // Route to appropriate models
    const isCode = isCodeQuery(enrichedMessage);
    const modelPool = isCode ? CODE_MODELS : MODELS;
    const rotator = new ModelRotator(modelPool);
    
    console.log(`[ROUTING] ${requestId} - ${isCode ? 'CODE' : 'GENERAL'} - ${modelPool.length} models`);
    
    // Try models with retry
    let result = null;
    let attemptCount = 0;
    const maxAttempts = Math.min(modelPool.length, 8);
    
    while (!result && attemptCount < maxAttempts) {
      attemptCount++;
      const model = rotator.next();
      
      try {
        result = await callModel(model, messages, apiKey, requestId);
      } catch (error) {
        rotator.recordFailure(model, error);
        
        if (attemptCount < maxAttempts) {
          console.log(`[RETRY] ${requestId} - Attempt ${attemptCount + 1}/${maxAttempts}`);
          await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
        } else {
          throw new Error(`All ${maxAttempts} attempts failed. Last error: ${error.message}`);
        }
      }
    }
    
    if (!result) throw new Error('No model responded');
    
    // Update history
    history.push({ role: 'user', content: userInput });
    history.push({ role: 'assistant', content: result.reply });
    trimHistory(history);
    
    // Reset thread TTL
    clearTimeout(timers.get(threadId));
    timers.set(threadId, setTimeout(() => {
      threads.delete(threadId);
      timers.delete(threadId);
    }, CONFIG.THREAD_TTL));
    
    // Metrics
    requestMetrics.success++;
    const totalLatency = Date.now() - startTime;
    requestMetrics.avgLatency = 
      (requestMetrics.avgLatency * (requestMetrics.success - 1) + totalLatency) / requestMetrics.success;
    
    // Response
    res.status(200).json({
      reply: result.reply,
      model: result.model,
      threadId,
      requestId,
      metadata: {
        documentMode,
        codeRouted: isCode,
        latency: totalLatency,
        modelLatency: result.latency,
        attempts: attemptCount
      },
      version: 'v8.2-dec2025'
    });
    
    console.log(`[COMPLETE] ${requestId} - ${totalLatency}ms - ${result.model}`);
    
  } catch (error) {
    requestMetrics.failed++;
    console.error(`[FAILED] ${requestId} - ${error.message}`);
    
    res.status(502).json({
      error: 'Failed to generate response',
      details: error.message,
      requestId,
      diagnostics: {
        totalModels: MODELS.length,
        modelsInCooldown: Array.from(rateLimitCooldowns.keys()),
        suggestion: 'Check GROQ_API_KEY validity and model permissions'
      },
      version: 'v8.2-dec2025'
    });
  }
};

/* ---------- HEALTH CHECK ---------- */
module.exports.health = function(req, res) {
  res.status(200).json({
    status: 'healthy',
    version: 'v8.2-dec2025',
    uptime: Math.floor(process.uptime()),
    activeModels: MODELS.length,
    deprecatedModelsRemoved: [
      'deepseek-r1-distill-llama-70b (Sept 2025)',
      'gemma2-9b-it (Aug 2025)',
      'mixtral-8x7b-32768 (March 2025)'
    ],
    metrics: {
      total: requestMetrics.total,
      success: requestMetrics.success,
      failed: requestMetrics.failed,
      successRate: requestMetrics.total > 0 
        ? ((requestMetrics.success / requestMetrics.total) * 100).toFixed(1) + '%'
        : 'N/A',
      avgLatency: Math.round(requestMetrics.avgLatency) + 'ms',
      threads: threads.size,
      modelUsage: Object.fromEntries(modelUsage),
      failures: Object.fromEntries(requestMetrics.modelFailures),
      cooldowns: Array.from(rateLimitCooldowns.entries()).map(([m, t]) => ({
        model: m,
        expiresIn: Math.max(0, t - Date.now()) + 'ms'
      }))
    }
  });
};

console.log(`[INIT] eSAMz v8.2 (Dec 2025) - ${MODELS.length} active models`);
console.log(`[INIT] Deprecated models removed: deepseek-r1, gemma2-9b-it, mixtral-8x7b`);
console.log(`[INIT] Code models: ${CODE_MODELS.length}`);

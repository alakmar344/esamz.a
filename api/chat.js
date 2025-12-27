/* ============================================
   eSAMz v8.2 Backend - Production Grade
   Created by Alakmar Teenwala
   Fixed with 11 Verified Working Models
   ============================================ */

console.log('>>> eSAMz v8.2 - Neural Engine Initialized');

/* ---------- CONFIGURATION ---------- */
const CONFIG = {
  THREAD_TTL: 10 * 60 * 1000,
  MODEL_TIMEOUT: 35_000,
  MAX_PROMPT_TOKENS: 6000,
  MAX_HISTORY_TOKENS: 3000,
  MAX_COMPLETION_TOKENS: 2048,
  DOCUMENT_TRIGGER_TOKENS: 900,
  RATE_LIMIT_COOLDOWN: 15_000,
  GLOBAL_RATE_LIMIT_WINDOW: 60_000,
  MAX_REQUESTS_PER_WINDOW: 50,
  CLEANUP_INTERVAL: 5 * 60 * 1000,
  MAX_THREAD_COUNT: 1000,
  WEB_SEARCH_TIMEOUT: 10_000,
  MAX_SEARCH_RESULTS: 5
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

/* ---------- MODELS (11 VERIFIED WORKING) ---------- */
// All models verified from official Groq documentation (Dec 2024)
const MODELS = [
  'llama-3.3-70b-versatile',           // Production - 280 t/s
  'llama-3.1-8b-instant',              // Production - 560 t/s
  'openai/gpt-oss-120b',               // Production - 500 t/s
  'openai/gpt-oss-20b',                // Production - 1000 t/s
  'deepseek-r1-distill-llama-70b',     // Preview - 250 t/s - Reasoning
  'moonshotai/kimi-k2-instruct-0905',  // Preview - 200 t/s - 256K context
  'meta-llama/llama-4-scout-17b-16e-instruct',    // Preview - 750 t/s
  'meta-llama/llama-4-maverick-17b-128e-instruct', // Preview - 600 t/s
  'qwen/qwen3-32b',                    // Preview - 400 t/s
  'mixtral-8x7b-32768',                // Production - Fast
  'gemma2-9b-it'                       // Production - Fast
];

// Code-optimized models (best for programming tasks)
const CODE_MODELS = [
  'openai/gpt-oss-120b',               // Best for complex code
  'deepseek-r1-distill-llama-70b',     // Excellent at reasoning + code
  'moonshotai/kimi-k2-instruct-0905',  // Large context for code review
  'llama-3.3-70b-versatile',           // Versatile coding
  'qwen/qwen3-32b'                     // Good at structured tasks
];

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are eSAMz v8.2 created by Alakmar Teenwala.
Knowledge cutoff: June 2025

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
    /\b(debug|fix|code|program|script|algorithm)\b/i
  ];
  
  return codePatterns.some(pattern => pattern.test(text));
}

/* ---------- UTILITY: WEB SEARCH (YOU.COM) ---------- */
async function performWebSearch(query, requestId) {
  const youApiKey = process.env.YOU_API_KEY;
  
  if (!youApiKey) {
    console.warn(`[WEB_SEARCH] ${requestId} - YOU_API_KEY not configured, skipping search`);
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
      headers: {
        'X-API-Key': youApiKey
      }
    });
    
    if (!response.ok) {
      throw new Error(`You.com API returned ${response.status}`);
    }
    
    const data = await response.json();
    const results = data.hits?.slice(0, CONFIG.MAX_SEARCH_RESULTS) || [];
    
    if (results.length === 0) {
      console.log(`[WEB_SEARCH] ${requestId} - No results found`);
      return null;
    }
    
    const formattedResults = results.map((hit, idx) => {
      return `[${idx + 1}] ${hit.title || 'Untitled'}
URL: ${hit.url || 'N/A'}
Snippet: ${hit.description || hit.snippets?.[0] || 'No description available'}`;
    }).join('\n\n');
    
    console.log(`[WEB_SEARCH] ${requestId} - Found ${results.length} results`);
    
    return {
      query,
      resultCount: results.length,
      results: formattedResults
    };
    
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`[WEB_SEARCH] ${requestId} - Timeout after ${CONFIG.WEB_SEARCH_TIMEOUT}ms`);
    } else {
      console.error(`[WEB_SEARCH] ${requestId} - Error: ${error.message}`);
    }
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

/* ---------- UTILITY: REQUEST ID ---------- */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/* ---------- UTILITY: RATE LIMITING ---------- */
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
  
  if (client.count >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  
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
    const available = this.models.filter(m => {
      const cooldownUntil = rateLimitCooldowns.get(m);
      return !cooldownUntil || Date.now() >= cooldownUntil;
    });
    
    if (available.length === 0) {
      return this.models[this.index++ % this.models.length];
    }
    
    const model = available[this.index++ % available.length];
    return model;
  }
  
  recordFailure(model, error) {
    const count = this.failures.get(model) || 0;
    this.failures.set(model, count + 1);
    
    requestMetrics.modelFailures.set(
      model, 
      (requestMetrics.modelFailures.get(model) || 0) + 1
    );
    
    console.error(`[MODEL_FAILURE] ${model}: ${error.message}`);
  }
}

/* ---------- CORE: MODEL API CALL ---------- */
async function callModel(model, messages, apiKey, requestId) {
  const startTime = Date.now();
  const now = Date.now();
  
  if (rateLimitCooldowns.has(model)) {
    const cooldownUntil = rateLimitCooldowns.get(model);
    if (now < cooldownUntil) {
      throw new Error(`Model ${model} in cooldown until ${new Date(cooldownUntil).toISOString()}`);
    }
  }
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.MODEL_TIMEOUT);
  
  try {
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
        max_tokens: CONFIG.MAX_COMPLETION_TOKENS
      })
    });
    
    const latency = Date.now() - startTime;
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      
      if (response.status === 429 || response.status === 413) {
        const cooldownUntil = now + CONFIG.RATE_LIMIT_COOLDOWN;
        rateLimitCooldowns.set(model, cooldownUntil);
        console.warn(`[RATE_LIMIT] ${model} cooldown until ${new Date(cooldownUntil).toISOString()}`);
      }
      
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 100)}`);
    }
    
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    
    if (!reply) {
      throw new Error('Empty response from model');
    }
    
    modelUsage.set(model, (modelUsage.get(model) || 0) + 1);
    
    console.log(`[SUCCESS] ${requestId} - ${model} - ${latency}ms`);
    
    return { model, reply, latency };
    
  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error.name === 'AbortError') {
      console.error(`[TIMEOUT] ${requestId} - ${model} - ${latency}ms`);
      throw new Error(`Model timeout after ${CONFIG.MODEL_TIMEOUT}ms`);
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
      content: `Summarize this document concisely in under 400 tokens. Preserve key structure and essential points.

DOCUMENT:
${text}`
    }
  ];
  
  const summaryModels = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'gemma2-9b-it'];
  
  for (const model of summaryModels) {
    try {
      const result = await callModel(model, messages, apiKey, requestId);
      console.log(`[DOC_SUMMARY_SUCCESS] ${requestId} - Output: ${estimateTokens(result.reply)} tokens`);
      return result.reply;
    } catch (error) {
      console.warn(`[DOC_SUMMARY_FAIL] ${model}: ${error.message}`);
      continue;
    }
  }
  
  throw new Error('Document summarization failed on all models');
}

/* ---------- CORE: MEMORY CLEANUP ---------- */
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
  
  console.log(`[CLEANUP] Removed ${cleaned} stale entries. Threads: ${threads.size}, Cooldowns: ${rateLimitCooldowns.size}`);
}

setInterval(cleanupStaleData, CONFIG.CLEANUP_INTERVAL);

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  const requestId = generateRequestId();
  const startTime = Date.now();
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[FATAL] GROQ_API_KEY environment variable not set');
    return res.status(500).json({ 
      error: 'Server misconfiguration. Contact administrator.',
      requestId 
    });
  }
  
  let body;
  try {
    const raw = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    body = JSON.parse(raw);
  } catch (error) {
    return res.status(400).json({ 
      error: 'Invalid JSON in request body',
      requestId 
    });
  }
  
  const { 
    message, 
    threadId = 'default', 
    clientId,
    files = [],
    context = [],
    enableWebSearch = false
  } = body;
  
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ 
      error: 'message field is required and must be a non-empty string',
      requestId 
    });
  }
  
  if (!checkGlobalRateLimit(clientId || req.headers['x-forwarded-for'] || 'anonymous')) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded. Please try again later.',
      requestId,
      retryAfter: Math.ceil(CONFIG.GLOBAL_RATE_LIMIT_WINDOW / 1000)
    });
  }
  
  requestMetrics.total++;
  
  console.log(`[REQUEST] ${requestId} - Thread: ${threadId} - Input: ${estimateTokens(message)} tokens - Files: ${files.length} - WebSearch: ${enableWebSearch}`);
  
  try {
    if (!threads.has(threadId)) {
      threads.set(threadId, []);
    }
    const history = threads.get(threadId);
    
    let enrichedMessage = message;
    if (files.length > 0) {
      console.log(`[FILES] ${requestId} - Processing ${files.length} file(s)`);
      const fileContext = files.map(f => {
        const fileName = f.file?.name || 'unnamed_file';
        const fileText = f.textExtracted || '';
        return `\n\n**Attached File: ${fileName}**\n\`\`\`\n${fileText}\n\`\`\``;
      }).join('\n');
      
      enrichedMessage = message + fileContext;
    }
    
    let searchResults = null;
    const shouldSearch = enableWebSearch && (needsWebSearch(message) || message.toLowerCase().includes('search'));
    
    if (shouldSearch) {
      console.log(`[WEB_SEARCH] ${requestId} - Initiating search`);
      searchResults = await performWebSearch(message, requestId);
      
      if (searchResults) {
        const searchContext = `\n\n**Web Search Results for: "${searchResults.query}"**
Found ${searchResults.resultCount} result(s):

${searchResults.results}

Use the above information to answer the user's question.`;
        
        enrichedMessage = enrichedMessage + searchContext;
      }
    }
    
    const conversationHistory = context.length > 0 ? context : history;
    
    let userInput = enrichedMessage;
    let documentMode = false;
    
    if (estimateTokens(enrichedMessage) > CONFIG.DOCUMENT_TRIGGER_TOKENS) {
      documentMode = true;
      console.log(`[DOC_MODE] ${requestId} - Summarizing long input`);
      userInput = await summarizeDocument(enrichedMessage, apiKey, requestId);
    }
    
    const messages = [
      SYSTEM_PROMPT,
      ...conversationHistory,
      { role: 'user', content: userInput }
    ];
    
    const totalTokens = messagesTokens(messages);
    if (totalTokens > CONFIG.MAX_PROMPT_TOKENS) {
      trimHistory(conversationHistory);
      messages.splice(1, messages.length - 2, ...conversationHistory);
    }
    
    const isCode = isCodeQuery(enrichedMessage);
    const modelPool = isCode ? CODE_MODELS : MODELS;
    const rotator = new ModelRotator(modelPool);
    
    console.log(`[ROUTING] ${requestId} - Mode: ${isCode ? 'CODE' : 'GENERAL'} - Pool: ${modelPool.length} models`);
    
    let result = null;
    let attemptCount = 0;
    const maxAttempts = Math.min(modelPool.length, 5);
    
    while (!result && attemptCount < maxAttempts) {
      attemptCount++;
      const model = rotator.next();
      
      try {
        result = await callModel(model, messages, apiKey, requestId);
      } catch (error) {
        rotator.recordFailure(model, error);
        
        if (attemptCount >= maxAttempts) {
          throw new Error(`All models failed after ${maxAttempts} attempts`);
        }
      }
    }
    
    if (!result) {
      throw new Error('No model could generate a response');
    }
    
    history.push({ role: 'user', content: userInput });
    history.push({ role: 'assistant', content: result.reply });
    trimHistory(history);
    
    clearTimeout(timers.get(threadId));
    timers.set(threadId, setTimeout(() => {
      threads.delete(threadId);
      timers.delete(threadId);
      console.log(`[THREAD_EXPIRED] ${threadId}`);
    }, CONFIG.THREAD_TTL));
    
    requestMetrics.success++;
    const totalLatency = Date.now() - startTime;
    requestMetrics.avgLatency = 
      (requestMetrics.avgLatency * (requestMetrics.success - 1) + totalLatency) / 
      requestMetrics.success;
    
    res.status(200).json({
      reply: result.reply,
      model: result.model,
      threadId,
      requestId,
      metadata: {
        documentMode,
        codeRouted: isCode,
        estimatedTokens: totalTokens,
        latency: totalLatency,
        modelLatency: result.latency,
        attempts: attemptCount,
        filesProcessed: files.length,
        webSearchEnabled: enableWebSearch,
        contextUsed: conversationHistory.length
      },
      version: 'v8.2'
    });
    
    console.log(`[COMPLETE] ${requestId} - Total: ${totalLatency}ms - Model: ${result.model}`);
    
  } catch (error) {
    requestMetrics.failed++;
    
    console.error(`[FAILED] ${requestId} - ${error.message}`);
    
    res.status(502).json({
      error: 'Failed to generate response',
      details: error.message,
      requestId,
      modelUsage: Object.fromEntries(modelUsage),
      version: 'v8.2'
    });
  }
};

/* ---------- HEALTH CHECK ENDPOINT ---------- */
module.exports.health = function healthCheck(req, res) {
  const uptime = process.uptime();
  const now = Date.now();
  
  res.status(200).json({
    status: 'healthy',
    version: 'v8.2',
    uptime: Math.floor(uptime),
    metrics: {
      totalRequests: requestMetrics.total,
      successRate: requestMetrics.total > 0 
        ? (requestMetrics.success / requestMetrics.total * 100).toFixed(2) + '%'
        : 'N/A',
      avgLatency: Math.round(requestMetrics.avgLatency) + 'ms',
      activeThreads: threads.size,
      modelUsage: Object.fromEntries(modelUsage),
      modelFailures: Object.fromEntries(requestMetrics.modelFailures),
      cooldowns: Array.from(rateLimitCooldowns.entries()).map(([model, until]) => ({
        model,
        expiresIn: Math.max(0, until - now) + 'ms'
      }))
    }
  });
};

console.log(`[INIT] eSAMz v8.2 ready with ${MODELS.length} verified models`);
console.log(`[INIT] General models: ${MODELS.length}`);
console.log(`[INIT] Code-optimized models: ${CODE_MODELS.length}`);
console.log(`[INIT] Rate limit: ${CONFIG.MAX_REQUESTS_PER_WINDOW} req/${CONFIG.GLOBAL_RATE_LIMIT_WINDOW/1000}s`);

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
  avgLatency: 0
};

/* ---------- MODELS (11 ACTIVE) ---------- */
const MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'moonshotai/kimi-k2-instruct-0905',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'groq/compound',
  'groq/compound-mini',
  'meta-llama/llama-guard-4-12b'
];

const CODE_MODELS = [
  'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct-0905',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b'
];

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are eSAMz v8.2 created by Alakmar Teenwala.
Knowledge cutoff: july 2025.
Be calm, precise, human-like, and insightful.`
};

/* ---------- HARD RULE: SANITIZE MESSAGES ---------- */
function sanitizeMessages(messages) {
  return messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : String(m.content ?? '')
  }));
}

/* ---------- TOKEN ESTIMATION ---------- */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(Math.max(text.length / 4, text.split(/\s+/).length * 1.33));
}

function messagesTokens(messages) {
  return messages.reduce((t, m) => t + estimateTokens(m.content) + 8, 0);
}

function trimHistory(history) {
  while (history.length && messagesTokens(history) > CONFIG.MAX_HISTORY_TOKENS) {
    history.shift();
    if (history.length) history.shift();
  }
}

/* ---------- CODE DETECTION ---------- */
function isCodeQuery(text) {
  return /\b(function|class|const|let|var|import|export|async|await|```|api|fix|debug)\b/i.test(text);
}

/* ---------- MODEL ROTATOR ---------- */
class ModelRotator {
  constructor(models) {
    this.models = models;
    this.index = 0;
  }

  next() {
    const now = Date.now();
    const available = this.models.filter(m => {
      const cd = rateLimitCooldowns.get(m);
      return !cd || now >= cd;
    });
    return (available.length ? available : this.models)[this.index++ % (available.length || this.models.length)];
  }

  recordFailure(model, err) {
    requestMetrics.modelFailures.set(model, (requestMetrics.modelFailures.get(model) || 0) + 1);
    console.error(`[MODEL_FAILURE] ${model}: ${err.message}`);
  }
}

/* ---------- MODEL CALL ---------- */
async function callModel(model, messages, apiKey, requestId) {
  const start = Date.now();
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
        messages: sanitizeMessages(messages),
        temperature: 0.6,
        max_tokens: CONFIG.MAX_COMPLETION_TOKENS
      })
    });

    if (!response.ok) {
      const err = await response.text();
      if ([429, 503].includes(response.status)) {
        rateLimitCooldowns.set(model, Date.now() + CONFIG.RATE_LIMIT_COOLDOWN);
      }
      throw new Error(`${response.status}: ${err}`);
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty model response');

    modelUsage.set(model, (modelUsage.get(model) || 0) + 1);
    return { model, reply, latency: Date.now() - start };

  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const start = Date.now();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID');

  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY missing', requestId });

  let body;
  try {
    body = JSON.parse(await new Promise(r => {
      let d = ''; req.on('data', c => d += c); req.on('end', () => r(d));
    }));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON', requestId });
  }

  const { message, threadId = 'default' } = body;
  if (!message?.trim()) return res.status(400).json({ error: 'Invalid message', requestId });

  requestMetrics.total++;

  try {
    if (!threads.has(threadId)) threads.set(threadId, []);
    const history = threads.get(threadId);

    const messages = [
      SYSTEM_PROMPT,
      ...history,
      { role: 'user', content: message }
    ];

    if (messagesTokens(messages) > CONFIG.MAX_PROMPT_TOKENS) {
      trimHistory(history);
    }

    const isCode = isCodeQuery(message);
    const pool = isCode ? CODE_MODELS : MODELS;
    const rotator = new ModelRotator(pool);

    let result;
    for (let i = 0; i < Math.min(pool.length, 8); i++) {
      try {
        result = await callModel(rotator.next(), messages, apiKey, requestId);
        break;
      } catch (e) {
        rotator.recordFailure(rotator.next(), e);
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
      }
    }

    if (!result) throw new Error('All models failed');

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: result.reply });
    trimHistory(history);

    clearTimeout(timers.get(threadId));
    timers.set(threadId, setTimeout(() => threads.delete(threadId), CONFIG.THREAD_TTL));

    requestMetrics.success++;

    res.status(200).json({
      reply: result.reply,
      model: result.model,
      latency: Date.now() - start,
      requestId,
      version: 'v8.2-dec2025'
    });

  } catch (err) {
    requestMetrics.failed++;
    res.status(502).json({
      error: 'Failed to generate response',
      details: err.message,
      requestId
    });
  }
};

/* ---------- HEALTH ---------- */
module.exports.health = (_, res) => {
  res.json({
    status: 'healthy',
    version: 'v8.2-dec2025',
    models: MODELS.length,
    successRate: requestMetrics.total
      ? ((requestMetrics.success / requestMetrics.total) * 100).toFixed(1) + '%'
      : 'N/A'
  });
};

console.log(`[INIT] eSAMz v8.2 ready with ${MODELS.length} models`);

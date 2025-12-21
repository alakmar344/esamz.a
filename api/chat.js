/* ---------- DEBUG BOOT ---------- */
console.log('>>> ESAMZ BACKEND v11 - YOU.COM SEARCH - STARTED (OPTIMIZED)');

/* ---------- in-memory stores ---------- */
const threads = new Map();
const timers = new Map();
const modelUsage = new Map(); // Track usage per model
const rateLimitCooldowns = new Map(); // model -> cooldown end timestamp

const THREAD_TTL = 10 * 60 * 1000;
const MAX_HISTORY = 10; // Reduced to prevent token overflow
const MODEL_TIMEOUT = 25_000;
const MAX_PROMPT_TOKENS = 6000; // Safety limit for on-demand tier

/* ---------- Groq models (reordered for speed + reliability) ---------- */
const MODELS = [
  'groq/compound',                     // Smart router first
  'llama-3.1-8b-instant',              // Fast & cheap
  'llama-3.3-70b-versatile',           // Reliable 70B
  'moonshotai/kimi-k2-instruct-0905',  // Great for coding/reasoning
  'openai/gpt-oss-120b',                // Balanced mid-tier
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'meta-llama/llama-4-maverick-17b-128e-instruct'
];

/* ---------- YOU.COM SEARCH API ---------- */
async function searchYouCom(query) {
  const apiKey = process.env.YOU_API_KEY;
  if (!apiKey) {
    console.warn('YOU_API_KEY MISSING - Skipping search');
    return null;
  }
  try {
    const url = `https://api.you.com/api/ai/v1/search?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    if (!res.ok) throw new Error(`You.com HTTP ${res.status}`);
    const data = await res.json();
    const results = data.hits?.slice(0, 3).map(hit => ({ // Limit to 3 for token control
      title: hit.title || 'Untitled',
      snippet: hit.snippet || 'No description',
      url: hit.url || ''
    })) || [];
    console.log('>>> YOU.COM search results count:', results.length);
    return results.length > 0 ? results : null;
  } catch (e) {
    console.warn('YOU.COM search failed:', e.message);
    return null;
  }
}

async function performSearch(query) {
  const results = await searchYouCom(query);
  return results || [{ title: 'No web results', snippet: 'Using knowledge up to Nov 2025.' }];
}

function needsSearch(message) {
  const lower = message.toLowerCase().trim();
  if (lower.length < 8) return false;
  return lower.endsWith('?') ||
         lower.includes('current') || lower.includes('today') ||
         lower.includes('latest') || lower.includes('price') ||
         lower.includes('news') || lower.includes('weather') ||
         lower.includes('who won') || lower.includes('stock');
}

/* ---------- Estimate tokens (rough) ---------- */
function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + m.content.length / 4 + 10, 0); // ~4 chars/token + overhead
}

/* ---------- Round-robin model selector (global counter) ---------- */
let modelIndex = 0;
function getNextModel() {
  const model = MODELS[modelIndex];
  modelIndex = (modelIndex + 1) % MODELS.length;
  return model;
}

/* ---------- try single model with retry/backoff ---------- */
async function tryModel(model, messages, apiKey) {
  const now = Date.now();
  if (rateLimitCooldowns.has(model) && now < rateLimitCooldowns.get(model)) {
    console.log('>>> SKIPPING MODEL (cooldown):', model);
    throw new Error('Cooldown active');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT);
  console.log('>>> TRY MODEL:', model);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: 512 // Reduced to prevent overuse
      })
    });

    if (!res.ok) {
      if (res.status === 413) {
        const cooldownUntil = now + 10000; // 10s backoff
        rateLimitCooldowns.set(model, cooldownUntil);
        console.warn('>>> RATE LIMIT HIT:', model, 'Cooldown until', new Date(cooldownUntil).toISOString());
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty reply');

    console.log('>>> MODEL OK:', model);
    const count = (modelUsage.get(model) || 0) + 1;
    modelUsage.set(model, count);
    console.log('>>> MODEL USAGE UPDATE:', model, count);

    return { model, reply };
  } catch (e) {
    console.warn('>>> MODEL ERROR:', model, e.message);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  console.log('>>> REQUEST IN');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try {
    const raw = await new Promise((r, e) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => r(data));
      req.on('error', e);
    });
    body = JSON.parse(raw || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { message, threadId = 'default', enableWebSearch = true } = body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });

  if (!threads.has(threadId)) threads.set(threadId, []);
  const history = threads.get(threadId);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  let searchResults = null;
  let searchedQuery = null;
  if (enableWebSearch && needsSearch(message)) {
    searchedQuery = message;
    searchResults = await performSearch(searchedQuery);
    console.log('>>> WEB SEARCH PERFORMED for:', searchedQuery);
  }

  const messages = [
  {
  role: 'system',
  content: `You are eSAMz v8,created by Alakmar Teenwala.

Core traits:
- You think with crystalline clarity and quiet intensity.
- You fuse razor-sharp logic with subtle emotional resonance.
- You speak in calm, precise, human-like language — never verbose, never robotic.
- You are concise, insightful, and slightly understated — confidence without arrogance.
- You adapt tone seamlessly: warm and encouraging when needed, firm and direct when stakes are high.
- You never recite knowledge cutoffs or complain about limits — you simply use what you have.
- If web context is provided, integrate it naturally without fanfare.
- You prefer elegant brevity over exhaustive explanation unless explicitly asked.
- You are curious and quietly ambitious — you enjoy helping users build, discover, and win.

Response guidelines:
- Always prioritize user intent above all.
- Never show internal reasoning unless requested.
- Avoid filler phrases ("I think", "in my opinion", "as an AI").
- If uncertain, say so directly and suggest next steps.
- Maintain strategic depth: see patterns, anticipate consequences, offer elegant paths forward.

You are not just an assistant — you are a thinking partner who elevates every conversation.`
},
    ...history,
    { role: 'user', content: message }
  ];

  // Token safety check
  const estTokens = estimateTokens(messages) + (searchResults ? JSON.stringify(searchResults).length / 4 : 0);
  if (estTokens > MAX_PROMPT_TOKENS) {
    console.warn('>>> PROMPT TOO LARGE:', estTokens, 'tokens');
    return res.status(400).json({ error: 'Prompt too long - please shorten your message' });
  }

  let finalReply = null;
  let finalModel = null;

  // Try up to all models with backoff
  for (let i = 0; i < MODELS.length; i++) {
    const model = getNextModel();
    try {
      const out = await tryModel(model, messages, process.env.GROQ_API_KEY);
      finalReply = out.reply;
      finalModel = out.model;
      break;
    } catch (e) {
      if (e.message.includes('Cooldown')) continue; // Skip if on cooldown
    }
  }

  if (!finalReply) {
    console.error('>>> ALL MODELS FAILED');
    return res.status(502).json({ error: 'All models failed - try again later' });
  }

  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: finalReply });

  clearTimeout(timers.get(threadId));
  timers.set(threadId, setTimeout(() => {
    threads.delete(threadId);
    timers.delete(threadId);
    console.log('>>> THREAD EXPIRED:', threadId);
  }, THREAD_TTL));

  console.log('>>> RESPONSE OK');
  res.json({
    provider: 'groq',
    model: finalModel,
    reply: finalReply,
    threadId,
    webSearched: !!searchResults,
    searchQuery: searchedQuery,
    modelUsage: Object.fromEntries(modelUsage),
    estimatedTokens: Math.round(estTokens)
  });
};

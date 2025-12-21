/* ---------- DEBUG BOOT ---------- */
console.log('>>> ESAMZ BACKEND v10 - YOU.COM SEARCH - STARTED (ALL MODELS MODE)');
/* ---------- in-memory stores ---------- */
const threads = new Map();
const timers = new Map();
const modelCounters = new Map(); // NEW: Track usage per model for logging
const THREAD_TTL = 10 * 60 * 1000;
const MAX_HISTORY = 20;
const MODEL_TIMEOUT = 30_000;
/* ---------- Groq models ---------- */
// Removed invalid 'deepseek-r1-distill-llama-70b'; added 'groq/compound' as bonus
// Dropped 'llama-guard-4-12b' from main list (use separately for safety if needed)
const MODELS = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b', // Replaces invalid DeepSeek
  'moonshotai/kimi-k2-instruct-0905',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'groq/compound' // NEW: Smart router for even distribution
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
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    if (!res.ok) throw new Error(`You.com HTTP ${res.status}`);
    const data = await res.json();
    const results = data.hits?.slice(0, 5).map(hit => ({
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
  if (results) return results;
  return [{ title: 'No web results', snippet: 'Using knowledge up to Nov 2025.' }];
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
/* ---------- Select Model (NEW: Round-Robin for Even Usage) ---------- */
function selectPrimaryModel(threadId) {
  // Use threadId hash for deterministic round-robin per thread
  let hash = 0;
  for (let i = 0; i < threadId.length; i++) {
    hash = (hash * 31 + threadId.charCodeAt(i)) % MODELS.length;
  }
  return MODELS[hash]; // Starts with a different model per thread
}
/* ---------- try single model ---------- */
async function tryModel(model, messages, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT);
  console.log('>>> TRY MODEL:', model);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
        max_tokens: 800
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty reply');
    console.log('>>> MODEL OK:', model);
    // Track usage
    const count = (modelCounters.get(model) || 0) + 1;
    modelCounters.set(model, count);
    console.log('>>> MODEL USAGE UPDATE:', model, count);
    return { model, reply };
  } catch (e) {
    console.warn('>>> MODEL ERROR:', model, e.message);
    console.log('>>> FALLBACK to next model');
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
      content:
        'You are eSAMz AI, created by Alakmar Teenwala. ' +
        'Be concise, helpful, human-like, and clear. ' +
        'Your knowledge cutoff is November 2025. ' +
        'If fresh web context is provided below, use it for up-to-date information. ' +
        'Do NOT mention your knowledge cutoff unless explicitly asked. ' +
        'Do NOT recite "my knowledge cutoff is November 2025" in responses.\n' +
        (searchResults ?
          `Fresh web context (today: ${new Date().toISOString().slice(0,10)}):\n` +
          JSON.stringify(searchResults, null, 2) + '\n' +
          'Use this ONLY if relevant. Cite briefly if used. Do NOT invent info.\n'
          : '')
    },
    ...history,
    { role: 'user', content: message }
  ];
  let finalReply = null;
  let finalModel = null;
  // NEW: Select primary model via round-robin (uses all over time)
  let primaryModel = selectPrimaryModel(threadId);
  console.log('>>> PRIMARY MODEL SELECTED (round-robin):', primaryModel);
  // Try primary first
  try {
    const out = await tryModel(primaryModel, messages, process.env.GROQ_API_KEY);
    finalReply = out.reply;
    finalModel = out.model;
  } catch {
    // If primary fails, fallback to sequential list (starting from next after primary)
    const primaryIndex = MODELS.indexOf(primaryModel);
    const fallbackModels = [
      ...MODELS.slice(primaryIndex + 1),
      ...MODELS.slice(0, primaryIndex)
    ];
    for (const model of fallbackModels) {
      try {
        const out = await tryModel(model, messages, process.env.GROQ_API_KEY);
        finalReply = out.reply;
        finalModel = out.model;
        break;
      } catch {}
    }
  }
  if (!finalReply) return res.status(502).json({ error: 'All models failed' });
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
    // NEW: Usage stats for debugging
    modelUsage: Object.fromEntries(modelCounters)
  });
};

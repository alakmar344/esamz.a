/* ---------- DEBUG BOOT ---------- */
console.log('>>> ESAMZ BACKEND v3 - WITH FREE WEB SEARCH - STARTED');

/* ---------- in-memory stores ---------- */
const threads = new Map(); // threadId -> messages[]
const timers = new Map();
const THREAD_TTL = 10 * 60 * 1000; // 10 min
const MAX_HISTORY = 20;
const MODEL_TIMEOUT = 30_000;

/* ---------- verified Groq chat models ---------- */
const MODELS = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'deepseek-r1-distill-llama-70b',
  'moonshotai/kimi-k2-instruct-0905',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'meta-llama/llama-guard-4-12b'
];

/* ---------- FREE SEARCH HELPERS ---------- */

// DuckDuckGo JSON API - 100% free, no key, reliable
async function searchDDG(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&pretty=1`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
    const data = await res.json();
    
    const results = [];
    if (data.Abstract) {
      results.push({ title: data.Heading || 'Summary', snippet: data.Abstract });
    }
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      data.RelatedTopics.slice(0, 5).forEach(topic => {
        if (topic.Text) {
          results.push({ title: topic.Text.split(' - ')[0] || 'Info', snippet: topic.Text });
        }
      });
    }
    return results.length > 0 ? results : null;
  } catch (e) {
    console.warn('DDG search failed:', e.message);
    return null;
  }
}

// SearXNG fallback (public instances)
async function searchSearXNG(query) {
  const instances = [
    'https://searx.be',
    'https://search.sapinet.fr',
    'https://searx.tiekoetter.net',
    'https://search.bus-hit.me'
  ];

  for (const base of instances) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
      const res = await fetch(url, { timeout: 5000 });
      if (!res.ok) continue;
      const data = await res.json();
      return data.results.slice(0, 5).map(r => ({
        title: r.title || 'Untitled',
        snippet: r.content || 'No description'
      }));
    } catch (e) {
      console.warn(`SearXNG ${base} failed:`, e.message);
    }
  }
  return null;
}

// Combined search
async function performSearch(query) {
  let results = await searchDDG(query);
  if (results) return results;

  results = await searchSearXNG(query);
  return results || [{ title: 'Search failed', snippet: 'Could not fetch web results at this time.' }];
}

// When to search?
function needsSearch(message) {
  const lower = message.toLowerCase().trim();
  if (lower.length < 10) return false;

  const triggers = [
    'what is', 'who is', 'when', 'how many', 'latest', 'current', 'today', 'now',
    'news', 'recent', 'update on', 'price of', 'stock', 'weather', 'who won',
    'election', 'score', 'result', 'definition', 'tell me about', 'search for',
    'find', 'current time', 'what time', 'how much is', 'who invented', 'last update',
    'breaking news', 'what happened', 'who said', '?'
  ];

  return triggers.some(t => lower.includes(t)) ||
         (lower.split(' ').length > 10 && !lower.includes('write') && !lower.includes('code'));
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
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty reply');
    console.log('>>> MODEL OK:', model);
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

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Read body
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

  // Thread setup
  if (!threads.has(threadId)) threads.set(threadId, []);
  const history = threads.get(threadId);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  // Autonomous web search
  let searchResults = null;
  let searchedQuery = null;
  if (enableWebSearch && needsSearch(message)) {
    searchedQuery = message;
    searchResults = await performSearch(searchedQuery);
    console.log('>>> WEB SEARCH PERFORMED for:', searchedQuery);
  }

  // Build messages
  const messages = [
    {
      role: 'system',
      content:
        'You are eSAMz AI, created by Alakmar Teenwala. ' +
        'Be concise, helpful, human-like, and clear. Knowledge cutoff: November 2025.\n' +
        (searchResults ? 
          `Fresh web context (today: ${new Date().toISOString().slice(0,10)}):\n` +
          JSON.stringify(searchResults, null, 2) + '\n' +
          'Use this ONLY if relevant. Cite briefly if used. Do NOT invent info.\n'
          : '')
    },
    ...history,
    { role: 'user', content: message }
  ];

  // Failover model loop
  let finalReply = null;
  let finalModel = null;
  for (const model of MODELS) {
    try {
      const out = await tryModel(model, messages, process.env.GROQ_API_KEY);
      finalReply = out.reply;
      finalModel = out.model;
      break;
    } catch {}
  }

  if (!finalReply) return res.status(502).json({ error: 'All models failed' });

  // Store history
  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: finalReply });

  // TTL cleanup
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
    searchQuery: searchedQuery
  });
};

/* ============================================
   eSAMz v8.4 Backend – Sarvam + Web Search
   Created by Alakmar Teenwala
   Updated: December 2025
   ============================================ */

console.log('>>> eSAMz v8.4 - Sarvam + Web Intelligence Online');

/* ---------- CONFIG ---------- */
const CONFIG = {
  THREAD_TTL: 10 * 60 * 1000,
  MAX_HISTORY_TOKENS: 3000,
  MAX_PROMPT_TOKENS: 6000,
  MODEL_TIMEOUT: 30_000
};

/* ---------- STATE ---------- */
const threads = new Map();
const timers = new Map();

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are eSAMz AI created by Alakmar Teenwala.
Be calm, precise, human-like.
Use web information only if provided.
If unsure, say you are unsure.`
};

/* ---------- HELPERS ---------- */
function estimateTokens(text = '') {
  return Math.ceil(text.length / 4);
}

function messagesTokens(messages) {
  return messages.reduce((t, m) => t + estimateTokens(m.content) + 8, 0);
}

function trimHistory(history) {
  while (history.length && messagesTokens(history) > CONFIG.MAX_HISTORY_TOKENS) {
    history.shift();
  }
}

function sanitize(messages) {
  return messages.map(m => ({
    role: m.role,
    content: String(m.content ?? '')
  }));
}

function needsWebSearch(text) {
  return /\b(latest|today|current|news|price|recent|who is|when did)\b/i.test(text);
}

/* ---------- SARVAM: LANGUAGE DETECTION ---------- */
async function detectLanguage(text, apiKey) {
  const res = await fetch('https://api.sarvam.ai/v1/language-detection', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });

  const data = await res.json();
  return data?.language || 'en';
}

/* ---------- WEB SEARCH ---------- */
async function webSearch(query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: query,
      num: 5
    })
  });

  if (!res.ok) throw new Error('Web search failed');

  const data = await res.json();
  return (data.organic || [])
    .map(r => `• ${r.title}: ${r.snippet}`)
    .join('\n');
}

/* ---------- SARVAM CHAT ---------- */
async function chatWithSarvam(messages, apiKey) {
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sarvam-m',
      messages: sanitize(messages),
      temperature: 0.6,
      max_tokens: 2048
    })
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content;
}

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method !== 'POST') return res.status(405).end();

  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) return res.status(500).json({ error: 'SARVAM_API_KEY missing' });

  let body;
  try {
    body = JSON.parse(await new Promise(r => {
      let d = '';
      req.on('data', c => d += c);
      req.on('end', () => r(d));
    }));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { message, threadId = 'default' } = body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  try {
    if (!threads.has(threadId)) threads.set(threadId, []);
    const history = threads.get(threadId);

    const language = await detectLanguage(message, sarvamKey);

    let webContext = '';
    if (needsWebSearch(message) && process.env.SERPER_API_KEY) {
      webContext = await webSearch(message);
    }

    const messages = [
      SYSTEM_PROMPT,
      ...history,
      ...(webContext ? [{
        role: 'system',
        content: `Web results:\n${webContext}`
      }] : []),
      { role: 'user', content: message }
    ];

    if (messagesTokens(messages) > CONFIG.MAX_PROMPT_TOKENS) {
      trimHistory(history);
    }

    const reply = await chatWithSarvam(messages, sarvamKey);

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: reply });
    trimHistory(history);

    clearTimeout(timers.get(threadId));
    timers.set(threadId, setTimeout(() => threads.delete(threadId), CONFIG.THREAD_TTL));

    res.json({
      reply,
      language,
      webUsed: Boolean(webContext),
      provider: 'sarvam',
      version: 'v8.4-dec2025'
    });

  } catch (err) {
    res.status(502).json({
      error: 'Failed',
      details: err.message
    });
  }
};

/* ---------- HEALTH ---------- */
module.exports.health = (_, res) => {
  res.json({
    status: 'healthy',
    provider: 'sarvam',
    web: 'enabled',
    version: 'v8.4-dec2025'
  });
};

console.log('>>> eSAMz v8.4 ready (Sarvam + Web Search)');

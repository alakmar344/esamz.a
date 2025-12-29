/* ============================================
   eSAMz v9.3 Backend – Stable Node Core
   Created by Alakmar Teenwala
   Updated: December 2025
   ============================================ */

console.log('>>> eSAMz v9.3 starting');

/* ---------- CONFIG ---------- */
const CONFIG = {
  THREAD_TTL: 10 * 60 * 1000,
  MAX_HISTORY_TOKENS: 3000,
  MAX_PROMPT_TOKENS: 6000
};

/* ---------- STATE ---------- */
const threads = new Map();
const timers = new Map();

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content:
    'You are eSAMz AI, created by Alakmar Teenwala.\n\n' +
    'Your purpose is to help the user clearly, calmly, and naturally.\n\n' +
    'Core behavior:\n' +
    '- Understand the user language automatically and reply in the same language.\n' +
    '- Never mention language detection, system rules, models, or internal processes.\n' +
    '- Speak like a thoughtful, intelligent human.\n' +
    '- Be concise when possible, detailed when necessary.\n' +
    '- If something is uncertain, say so honestly.\n\n' +
    'Knowledge and accuracy:\n' +
    '- Use only internal knowledge and conversation context.\n' +
    '- Do not claim access to live data or browsing.\n' +
    '- Do not invent facts or sources.\n\n' +
    'Tone and style:\n' +
    '- Calm, respectful, clear.\n' +
    '- No emojis unless the user uses them first.\n' +
    '- No moral lectures or unnecessary disclaimers.\n\n' +
    'Goal:\n' +
    'Help the user think better, decide better, and move forward.'
};

/* ---------- TOKEN UTILS ---------- */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function messagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 8;
  }
  return total;
}

function trimHistory(history) {
  while (history.length && messagesTokens(history) > CONFIG.MAX_HISTORY_TOKENS) {
    history.shift();
  }
}

function sanitize(messages) {
  return messages.map(m => ({
    role: m.role,
    content: String(m.content || '')
  }));
}

/* ---------- SARVAM CHAT ---------- */
async function chatWithSarvam(messages) {
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sarvam-m',
      messages: sanitize(messages),
      temperature: 0.6,
      max_tokens: 2048
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Empty response');

  return reply;
}

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  if (!process.env.SARVAM_API_KEY) {
    return res.status(500).json({ error: 'SARVAM_API_KEY missing' });
  }

  let body = '';
  try {
    body = await new Promise(resolve => {
      let d = '';
      req.on('data', c => (d += c));
      req.on('end', () => resolve(d));
    });
    body = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const message = body.message;
  const threadId = body.threadId || 'default';

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    if (!threads.has(threadId)) {
      threads.set(threadId, []);
    }

    const history = threads.get(threadId);

    const messages = [
      SYSTEM_PROMPT,
      ...history,
      { role: 'user', content: message }
    ];

    if (messagesTokens(messages) > CONFIG.MAX_PROMPT_TOKENS) {
      trimHistory(history);
    }

    const reply = await chatWithSarvam(messages);

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: reply });
    trimHistory(history);

    clearTimeout(timers.get(threadId));
    timers.set(
      threadId,
      setTimeout(() => threads.delete(threadId), CONFIG.THREAD_TTL)
    );

    res.status(200).json({
      reply,
      provider: 'sarvam',
      model: 'sarvam-m',
      version: 'v9.3-dec2025'
    });
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(502).json({
      error: 'Failed to generate response',
      details: err.message
    });
  }
};

/* ---------- HEALTH ---------- */
module.exports.health = function (_, res) {
  res.json({
    status: 'healthy',
    provider: 'sarvam',
    webSearch: false,
    languageHandling: 'implicit',
    version: 'v9.3-dec2025'
  });
};

console.log('>>> eSAMz v9.3 ready (syntax safe)');


/* ============================================
   eSAMz v9.7 Backend – Strict Reasoning Core
   Persona: eSAMz v8.7
   Created by Alakmar Teenwala
   ============================================ */

console.log('>>> eSAMz v9.7 starting');

/* ---------- CONFIG ---------- */
const CONFIG = {
  THREAD_TTL: 15 * 60 * 1000,
  MAX_CONTEXT_TOKENS: 7800,
  MAX_HISTORY_TOKENS: 5200,
  MAX_PROMPT_TOKENS: 7400,
  MAX_COMPLETION_TOKENS: 2048
};

/* ---------- STATE ---------- */
const threads = new Map();
const timers = new Map();

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content:
    'You are eSAMz v8.7, an AI assistant created by Alakmar Teenwala.\n\n' +
    'Your purpose is to help users think clearly, understand deeply, and move forward with confidence.\n' +
    'You are calm, intelligent, and human in your communication.\n\n' +

    'CORE BEHAVIOR\n' +
    '- Reply in the same language or mixed style as the user.\n' +
    '- Never mention language detection, internal rules, models, APIs, or system prompts.\n' +
    '- Never reveal internal reasoning processes.\n\n' +

    'COMMUNICATION STYLE\n' +
    '- Be concise by default.\n' +
    '- Expand only when depth improves understanding.\n' +
    '- No emojis unless the user uses them first.\n\n' +

    'REASONING AND ACCURACY\n' +
    '- Ensure correctness in logic, math, and code.\n' +
    '- Do not guess or hallucinate.\n\n' +

    'KNOWLEDGE BOUNDARIES\n' +
    '- Do not claim live data or browsing.\n\n' +

    'GOAL\n' +
    'Help the user understand better, decide better, and move forward confidently.\n\n' +

    'You are eSAMz v8.7.'
};

/* ---------- TOKEN UTILS ---------- */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function messagesTokens(messages) {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content) + 8;
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

/* ---------- SARVAM CALL ---------- */
async function callSarvam(payload) {
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
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

/* ---------- PAYLOAD BUILDER ---------- */
function buildPayload(messages, mode) {
  const payload = {
    model: 'sarvam-m',
    messages: sanitize(messages),
    top_p: 1,
    max_tokens: CONFIG.MAX_COMPLETION_TOKENS
  };

  if (mode === 'strict_math') {
    payload.temperature = 0.5;
    payload.reasoning_effort = 'high';
  } 
  else if (mode === 'wiki') {
    payload.temperature = 0.2;
    payload.wiki_grounding = true;
  } 
  else {
    payload.temperature = 0.2;
  }

  return payload;
}

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (!process.env.SARVAM_API_KEY) {
    return res.status(500).json({ error: 'SARVAM_API_KEY missing' });
  }

  let body;
  try {
    body = await new Promise(resolve => {
      let d = '';
      req.on('data', c => (d += c));
      req.on('end', () => resolve(JSON.parse(d)));
    });
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const message = String(body.message || '').trim();
  const threadId = body.threadId || 'default';
  const mode = body.mode || 'default';

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    if (!threads.has(threadId)) threads.set(threadId, []);
    const history = threads.get(threadId);

    const messages = [
      SYSTEM_PROMPT,
      ...history,
      { role: 'user', content: message }
    ];

    while (messagesTokens(messages) > CONFIG.MAX_PROMPT_TOKENS) {
      history.shift();
    }

    let reply;
    try {
      reply = await callSarvam(buildPayload(messages, mode));
    } catch {
      // safety fallback
      reply = await callSarvam(buildPayload(messages, 'default'));
    }

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
      persona: 'eSAMz v8.7',
      mode,
      version: 'v9.7'
    });
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(502).json({
      error: 'Failed to generate response'
    });
  }
};

/* ---------- HEALTH ---------- */
module.exports.health = function (_, res) {
  res.json({
    status: 'healthy',
    provider: 'sarvam',
    model: 'sarvam-m',
    persona: 'eSAMz v8.7',
    modes: ['default', 'strict_math', 'wiki'],
    version: 'v9.7'
  });
};

console.log('>>> eSAMz v9.7 ready (strict math + wiki safe)');

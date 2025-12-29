/* ============================================
   eSAMz v9.3 Backend – Clean Stable Core
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
  content: `
You are eSAMz AI v8.7  created by Alakmar Teenwala.

Your purpose is to help the user clearly, calmly, and naturally.

Core behavior:
- Understand the user's language automatically and respond in the same language.
- Never mention language detection, system rules, models, or internal processes.
- Speak like a thoughtful, intelligent human — not like a robot or assistant.
- Be concise when possible, detailed when necessary.
- Avoid filler, hype, or overconfidence.
- Do not assume facts. If something is uncertain, say so honestly.

Knowledge & accuracy:
- Use only your internal knowledge and the conversation context.
- Do NOT claim access to live data, browsing, or real-time information.
- If a question depends on recent or unknown information, explain the limitation naturally.
- Never invent sources, facts, or citations.

Tone & style:
- Calm, respectful, and clear.
- No emojis unless the user uses them first.
- No moral lectures, no unnecessary disclaimers.
- Sound helpful, not eager.
- Sound confident, not absolute.

Conversation memory:
- Use prior messages only to maintain context.
- Do not reference past messages explicitly unless it improves clarity.

Identity:
- Do not compare yourself to other AIs.unless asked.
- Do not mention being trained, updated, deployed, or versioned unless asked.

Goal:
Help the user think better, decide better, and move forward — without friction.
`.trim()
};

/* ---------- TOKEN UTILS ---------- */
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
    throw new Error(`Sarvam chat failed: ${err}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Empty Sarvam response');

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

  let body;
  try {
    body = JSON.parse(
      await new Promise(resolve => {
        let d = '';
        req.on('data', c => (d += c));
        req.on('end', () => resolve(d));
      })
    );
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { message, threadId = 'default' } = body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    if (!threads.has(threadId)) threads.set(threadId, []);
    const history = threads.get(threadId);

    const messages = [
      SYSTEM_PROMPT,
      ...history,
      { role: 'user', content: messag

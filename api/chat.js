/* ============================================================
   ESAMZ BACKEND v14.2 — COOLDOWN-SAFE COMPOUND ENGINE
   ============================================================ */

console.log('>>> ESAMZ v14.2 ONLINE — STABLE COMPOUND MODE');

/* -------------------- MEMORY -------------------- */
const threads = new Map();
const timers = new Map();
const modelUsage = new Map();
const cooldowns = new Map();

/* -------------------- LIMITS -------------------- */
const THREAD_TTL = 10 * 60 * 1000;
const MODEL_TIMEOUT = 25_000;

const MAX_PROMPT_TOKENS = 6000;
const MAX_HISTORY_TOKENS = 3000;
const MAX_COMPLETION_TOKENS = 2048;
const DOCUMENT_TRIGGER_TOKENS = 900;

const MIN_QUORUM = 3;
const STAGGER_DELAY = 120;

/* -------------------- MODELS -------------------- */
const ALL_MODELS = [
  'groq/compound',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'moonshotai/kimi-k2-instruct-0905',
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'deepseek-r1-distill-llama-70b',
  'mixtral-8x22b-instruct',
  'gemma-2-27b-it'
];

const CODE_MODELS = [
  'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct-0905'
];

/* -------------------- SYSTEM PROMPT -------------------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content: `
You are eSAMz v8.1.
Created solely by Alakmar Teenwala.
Knowledge cutoff June 2025.

- Calm. Precise. Human.
- Never verbose.
- Never expose internal reasoning.
- Output only the final answer.
`
};

/* -------------------- TOKEN UTILS -------------------- */
const t = s => Math.ceil(s.length / 4);
const countTokens = msgs => msgs.reduce((a, m) => a + t(m.content) + 8, 0);

function trimHistory(h) {
  while (countTokens(h) > MAX_HISTORY_TOKENS) h.shift();
}

/* -------------------- CODE DETECTION -------------------- */
function isCodeQuery(text) {
  return (
    /```/.test(text) ||
    /\b(class|function|const|let|var|import|export|return)\b/.test(text) ||
    /<\/?[a-z][\s\S]*>/i.test(text)
  );
}

/* -------------------- MODEL CALL (SAFE) -------------------- */
async function callModel(model, messages, apiKey, retry = 1) {
  const now = Date.now();

  // cooldown = skip, never throw
  if (cooldowns.has(model) && now < cooldowns.get(model)) {
    return null;
  }

  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), MODEL_TIMEOUT);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: MAX_COMPLETION_TOKENS
      })
    });

    if (!res.ok) {
      if (res.status === 429) {
        cooldowns.set(model, now + 15_000);
        if (retry > 0) {
          await new Promise(r => setTimeout(r, 400));
          return callModel(model, messages, apiKey, retry - 1);
        }
      }
      return null;
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return null;

    modelUsage.set(model, (modelUsage.get(model) || 0) + 1);
    return { model, reply };

  } finally {
    clearTimeout(kill);
  }
}

/* -------------------- STAGGERED ENSEMBLE -------------------- */
async function runEnsemble(models, messages, apiKey) {
  const results = [];

  for (const model of models) {
    const r = await callModel(model, messages, apiKey);
    if (r) results.push(r);
    if (results.length >= MIN_QUORUM) break;
    await new Promise(r => setTimeout(r, STAGGER_DELAY));
  }

  return results;
}

/* -------------------- SYNTHESIS -------------------- */
function buildSynthesis(responses, userQuery) {
  const body = responses.map(r => r.reply).join('\n\n');

  return [
    SYSTEM_PROMPT,
    {
      role: 'user',
      content: `
Merge the following responses into ONE final answer.
Resolve conflicts. One voice. Prefer correctness.

QUESTION:
${userQuery}

RESPONSES:
${body}
`
    }
  ];
}

/* -------------------- DOCUMENT REDUCTION -------------------- */
async function summariseDocument(text, apiKey) {
  const msgs = [
    SYSTEM_PROMPT,
    { role: 'user', content: `Summarise under 400 tokens.\n\n${text}` }
  ];

  const r = await callModel('llama-3.1-8b-instant', msgs, apiKey);
  return r ? r.reply : text.slice(0, 2000);
}

/* -------------------- HANDLER -------------------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

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
  if (!message) return res.status(400).json({ error: 'message required' });

  if (!threads.has(threadId)) threads.set(threadId, []);
  const history = threads.get(threadId);
  trimHistory(history);

  let input = message;
  let documentMode = false;

  if (t(message) > DOCUMENT_TRIGGER_TOKENS) {
    documentMode = true;
    input = await summariseDocument(message, process.env.GROQ_API_KEY);
  }

  const messages = [
    SYSTEM_PROMPT,
    ...history,
    { role: 'user', content: input }
  ];

  const pool = isCodeQuery(message) ? CODE_MODELS : ALL_MODELS;
  const ensemble = await runEnsemble(pool, messages, process.env.GROQ_API_KEY);

  if (!ensemble.length) {
    return res.status(503).json({ error: 'Temporary overload. Try again.' });
  }

  let final;
  try {
    final = await callModel(
      'openai/gpt-oss-120b',
      buildSynthesis(ensemble, message),
      process.env.GROQ_API_KEY
    );
  } catch {
    final = ensemble[0];
  }

  history.push({ role: 'user', content: input });
  history.push({ role: 'assistant', content: final.reply });
  trimHistory(history);

  clearTimeout(timers.get(threadId));
  timers.set(threadId, setTimeout(() => threads.delete(threadId), THREAD_TTL));

  res.json({
    reply: final.reply,
    model: 'eSAMz-8.1-compound',
    threadId,
    documentMode,
    ensembleSize: ensemble.length,
    modelUsage: Object.fromEntries(modelUsage)
  });
};

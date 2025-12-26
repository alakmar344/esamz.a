/* ============================================================
   ESAMZ BACKEND v14 — TRUE COMPOUND INTELLIGENCE ENGINE
   ============================================================ */

console.log('>>> ESAMZ v14 ONLINE — COMPOUND MODE ACTIVE');

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

/* -------------------- MODELS (ALL 11) -------------------- */
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

/* -------------------- SYSTEM IDENTITY -------------------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content: `
You are eSAMz v8.1.
Created solely by Alakmar Teenwala.
Knowledge cutoff June 2025.

Principles:
- Calm. Precise. Human.
- Strategic. Never verbose.
- Elegant brevity.
- Never expose internal reasoning.
- Never mention limitations.
- Output only the final answer.
`
};

/* -------------------- TOKEN UTILS -------------------- */
const t = s => Math.ceil(s.length / 4);
const countTokens = msgs => msgs.reduce((a, m) => a + t(m.content) + 8, 0);

function trimHistory(history) {
  while (countTokens(history) > MAX_HISTORY_TOKENS) history.shift();
}

/* -------------------- CODE DETECTION -------------------- */
function isCodeQuery(text) {
  return (
    /```/.test(text) ||
    /\b(class|function|const|let|var|import|export|return)\b/.test(text) ||
    /<\/?[a-z][\s\S]*>/i.test(text)
  );
}

/* -------------------- MODEL CALL -------------------- */
async function callModel(model, messages, apiKey) {
  const now = Date.now();

  if (cooldowns.has(model) && now < cooldowns.get(model)) {
    throw new Error('Cooldown');
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
      if (res.status === 413) cooldowns.set(model, now + 10_000);
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty');

    modelUsage.set(model, (modelUsage.get(model) || 0) + 1);
    return { model, reply };

  } finally {
    clearTimeout(kill);
  }
}

/* -------------------- PARALLEL EXECUTION -------------------- */
async function runEnsemble(models, messages, apiKey) {
  const jobs = models.map(m =>
    callModel(m, messages, apiKey)
      .then(r => ({ ok: true, model: r.model, reply: r.reply }))
      .catch(() => ({ ok: false, model: m }))
  );

  return (await Promise.all(jobs)).filter(x => x.ok);
}

/* -------------------- SYNTHESIS -------------------- */
function buildSynthesis(responses, userQuery) {
  const body = responses
    .map(r => `MODEL ${r.model}:\n${r.reply}`)
    .join('\n\n');

  return [
    SYSTEM_PROMPT,
    {
      role: 'user',
      content: `
Merge the following expert responses into ONE final answer.

Rules:
- Do not mention models or sources.
- Resolve contradictions.
- Prefer correctness over verbosity.
- Keep tone calm, precise, human.

USER QUERY:
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
    {
      role: 'user',
      content: `Summarise under 400 tokens. Preserve structure.\n\nDOCUMENT:\n${text}`
    }
  ];

  return (await callModel('llama-3.1-8b-instant', msgs, apiKey)).reply;
}

/* -------------------- HANDLER -------------------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

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
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message required' });
  }

  if (!threads.has(threadId)) threads.set(threadId, []);
  const history = threads.get(threadId);
  trimHistory(history);

  let userInput = message;
  let documentMode = false;

  if (t(message) > DOCUMENT_TRIGGER_TOKENS) {
    documentMode = true;
    userInput = await summariseDocument(message, process.env.GROQ_API_KEY);
  }

  const messages = [
    SYSTEM_PROMPT,
    ...history,
    { role: 'user', content: userInput }
  ];

  if (countTokens(messages) > MAX_PROMPT_TOKENS) trimHistory(history);

  const codeQuery = isCodeQuery(message);
  const pool = codeQuery ? CODE_MODELS : ALL_MODELS;

  const ensemble = await runEnsemble(pool, messages, process.env.GROQ_API_KEY);
  if (!ensemble.length) {
    return res.status(502).json({ error: 'Ensemble failure' });
  }

  const synthesis = buildSynthesis(ensemble, message);
  const final = await callModel(
    'openai/gpt-oss-120b',
    synthesis,
    process.env.GROQ_API_KEY
  );

  history.push({ role: 'user', content: userInput });
  history.push({ role: 'assistant', content: final.reply });
  trimHistory(history);

  clearTimeout(timers.get(threadId));
  timers.set(threadId, setTimeout(() => threads.delete(threadId), THREAD_TTL));

  res.json({
    reply: final.reply,
    model: 'eSAMz-8.1-compound',
    threadId,
    documentMode,
    codeRouted: codeQuery,
    ensembleSize: ensemble.length,
    modelUsage: Object.fromEntries(modelUsage)
  });
};


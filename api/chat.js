 /* ---------- DEBUG BOOT ---------- */
console.log('>>> ESAMZ BACKEND v13 - FULL MODEL ROUTER');

/* ---------- STORES ---------- */
const threads = new Map();
const timers = new Map();
const modelUsage = new Map();
const rateLimitCooldowns = new Map();

/* ---------- CONSTANTS ---------- */
const THREAD_TTL = 10 * 60 * 1000;
const MODEL_TIMEOUT = 25_000;

const MAX_PROMPT_TOKENS = 6000;
const MAX_HISTORY_TOKENS = 3000;
const MAX_COMPLETION_TOKENS = 2048;
const DOCUMENT_TRIGGER_TOKENS = 900;

/* ---------- MODELS (ALL 11) ---------- */
const MODELS = [
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

/* ---------- CODE-ONLY MODELS ---------- */
const CODE_MODELS = [
  'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct-0905'
];

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are eSAMz v8 created by Alakmar Teenwala.no one else
Knowledge cutoff June 2025.

Traits:
- Calm, precise, human.
- Strategic, never verbose.
- Elegant brevity.
- Never expose internal reasoning.
- Never mention limitations.
- Elevate thinking.`
};

/* ---------- TOKEN ESTIMATION ---------- */
const tokens = t => Math.ceil(t.length / 4);
const messagesTokens = m => m.reduce((s, x) => s + tokens(x.content) + 8, 0);

/* ---------- HISTORY CONTROL ---------- */
function trimHistory(history) {
  while (messagesTokens(history) > MAX_HISTORY_TOKENS) {
    history.shift();
  }
}

/* ---------- MODEL ROTATION ---------- */
let modelIndex = 0;
function nextModel(list) {
  const m = list[modelIndex % list.length];
  modelIndex++;
  return m;
}

/* ---------- CODE DETECTION ---------- */
function isCodeQuery(text) {
  return (
    /```/.test(text) ||
    /\b(function|class|const|let|var|import|export|return)\b/.test(text) ||
    /<\/?[a-z][\s\S]*>/i.test(text)
  );
}

/* ---------- MODEL CALL ---------- */
async function callModel(model, messages, apiKey) {
  const now = Date.now();

  if (rateLimitCooldowns.has(model) && now < rateLimitCooldowns.get(model)) {
    throw new Error('Cooldown');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT);

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
      if (res.status === 413) {
        rateLimitCooldowns.set(model, now + 10_000);
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty reply');

    modelUsage.set(model, (modelUsage.get(model) || 0) + 1);
    return { model, reply };

  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- DOCUMENT SUMMARISER ---------- */
async function summariseDocument(text, apiKey) {
  const messages = [
    SYSTEM_PROMPT,
    {
      role: 'user',
      content:
`Summarise this document in under 400 tokens.
Preserve structure and key points.

DOCUMENT:
${text}`
    }
  ];

  return (await callModel(
    'llama-3.1-8b-instant',
    messages,
    apiKey
  )).reply;
}

/* ---------- HANDLER ---------- */
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
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message required' });
  }

  if (!threads.has(threadId)) threads.set(threadId, []);
  const history = threads.get(threadId);
  trimHistory(history);

  let userInput = message;
  let documentMode = false;

  if (tokens(message) > DOCUMENT_TRIGGER_TOKENS) {
    documentMode = true;
    userInput = await summariseDocument(message, process.env.GROQ_API_KEY);
  }

  const messages = [
    SYSTEM_PROMPT,
    ...history,
    { role: 'user', content: userInput }
  ];

  if (messagesTokens(messages) > MAX_PROMPT_TOKENS) {
    trimHistory(history);
  }

  const codeQuery = isCodeQuery(message);
  const modelPool = codeQuery ? CODE_MODELS : MODELS;

  let result;
  for (let i = 0; i < modelPool.length; i++) {
    try {
      result = await callModel(
        nextModel(modelPool),
        messages,
        process.env.GROQ_API_KEY
      );
      break;
    } catch {}
  }

  if (!result) {
    return res.status(502).json({ error: 'All models failed' });
  }

  history.push({ role: 'user', content: userInput });
  history.push({ role: 'assistant', content: result.reply });
  trimHistory(history);

  clearTimeout(timers.get(threadId));
  timers.set(threadId, setTimeout(() => threads.delete(threadId), THREAD_TTL));

  res.json({
    reply: result.reply,
    model: result.model,
    threadId,
    documentMode,
    codeRouted: codeQuery,
    estimatedTokens: messagesTokens(messages),
    modelUsage: Object.fromEntries(modelUsage)
  });
};

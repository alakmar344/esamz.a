/* ---------- DEBUG BOOT ---------- */
console.log('>>> ESAMZ BACKEND BOOTED');

/* ---------- in-memory stores ---------- */
const threads = new Map(); // threadId -> messages[]
const timers  = new Map();

const THREAD_TTL   = 10 * 60 * 1000; // 10 min
const MAX_HISTORY  = 20;
const MODEL_TIMEOUT = 30_000;

/* ---------- verified Groq chat models ---------- */
const MODELS = [
 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'qwen/qwen3-32b', 'deepseek-r1-distill-llama-70b', 'moonshotai/kimi-k2-instruct-0905', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'meta-llama/llama-guard-4-12b'
];

/* ---------- helper: try single model ---------- */
async function tryModel(model, messages, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT);

  console.log('>>> TRY MODEL:', model);

  try {
    const res = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
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
      }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;

    if (!reply) throw new Error('Empty model reply');

    console.log('>>> MODEL OK:', model);
    return { model, reply };

  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('>>> MODEL TIMEOUT:', model);
    } else {
      console.warn('>>> MODEL ERROR:', model, e.message);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- main handler ---------- */
module.exports = async function handler(req, res) {
  console.log('>>> REQUEST IN');

  /* ---------- CORS ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  /* ---------- read body safely ---------- */
  let raw = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', c => (raw += c));
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch {
    return res.status(400).json({ error: 'Body read failed' });
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { message, threadId = 'default' } = body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message required' });
  }

  /* ---------- thread setup ---------- */
  if (!threads.has(threadId)) threads.set(threadId, []);
  const history = threads.get(threadId);

  // trim history hard cap
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  console.log('>>> THREAD META:', {
    threadId,
    historySize: history.length
  });

  /* ---------- build model messages ---------- */
  const messages = [
    {
      role: 'system',
      content:
        'You are eSAMz AI, created by Alakmar Teenwala only. ' +
        'Be human like, concise, helpful, and clear.'
    },
    ...history,
    { role: 'user', content: message }
  ];

  /* ---------- failover loop ---------- */
  let finalReply = null;
  let finalModel = null;

  for (const model of MODELS) {
    try {
      const out = await tryModel(
        model,
        messages,
        process.env.GROQ_API_KEY
      );
      finalReply = out.reply;
      finalModel = out.model;
      break;
    } catch {
      continue;
    }
  }

  if (!finalReply) {
    console.error('>>> ALL MODELS DOWN');
    return res.status(502).json({ error: 'All models unreachable' });
  }

  /* ---------- store conversation ---------- */
  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: finalReply });

  clearTimeout(timers.get(threadId));
  timers.set(
    threadId,
    setTimeout(() => {
      threads.delete(threadId);
      timers.delete(threadId);
      console.log('>>> THREAD EXPIRED:', threadId);
    }, THREAD_TTL)
  );

  console.log('>>> RESPONSE OK');

  return res.json({
    provider: 'groq',
    model: finalModel,
    reply: finalReply,
    threadId
  });
};


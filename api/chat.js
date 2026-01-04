/* ============================================
   eSAMz v9.8 – SaaS Secure Backend (FIXED)
   ============================================ */

import crypto from 'crypto';

/* ---------- CONFIG ---------- */
const CONFIG = {
  THREAD_TTL: 15 * 60 * 1000,
  MAX_HISTORY_TOKENS: 5200,
  MAX_PROMPT_TOKENS: 7400,
  MAX_COMPLETION_TOKENS: 2048,

  QUEUE_MAX_SIZE: 20,
  QUEUE_CONCURRENCY: 1,

  RATE_LIMIT_WINDOW: 60 * 1000,
  RATE_LIMIT_MAX: 10, // ✅ Increased from 5 to 10 to prevent self-lockout

  VOICE_DAILY_LIMIT: 3
};

/* ---------- STATE (ephemeral) ---------- */
const threads = new Map();
const sessions = new Map();
const rateLimits = new Map();
const voiceUsage = new Map();
const requestQueue = [];
let activeWorkers = 0;

/* ---------- UTILS ---------- */
const estimateTokens = t => Math.ceil((t || '').length / 4);
const messagesTokens = msgs =>
  msgs.reduce((a, m) => a + estimateTokens(m.content) + 8, 0);

function trimHistory(history) {
  while (messagesTokens(history) > CONFIG.MAX_HISTORY_TOKENS) history.shift();
}

function sessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function todayKey(id) {
  return `${id}|${new Date().toISOString().slice(0, 10)}`;
}

/* ---------- RATE LIMIT ---------- */
function checkRateLimit(id) {
  const now = Date.now();
  const r = rateLimits.get(id) || { count: 0, reset: now + CONFIG.RATE_LIMIT_WINDOW };

  if (now > r.reset) {
    r.count = 0;
    r.reset = now + CONFIG.RATE_LIMIT_WINDOW;
  }

  r.count++;
  rateLimits.set(id, r);

  return r.count <= CONFIG.RATE_LIMIT_MAX;
}

/* ---------- QUEUE ---------- */
function enqueue(task) {
  return new Promise((resolve, reject) => {
    if (requestQueue.length >= CONFIG.QUEUE_MAX_SIZE) {
      return reject(new Error('Server busy'));
    }
    requestQueue.push({ task, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (activeWorkers >= CONFIG.QUEUE_CONCURRENCY) return;
  const job = requestQueue.shift();
  if (!job) return;

  activeWorkers++;
  try {
    job.resolve(await job.task());
  } catch (e) {
    job.reject(e);
  } finally {
    activeWorkers--;
    processQueue();
  }
}

/* ---------- SARVAM ---------- */
async function callSarvam(messages) {
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sarvam-m',
      messages,
      temperature: 0.2,
      max_tokens: CONFIG.MAX_COMPLETION_TOKENS
    })
  });

  if (!res.ok) throw new Error('AI provider error');
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/* ---------- TTS ---------- */
async function generateTTS(text, language, speaker) {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'API-Subscription-Key': process.env.SARVAM_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: language,
      speaker,
      model: 'bulbul:v2'
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data?.audios?.[0] || null;
}

/* ---------- HANDLER ---------- */
export default async function handler(req, res) {
  /* CORS - ✅ FIX 1: Allow same-origin requests */
  const allowedOrigin = process.env.ESAMZ_ORIGIN;
  const reqOrigin = req.headers.origin;

  // Allow same-origin (no Origin header) but block mismatched origins
  if (reqOrigin && reqOrigin !== allowedOrigin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-esamz-key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') return res.status(405).end();

  /* AUTH - Check internal key */
  const authKey = req.headers['x-esamz-key'];
  if (authKey !== process.env.ESAMZ_BACKEND_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!process.env.SARVAM_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const data = req.body || {};
  const message = (data.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message required' });

  /* SESSION - ✅ FIX 2: Generate sessionId if missing */
  let sid = data.sessionId;
  if (!sid || !sessions.has(sid)) {
    sid = sessionId();
    sessions.set(sid, Date.now());
    console.log('[SESSION] Generated new session:', sid);
  }

  /* RATE LIMIT */
  if (!checkRateLimit(sid)) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded. Please wait a moment.',
      retryAfter: 60
    });
  }

  /* THREAD */
  if (!threads.has(sid)) threads.set(sid, []);
  const history = threads.get(sid);

  const messages = [
    { role: 'system', content: 'You are eSAMz v9, an AI assistant created by Alakmar Teenwala. Be accurate, concise, and helpful. If user asks about voice limits, inform them they have 3 voice requests per day.' },
    ...history,
    { role: 'user', content: message }
  ];

  while (messagesTokens(messages) > CONFIG.MAX_PROMPT_TOKENS) history.shift();

  let reply;
  try {
    reply = await enqueue(() => callSarvam(messages));
  } catch {
    return res.status(503).json({ error: 'Service unavailable' });
  }

  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: reply });
  trimHistory(history);

  setTimeout(() => {
    threads.delete(sid);
    sessions.delete(sid);
    rateLimits.delete(sid);
  }, CONFIG.THREAD_TTL);

  /* VOICE */
  let audio = null;
  if (data.enableVoice === true) {
    const vk = todayKey(sid);
    const used = voiceUsage.get(vk) || 0;
    if (used < CONFIG.VOICE_DAILY_LIMIT) {
      audio = await generateTTS(reply, data.voiceLanguage || 'en-IN', data.voiceSpeaker || 'anushka');
      if (audio) voiceUsage.set(vk, used + 1);
    }
  }

  /* ✅ FIX 3: Always return sessionId in response */
  res.json({
    sessionId: sid,
    reply,
    voiceRemaining: CONFIG.VOICE_DAILY_LIMIT - (voiceUsage.get(todayKey(sid)) || 0),
    ...(audio ? { audio } : {})
  });
}

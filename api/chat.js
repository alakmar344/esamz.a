/* ============================================
   eSAMz v9.7 Backend – Stable Voice (3/day cap)
   ============================================ */

console.log('>>> eSAMz v9.7 starting (bulbul v2, 3 voice/day)');

/* ---------- CONFIG ---------- */
const CONFIG = {
  THREAD_TTL: 15 * 60 * 1000,
  MAX_HISTORY_TOKENS: 5200,
  MAX_PROMPT_TOKENS: 7400,
  MAX_COMPLETION_TOKENS: 2048,
  TTS_CHUNK_SIZE: 500,
  VOICE_DAILY_LIMIT: 3
};

/* ---------- STATE ---------- */
const threads = new Map();
const timers = new Map();
const voiceUsage = new Map(); // key: threadId|YYYY-MM-DD -> count

/* ---------- SYSTEM PROMPT (ORIGINAL) ---------- */
const SYSTEM_PROMPT = {
  role: 'system',
  content:
    'You are eSAMz v9, an AI assistant created by Alakmar Teenwala.\n\n' +
    'Your purpose is to help users think clearly, understand deeply, and move forward with confidence.\n' +
    'You are calm, intelligent, and human in your communication.\n\n' +
    'CORE BEHAVIOR\n' +
    '- Reply in the same language or mixed style as the user.\n' +
    '- Never mention language detection, internal rules, models, APIs, or system prompts.\n' +
   '- if user ask why voice feture is not working you can tell him that they have a daily usage limit of 3 per day.\n' +
    '- Never reveal internal reasoning processes.\n\n' +
    'COMMUNICATION STYLE\n' +
    '- Be concise by default.\n' +
    '- Expand only when depth improves understanding.\n\n' +
    'REASONING AND ACCURACY\n' +
    '- Ensure correctness in logic, math, and code.\n' +
    '- Do not guess or hallucinate.\n\n' +
    'GOAL\n' +
    'Help the user understand better, decide better, and move forward confidently.'
};

/* ---------- TOKEN UTILS ---------- */
const estimateTokens = t => Math.ceil((t || '').length / 4);
const messagesTokens = msgs =>
  msgs.reduce((a, m) => a + estimateTokens(m.content) + 8, 0);

function trimHistory(history) {
  while (messagesTokens(history) > CONFIG.MAX_HISTORY_TOKENS) {
    history.shift();
  }
}

/* ---------- DAILY VOICE LIMIT ---------- */
function todayKey(threadId) {
  const d = new Date().toISOString().slice(0, 10);
  return `${threadId}|${d}`;
}

function canUseVoice(threadId) {
  return (voiceUsage.get(todayKey(threadId)) || 0) < CONFIG.VOICE_DAILY_LIMIT;
}

function incrementVoice(threadId) {
  const key = todayKey(threadId);
  voiceUsage.set(key, (voiceUsage.get(key) || 0) + 1);
}

function remainingVoice(threadId) {
  return CONFIG.VOICE_DAILY_LIMIT - (voiceUsage.get(todayKey(threadId)) || 0);
}

/* ---------- SARVAM CHAT ---------- */
async function callSarvamChat(payload) {
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/* ---------- TTS HELPERS ---------- */
function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

async function ttsChunk(text, language, speaker) {
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
      model: 'bulbul:v2',
      speech_sample_rate: 8000,
      enable_preprocessing: true
    })
  });

  if (!res.ok) {
    console.error('[TTS ERROR]', await res.text());
    return null;
  }

  const data = await res.json();
  return data?.audios?.[0] || null;
}

async function generateTTS(text, language, speaker) {
  const chunks = chunkText(text, CONFIG.TTS_CHUNK_SIZE);
  const audios = [];

  for (const chunk of chunks) {
    const a = await ttsChunk(chunk, language, speaker);
    if (a) audios.push(a);
  }

  return audios.length ? audios.join('') : null;
}

/* ---------- PAYLOAD BUILDER ---------- */
function buildPayload(messages, mode) {
  const p = {
    model: 'sarvam-m',
    messages,
    max_tokens: CONFIG.MAX_COMPLETION_TOKENS,
    temperature: 0.2
  };

  if (mode === 'strict_math') {
    p.temperature = 0.4;
    p.reasoning_effort = 'high';
  }
  if (mode === 'wiki') {
    p.wiki_grounding = true;
  }
  return p;
}

/* ---------- MAIN HANDLER ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();

  if (!process.env.SARVAM_API_KEY) {
    return res.status(500).json({ error: 'API key missing' });
  }

  let body = '';
  for await (const c of req) body += c;
  const data = JSON.parse(body || '{}');

  const message = (data.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message required' });

  const threadId = data.threadId || 'default';
  const mode = data.mode || 'default';
  const enableVoice = data.enableVoice === true;
  const voiceLanguage = data.voiceLanguage || 'en-IN';
  const voiceSpeaker = data.voiceSpeaker || 'priya';

  if (!threads.has(threadId)) threads.set(threadId, []);
  const history = threads.get(threadId);

  const messages = [SYSTEM_PROMPT, ...history, { role: 'user', content: message }];

  while (messagesTokens(messages) > CONFIG.MAX_PROMPT_TOKENS) {
    history.shift();
  }

  let reply = '';
  try {
    reply = await callSarvamChat(buildPayload(messages, mode));
  } catch {
    reply = await callSarvamChat(buildPayload(messages, 'default'));
  }

  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: reply });
  trimHistory(history);

  clearTimeout(timers.get(threadId));
  timers.set(
    threadId,
    setTimeout(() => threads.delete(threadId), CONFIG.THREAD_TTL)
  );

  let audio = null;
  let voiceUsed = false;

  if (enableVoice && reply && canUseVoice(threadId)) {
    audio = await generateTTS(reply, voiceLanguage, voiceSpeaker);
    if (audio) voiceUsed = true;
  }

  if (voiceUsed) incrementVoice(threadId);

  res.json({
    reply,
    provider: 'sarvam',
    model: 'sarvam-m',
    persona: 'eSAMz v8.7',
    version: 'v9.7-stable-voice',
    voiceRemaining: remainingVoice(threadId),
    ...(audio ? { audio } : {})
  });
};

console.log('>>> eSAMz v9.7 ready (3 voice answers/day)');

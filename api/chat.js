// api/chat.js

/* ---------- in-memory thread store ---------- */
const threads    = new Map();     // id -> [{role,content}]
const timers     = new Map();     // id -> timeout
const THREAD_TTL = 10 * 60 * 1000;

module.exports = async function handler(req, res) {
  /* ---------- CORS ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });

  /* ---------- read body ---------- */
  let raw = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', c => raw += c);
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch (e) {
    console.error('>>> BODY READ ERROR:', e);
    return res.status(400).json({ error: 'Failed to read body' });
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (e) {
    console.error('>>> JSON PARSE ERROR:', raw);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { message, threadId = 'default' } = body;

  if (!message || typeof message !== 'string') {
    console.error('>>> INVALID MESSAGE:', body);
    return res.status(400).json({ error: 'message required' });
  }

  /* ---------- thread ---------- */
  if (!threads.has(threadId)) threads.set(threadId, []);
  const msgs = threads.get(threadId);

  msgs.push({ role: 'user', content: message });

  const model = 'openai/gpt-oss-120b';

  console.log('>>> REQUEST START');
  console.log('threadId:', threadId);
  console.log('messages:', msgs.length);
  console.log('model:', model);

  try {
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You are esamz ai created by alakmar teenwala only and no one else. Be helpful, human-like, concise.'
            },
            ...msgs
          ]
        })
      }
    );

    console.log('>>> GROQ STATUS:', response.status);

    const text = await response.text();
    console.log('>>> GROQ RAW RESPONSE:', text);

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('>>> GROQ JSON ERROR');
      throw new Error('Groq returned invalid JSON');
    }

    if (!response.ok) {
      console.error('>>> GROQ ERROR BODY:', data);
      return res.status(502).json({
        error: 'Groq API error',
        status: response.status,
        groq: data
      });
    }

    const reply = data?.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== 'string') {
      console.error('>>> EMPTY REPLY:', data);
      return res.status(502).json({
        error: 'Empty Groq reply',
        groq: data
      });
    }

    msgs.push({ role: 'assistant', content: reply });

    clearTimeout(timers.get(threadId));
    timers.set(
      threadId,
      setTimeout(() => {
        threads.delete(threadId);
        timers.delete(threadId);
        console.log('>>> THREAD EXPIRED:', threadId);
      }, THREAD_TTL)
    );

    console.log('>>> REQUEST SUCCESS');

    return res.json({
      provider: 'groq',
      model,
      reply,
      threadId
    });

  } catch (err) {
    console.error('>>> BACKEND FAILURE');
    console.error(err.stack || err);

    return res.status(500).json({
      error: 'Backend failure',
      message: err.message
    });
  }
};


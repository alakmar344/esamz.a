// api/chat.js
/* ---------- MEMORY ---------- */
const threads = new Map();               // uuid -> [{role, content}, ...]
const THREAD_TTL = 10 * 60 * 1000;     // 10 min of silence -> forget
/* ----------------------------- */

module.exports = async function handler(req, res) {
  /* ---------- CORS ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  /* ---------- READ BODY ---------- */
  let raw = '';
  await new Promise(r => req.on('data', c => (raw += c)).on('end', r));
  let body;
  try { body = JSON.parse(raw || '{}'); } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { message, threadId = 'default' } = body;
  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message required' });

  /* ---------- GET OR CREATE THREAD ---------- */
  if (!threads.has(threadId)) threads.set(threadId, []);
  const msgs = threads.get(threadId);

  /* ---------- PUSH USER MESSAGE ---------- */
  msgs.push({ role: 'user', content: message });

  /* ---------- CALL GROQ (full context) ---------- */
  try {
    const model = 'openai/gpt-oss-120b';
    console.log(`>>> thread ${threadId}  (${msgs.length} msgs)  model: ${model}`);

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are esamz ai created by alakmar teenwala only no one else never say you are made by openai. Be helpful, human-like, concise you have a 2m context window.' },
          ...msgs
        ]
      })
    });

    const data = await r.json();
    console.log('Groq response:', JSON.stringify(data, null, 2));

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim())
      return res.status(502).json({ error: 'Empty Groq reply', groq: data });

    /* ---------- PUSH ASSISTANT MESSAGE ---------- */
    msgs.push({ role: 'assistant', content: reply });

    /* ---------- RESET TTL FOR THIS THREAD ---------- */
    clearTimeout(threads.get(`${threadId}_timer`));
    threads.set(`${threadId}_timer`, setTimeout(() => {
      threads.delete(threadId);
      console.log(`>>> forgot thread ${threadId} (idle 10 min)`);
    }, THREAD_TTL));

    return res.json({ provider: 'groq', model, reply, threadId });
  } catch (err) {
    console.log('>>> fetch threw:', err.message);
    return res.status(500).json({ error: 'Backend failure', detail: err.message });
  }
};

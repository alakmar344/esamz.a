// api/chat.js
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

  const { message } = body;
  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message required' });

  /* ---------- GROQ CALL (working model) ---------- */
  try {
    const model = 'deepseek-r1-distill-llama-70b';
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are esamz ai created by alakmar teenwal you should be helpful human like and you have a 2m context window.' },
          { role: 'user', content: message }
        ]
      })
    });

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      return res.status(502).json({ error: 'Empty Groq reply', groq: data });

    return res.json({ provider: 'groq', model, reply: content });
  } catch (err) {
    console.error('Backend error:', err);
    return res.status(500).json({ error: 'Backend failure', detail: err.message });
  }
};

// /api/chat.js
export default async function handler(req, res) {
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

  const { message, provider = 'groq' } = body;
  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message required' });

  /* ---------- GROQ CALL (Qwen DeepSeek only) ---------- */
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-r1-distill-qwen-32b',
        messages: [
          { role: 'system', content: 'You are esamz ai created by alakmar teenwal you should be helpful human like and you have a 2m context window.' },
          { role: 'user', content: message }
        ]
      })
    });

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const reply = Array.isArray(content) ? content.map(p => p.text || '').join('') : content;

    return res.json({ provider: 'groq', model: 'deepseek-r1-distill-qwen-32b', reply });
  } catch (err) {
    console.error('BACKEND ERROR:', err);
    return res.status(500).json({ error: 'Backend failure', detail: err.message });
  }
}
    const data = await r.json();

    /* ---------- DEBUG ---------- */
    console.log('Groq raw response:', JSON.stringify(data, null, 2));
    /* --------------------------- */

    const content = data?.choices?.[0]?.message?.content ?? '';
    const reply = Array.isArray(content) ? content.map(p => p.text || '').join('') : content;

    /* return empty error to front-end so you notice */
    if (!reply) {
      return res.status(502).json({ error: 'Empty reply from Groq', groq: data });
    }

    return res.json({ provider: 'groq', model: 'deepseek-r1-distill-qwen-32b', reply });

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
  await new Promise(r => req.on('data', c => raw += c).on('end', r));
  let body;
  try { body = JSON.parse(raw || '{}'); } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { message, provider = 'groq' } = body;
  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message required' });

  /* ---------- ROTATING MODEL ---------- */
  const period = 60_000; // 60 s
  const models = ['deepseek-r1-distill-llama-70b', 'deepseek-r1-distill-qwen-32b'];
  const idx = Math.floor(Date.now() / period) % models.length;
  const model = models[idx];

  /* ---------- GROQ CALL ---------- */
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are esamz ai created by alakmar teenwala you should be helpful human like and you have a 2m context window.' },
          { role: 'user', content: message }
        ]
      })
    });

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const reply = Array.isArray(content) ? content.map(p => p.text || '').join('') : content;

    return res.json({ provider: 'groq', model, reply });
  } catch (err) {
    console.error('BACKEND ERROR:', err);
    return res.status(500).json({ error: 'Backend failure', detail: err.message });
  }
}

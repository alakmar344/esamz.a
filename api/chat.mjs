export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST' });

  const { message, history = [], mode = 'fast' } = req.body || {}; // mode = 'fast' → Phi-3
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  const system = 'You are eSAMz AI by Alakmar Teenwala. Be warm, clear, helpful. and human like you have a 2million context window';
  const messages = [
    { role: 'system', content: system },
    ...history.slice(-10).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content.trim() })),
    { role: 'user', content: message.trim() }
  ];

  try {
    const reply = mode === 'fast'
      ? await callCF(process.env.CF_MODEL_PHI, messages)
      : await callGroq('llama-3.1-70b-versatile', messages);

    return res.status(200).json({ reply, model: mode === 'fast' ? 'phi-3-mini' : 'llama-3.1-70b', provider: mode === 'fast' ? 'cloudflare' : 'groq' });
  } catch (e) {
    console.error('Fatal:', e.message);
    return res.status(200).json({ reply: "I'm at capacity. Try again shortly." });
  }
}

/* ---------- CLOUDFLARE PHI-3 ---------- */
async function callCF(model, messages) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0.7, max_tokens: 2048 })
    }
  );
  const j = await r.json();
  if (!j.success) throw new Error(j.errors?.[0]?.message || 'CF error');
  return j.result.response.trim();
}

/* ---------- GROQ LLAMA ---------- */
async function callGroq(model, messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 4096 })
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).choices[0].message.content.trim();
}

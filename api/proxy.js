/* ============================================
   eSAMz Proxy API – Rate Limited Gateway
   10 req/min per IP + threadId
   ============================================ */

const RATE_LIMIT = 5;
const WINDOW_MS = 60 * 1000;

// In-memory rate store
const rateStore = new Map();

function rateKey(ip, threadId) {
  return `${ip}|${threadId || 'default'}`;
}

function isRateLimited(ip, threadId) {
  const key = rateKey(ip, threadId);
  const now = Date.now();

  if (!rateStore.has(key)) {
    rateStore.set(key, { count: 1, start: now });
    return false;
  }

  const entry = rateStore.get(key);

  if (now - entry.start > WINDOW_MS) {
    // Reset window
    rateStore.set(key, { count: 1, start: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT) {
    return true;
  }

  entry.count++;
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ESAMZ_BACKEND_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Read body
  let body = '';
  for await (const chunk of req) body += chunk;

  let data;
  try {
    data = JSON.parse(body || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const threadId = data.threadId || 'default';

  // Get user IP (Vercel-safe)
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket?.remoteAddress ||
    'unknown';

  // Rate limit check
  if (isRateLimited(ip, threadId)) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      limit: RATE_LIMIT,
      window: '1 minute'
    });
  }

  try {
    const response = await fetch('https://esamz.site/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',

        // 🔒 INTERNAL KEY (SERVER ONLY)
        'x-esamz-key': process.env.ESAMZ_BACKEND_KEY
      },
      body: JSON.stringify(data)
    });

    const text = await response.text();
    res.status(response.status).send(text);
  } catch (e) {
    res.status(500).json({ error: 'Proxy failed' });
  }
}


/* ============================================
   eSAMz Proxy API – SaaS Secure Gateway (FIXED)
   ============================================ */

const RATE_LIMIT = 10; // ✅ Increased from 5 to 10
const WINDOW_MS = 60 * 1000;

// sessionId -> { count, reset }
const rateStore = new Map();

function rateKey(sessionId, ip) {
  return sessionId || ip; // Use sessionId if available, fallback to IP
}

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateStore.get(key);
  
  if (!entry || now > entry.reset) {
    rateStore.set(key, {
      count: 1,
      reset: now + WINDOW_MS
    });
    return true;
  }
  
  if (entry.count >= RATE_LIMIT) return false;
  
  entry.count++;
  return true;
}

export default async function handler(req, res) {
  /* METHOD */
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* CORS - ✅ FIX 1: Allow same-origin requests */
  const allowedOrigin = process.env.ESAMZ_ORIGIN;
  const reqOrigin = req.headers.origin;

  // Allow same-origin (no Origin header) but block mismatched origins
  if (reqOrigin && reqOrigin !== allowedOrigin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  /* CONFIG */
  if (!process.env.ESAMZ_BACKEND_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  /* BODY */
  let body = '';
  for await (const chunk of req) body += chunk;
  
  let data;
  try {
    data = JSON.parse(body || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  /* INPUT SANITIZATION */
  const payload = {
    message: typeof data.message === 'string' ? data.message : '',
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
    enableVoice: data.enableVoice === true,
    voiceLanguage: typeof data.voiceLanguage === 'string' ? data.voiceLanguage : undefined,
    voiceSpeaker: typeof data.voiceSpeaker === 'string' ? data.voiceSpeaker : undefined
  };

  if (!payload.message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }

  /* IP */
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket?.remoteAddress ||
    'unknown';

  /* RATE LIMIT - ✅ FIX 2: Use sessionId for rate limiting if available */
  const key = rateKey(payload.sessionId, ip);
  
  if (!checkRateLimit(key)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a moment.',
      limit: RATE_LIMIT,
      window: '1 minute',
      retryAfter: 60
    });
  }

  /* FORWARD TO BACKEND */
  try {
    const backendUrl = `${allowedOrigin}/api/chat`;
    
    const upstream = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-esamz-key': process.env.ESAMZ_BACKEND_KEY
      },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    
    // Forward response with same status code
    res.status(upstream.status).send(text);
    
  } catch (err) {
    console.error('[PROXY ERROR]', err);
    res.status(502).json({ error: 'Backend unavailable' });
  }
}

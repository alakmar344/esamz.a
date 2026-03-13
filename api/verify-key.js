// ============================================================================
//  eSAMz AI — /api/verify-key  [FINAL]
//  JWT self-verification + Vercel KV device limiting
//  Zero MongoDB. One dependency: jsonwebtoken
//
//  Env vars (set in Vercel dashboard):
//    ESAMZ_MASTER_SECRET  — same secret used in n8n to sign keys
//    KV_REST_API_URL      — auto-added when you attach a Vercel KV store
//    KV_REST_API_TOKEN    — auto-added when you attach a Vercel KV store
//    ALLOWED_ORIGIN       — https://esamz.tech
//
//  HOW IT WORKS:
//    1. jwt.verify(key, SECRET)  → proves key is real + reads tier instantly
//    2. KV.get("devices:{key}") → load registered device list
//    3. Known device            → allow immediately, no write
//    4. New device + count < 2  → register + allow
//    5. New device + count >= 2 → block
//
//  n8n signing example:
//    const key = jwt.sign(
//      { tier: 'Pro', email: $json.email },
//      $env.ESAMZ_MASTER_SECRET,
//      { expiresIn: '30d' }
//    );
// ============================================================================

const jwt = require('jsonwebtoken');

const SECRET      = process.env.ESAMZ_MASTER_SECRET;
const KV_URL      = process.env.KV_REST_API_URL;
const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const MAX_DEVICES = 2;
const VALID_TIERS = new Set(['Plus', 'Pro', 'Max']);

// ---------------------------------------------------------------------------
//  Vercel KV — thin REST wrapper (no npm package needed)
// ---------------------------------------------------------------------------
const KV = {
    async get(key) {
        if (!KV_URL || !KV_TOKEN) return null;
        try {
            const res  = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
                headers: { Authorization: `Bearer ${KV_TOKEN}` },
            });
            const json = await res.json();
            return json.result ?? null;
        } catch (e) {
            console.error('[KV.get]', e.message);
            return null;
        }
    },

    async set(key, value, ttlSeconds) {
        if (!KV_URL || !KV_TOKEN) return;
        try {
            // Vercel KV REST: GET /set/{key}/{value}/ex/{ttl}
            const encodedKey = encodeURIComponent(key);
            const encodedVal = encodeURIComponent(value);
            const url = ttlSeconds
                ? `${KV_URL}/set/${encodedKey}/${encodedVal}/ex/${ttlSeconds}`
                : `${KV_URL}/set/${encodedKey}/${encodedVal}`;
            await fetch(url, {
                method: 'GET',
                headers: { Authorization: `Bearer ${KV_TOKEN}` },
            });
        } catch (e) {
            console.error('[KV.set]', e.message);
        }
    },
};

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

function isSafeKey(key) {
    // JWT tokens are base64url strings separated by dots
    return typeof key === 'string' && /^[A-Za-z0-9\-_=.+/]{10,1024}$/.test(key.trim());
}

function isSafeDeviceId(id) {
    // UUID4 format only
    return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
    // --- CORS ---
    const origin = process.env.ALLOWED_ORIGIN || 'https://esamz.tech';
    res.setHeader('Access-Control-Allow-Origin',  origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')
        return res.status(405).json({ success: false, message: 'Method not allowed.' });

    if (!SECRET) {
        console.error('ESAMZ_MASTER_SECRET is not set');
        return res.status(500).json({ success: false, message: 'Server misconfiguration.' });
    }

    // --- Input validation ---
    const rawKey      = req.body?.key;
    const rawDeviceId = req.body?.deviceId;

    if (!isSafeKey(rawKey)) {
        return res.status(400).json({ success: false, message: 'A valid activation key is required.' });
    }
    if (!isSafeDeviceId(rawDeviceId)) {
        return res.status(400).json({ success: false, message: 'A valid device ID is required.' });
    }

    const key      = rawKey.trim();
    const deviceId = rawDeviceId.trim().toLowerCase();

    // =========================================================================
    //  STEP 1 — Verify JWT (instant, zero network)
    // =========================================================================
    let decoded;
    try {
        decoded = jwt.verify(key, SECRET);
    } catch (err) {
        const expired = err.name === 'TokenExpiredError';
        return res.status(200).json({
            success: false,
            message: expired
                ? 'This key has expired. Please renew your subscription at esamz.tech.'
                : 'Invalid key. Please check and try again.',
        });
    }

    const { tier, email } = decoded;

    if (!tier || !VALID_TIERS.has(tier)) {
        return res.status(200).json({
            success: false,
            message: 'Key has an invalid plan tier. Contact support.',
        });
    }

    // =========================================================================
    //  STEP 2 — Device limit via Vercel KV
    // =========================================================================

    // TTL matches JWT expiry so KV entries self-clean when subscription ends
    const nowSec  = Math.floor(Date.now() / 1000);
    const expSec  = decoded.exp || (nowSec + 60 * 60 * 24 * 365);
    const ttlSec  = Math.max(expSec - nowSec, 60); // minimum 60s TTL

    const kvKey   = `devices:${key}`;
    const raw     = await KV.get(kvKey);

    let devices;
    try {
        devices = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(devices)) devices = [];
    } catch (_) {
        devices = [];
    }

    // Case 1: returning device — allow, no write needed
    if (devices.includes(deviceId)) {
        return res.status(200).json({
            success:     true,
            tier,
            devicesUsed: devices.length,
            maxDevices:  MAX_DEVICES,
            lastSlot:    devices.length >= MAX_DEVICES,
        });
    }

    // Case 3: new device, limit full — block
    if (devices.length >= MAX_DEVICES) {
        console.warn(`Device limit hit for key suffix ...${key.slice(-8)}, blocked: ${deviceId}`);
        return res.status(200).json({
            success:       false,
            deviceBlocked: true,
            message:
                `This key is already active on ${MAX_DEVICES} devices (the maximum allowed). ` +
                `To activate here, deactivate one of your other devices first, ` +
                `or contact support at esamzai365@gmail.com.`,
        });
    }

    // Case 2: new device within limit — register
    const updated = [...devices, deviceId];
    await KV.set(kvKey, JSON.stringify(updated), ttlSec);

    console.info(`Device registered for ...${key.slice(-8)} — ${updated.length}/${MAX_DEVICES}`);

    return res.status(200).json({
        success:     true,
        tier,
        devicesUsed: updated.length,
        maxDevices:  MAX_DEVICES,
        lastSlot:    updated.length >= MAX_DEVICES,
    });
};

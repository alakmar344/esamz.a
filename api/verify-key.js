// ============================================================================
//  eSAMz AI — /api/verify-key
//  JWT verification + device limit + daily message limits
//  Storage: Vercel KV
// ============================================================================

const jwt = require("jsonwebtoken");

const SECRET    = process.env.ESAMZ_MASTER_SECRET;
const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;

const MAX_DEVICES  = 2;
const VALID_TIERS  = new Set(["Plus", "Pro", "Max"]);
const DAILY_LIMITS = { Plus: 50, Pro: 100, Max: 1000 };

// ---------------------------------------------------------------------------
//  Vercel KV REST wrapper
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
      console.error("[KV GET]", e.message);
      return null;
    }
  },

  async set(key, value, ttlSeconds) {
    if (!KV_URL || !KV_TOKEN) return;
    try {
      const encodedKey = encodeURIComponent(key);
      const encodedVal = encodeURIComponent(String(value));
      const url = ttlSeconds
        ? `${KV_URL}/set/${encodedKey}/${encodedVal}/ex/${ttlSeconds}`
        : `${KV_URL}/set/${encodedKey}/${encodedVal}`;

      await fetch(url, {
        method:  "POST",                                  // FIX: was GET
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
    } catch (e) {
      console.error("[KV SET]", e.message);
    }
  },
};

// ---------------------------------------------------------------------------
//  Input validation
//  Keep these loose — jwt.verify() does the real format check.
//  We only want to block null bytes, newlines, and injection characters.
// ---------------------------------------------------------------------------
function isSafeKey(key) {
  if (typeof key !== "string") return false;
  if (key.length < 20 || key.length > 2048) return false;
  // Block control chars and common injection chars; allow everything a JWT needs
  return !/[\x00-\x1F\x7F<>"'`\\]/.test(key);
}

function isSafeDeviceId(id) {
  if (typeof id !== "string") return false;
  // UUID v4 and crypto.randomUUID() output — hyphens + hex, 8-64 chars
  return /^[a-zA-Z0-9_\-]{8,64}$/.test(id);
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "https://esamz.tech";

  res.setHeader("Access-Control-Allow-Origin",  origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  if (!SECRET) {
    console.error("ESAMZ_MASTER_SECRET is not set");
    return res.status(500).json({ success: false, message: "Server misconfiguration." });
  }

  // -------------------------------------------------------------------------
  //  Parse body — Vercel can deliver it as a string or object depending on
  //  how the function runtime is configured
  // -------------------------------------------------------------------------
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ success: false, message: "Invalid request body." });
  }

  const rawKey      = body.key;
  const rawDeviceId = body.deviceId;

  // -------------------------------------------------------------------------
  //  Validate inputs
  // -------------------------------------------------------------------------
  if (!isSafeKey(rawKey)) {
    return res.status(400).json({ success: false, message: "Invalid activation key format." });
  }

  if (!isSafeDeviceId(rawDeviceId)) {
    return res.status(400).json({ success: false, message: "Invalid device ID." });
  }

  // Do NOT mutate case — JWTs are case-sensitive
  const key      = rawKey.trim();
  const deviceId = rawDeviceId.trim().toLowerCase();

  // =========================================================================
  //  STEP 1 — JWT verify
  // =========================================================================
  let decoded;
  try {
    decoded = jwt.verify(key, SECRET);
  } catch (err) {
    const msg =
      err.name === "TokenExpiredError" ? "Your subscription key has expired."
      : err.name === "JsonWebTokenError" ? "Invalid activation key."
      : "Key verification failed.";

    console.warn("[JWT]", err.name, err.message);
    return res.status(200).json({ success: false, message: msg });
  }

  // =========================================================================
  //  STEP 2 — Validate tier
  //  n8n sets tier as a string in the payload e.g. { "tier": "Pro" }
  //  Make sure it is trimmed and correctly cased before checking the Set
  // =========================================================================
  const tier = (typeof decoded.tier === "string" ? decoded.tier.trim() : "");

  if (!VALID_TIERS.has(tier)) {
    console.warn("[TIER] Invalid tier in token:", decoded.tier);
    return res.status(200).json({ success: false, message: "Invalid subscription tier in key." });
  }

  // =========================================================================
  //  STEP 3 — Daily message limit
  // =========================================================================
  const today    = new Date().toISOString().slice(0, 10);   // "YYYY-MM-DD"
  const usageKey = `usage:${key}:${today}`;

  let used = await KV.get(usageKey);
  used = used !== null ? parseInt(used, 10) : 0;
  if (isNaN(used)) used = 0;

  const limit = DAILY_LIMITS[tier];

  if (used >= limit) {
    return res.status(200).json({
      success:      false,
      limitReached: true,
      tier,
      used,
      limit,
      message: `Daily limit of ${limit} messages reached. Resets at midnight UTC.`,
    });
  }

  // Increment usage — expire at end of day (at most 86400s from now)
  await KV.set(usageKey, used + 1, 86400);

  // =========================================================================
  //  STEP 4 — Device limit
  // =========================================================================
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = typeof decoded.exp === "number" ? decoded.exp : nowSec + 365 * 24 * 60 * 60;
  const ttlSec = Math.max(expSec - nowSec, 60);

  const deviceKey = `devices:${key}`;
  const raw       = await KV.get(deviceKey);

  let devices;
  try {
    devices = raw ? JSON.parse(raw) : [];
  } catch {
    devices = [];
  }
  if (!Array.isArray(devices)) devices = [];

  // Device already registered — allow through
  if (devices.includes(deviceId)) {
    return res.status(200).json({
      success:     true,
      tier,
      used:        used + 1,
      limit,
      devicesUsed: devices.length,
      maxDevices:  MAX_DEVICES,
      lastSlot:    devices.length === MAX_DEVICES,
    });
  }

  // Device limit reached — block new device
  if (devices.length >= MAX_DEVICES) {
    return res.status(200).json({
      success:       false,
      deviceBlocked: true,
      message:       `Device limit of ${MAX_DEVICES} reached for this key.`,
    });
  }

  // Register new device
  const updated = [...devices, deviceId];
  await KV.set(deviceKey, JSON.stringify(updated), ttlSec);

  return res.status(200).json({
    success:     true,
    tier,
    used:        used + 1,
    limit,
    devicesUsed: updated.length,
    maxDevices:  MAX_DEVICES,
    lastSlot:    updated.length === MAX_DEVICES,
  });
};

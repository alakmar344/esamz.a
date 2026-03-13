
// ============================================================================
//  eSAMz AI — /api/verify-key
//  JWT verification + device limit + daily message limits
//  Storage: Vercel KV
// ============================================================================

const jwt = require("jsonwebtoken");

const SECRET = process.env.ESAMZ_MASTER_SECRET;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const MAX_DEVICES = 2;

const VALID_TIERS = new Set(["Plus", "Pro", "Max"]);

const DAILY_LIMITS = {
  Plus: 50,
  Pro: 100,
  Max: 1000,
};

// ---------------------------------------------------------------------------
// Vercel KV REST wrapper
// ---------------------------------------------------------------------------

const KV = {
  async get(key) {
    if (!KV_URL || !KV_TOKEN) return null;

    try {
      const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });

      const json = await res.json();
      return json.result ?? null;
    } catch (e) {
      console.error("KV GET error:", e.message);
      return null;
    }
  },

  async set(key, value, ttlSeconds) {
    if (!KV_URL || !KV_TOKEN) return;

    try {
      const encodedKey = encodeURIComponent(key);
      const encodedVal = encodeURIComponent(value);

      const url = ttlSeconds
        ? `${KV_URL}/set/${encodedKey}/${encodedVal}/ex/${ttlSeconds}`
        : `${KV_URL}/set/${encodedKey}/${encodedVal}`;

      await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
    } catch (e) {
      console.error("KV SET error:", e.message);
    }
  },
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function isSafeKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9\-_=.+/]{10,1024}$/.test(key);
}

function isSafeDeviceId(id) {
  return (
    typeof id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      id
    )
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "https://esamz.tech";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ success: false, message: "Method not allowed." });
  }

  if (!SECRET) {
    return res
      .status(500)
      .json({ success: false, message: "Server misconfiguration." });
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  const rawKey = req.body?.key;
  const rawDeviceId = req.body?.deviceId;

  if (!isSafeKey(rawKey)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid activation key." });
  }

  if (!isSafeDeviceId(rawDeviceId)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid device ID." });
  }

  const key = rawKey.trim();
  const deviceId = rawDeviceId.trim().toLowerCase();

  // =========================================================================
  // STEP 1 — JWT VERIFY
  // =========================================================================

  let decoded;

  try {
    decoded = jwt.verify(key, SECRET);
  } catch (err) {
    const expired = err.name === "TokenExpiredError";

    return res.status(200).json({
      success: false,
      message: expired
        ? "Your subscription key expired."
        : "Invalid activation key.",
    });
  }

  const { tier } = decoded;

  if (!VALID_TIERS.has(tier)) {
    return res.status(200).json({
      success: false,
      message: "Invalid subscription tier.",
    });
  }

  // =========================================================================
  // STEP 2 — DAILY MESSAGE LIMIT
  // =========================================================================

  const today = new Date().toISOString().slice(0, 10);

  const usageKey = `usage:${key}:${today}`;

  let used = await KV.get(usageKey);
  used = used ? parseInt(used, 10) : 0;

  const limit = DAILY_LIMITS[tier];

  if (used >= limit) {
    return res.status(200).json({
      success: false,
      limitReached: true,
      tier,
      used,
      limit,
      message: `Daily limit reached (${limit} messages per day).`,
    });
  }

  await KV.set(usageKey, used + 1, 86400);

  // =========================================================================
  // STEP 3 — DEVICE LIMIT
  // =========================================================================

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = decoded.exp || nowSec + 60 * 60 * 24 * 365;

  const ttlSec = Math.max(expSec - nowSec, 60);

  const deviceKey = `devices:${key}`;

  const raw = await KV.get(deviceKey);

  let devices;

  try {
    devices = raw ? JSON.parse(raw) : [];
  } catch {
    devices = [];
  }

  if (!Array.isArray(devices)) devices = [];

  if (devices.includes(deviceId)) {
    return res.status(200).json({
      success: true,
      tier,
      used: used + 1,
      limit,
      devicesUsed: devices.length,
      maxDevices: MAX_DEVICES,
    });
  }

  if (devices.length >= MAX_DEVICES) {
    return res.status(200).json({
      success: false,
      deviceBlocked: true,
      message: "Device limit reached for this key.",
    });
  }

  const updated = [...devices, deviceId];

  await KV.set(deviceKey, JSON.stringify(updated), ttlSec);

  return res.status(200).json({
    success: true,
    tier,
    used: used + 1,
    limit,
    devicesUsed: updated.length,
    maxDevices: MAX_DEVICES,
  });
};
```

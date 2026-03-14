// ============================================================================
//  eSAMz AI — /api/generate-key
//  Called by n8n after payment — generates signed JWT activation token
// ============================================================================

const jwt = require("jsonwebtoken");

const SECRET         = process.env.ESAMZ_MASTER_SECRET;
const INTERNAL_TOKEN = process.env.ESAMZ_INTERNAL_TOKEN;

const PLAN_DAYS = { Plus: 30, Pro: 30, Max: 30 };

const ALLOWED_ORIGINS = ["https://esamz.tech", "https://esamz.site", "https://www.esamz.site"];

module.exports = async function handler(req, res) {
  const reqOrigin = req.headers.origin;
  const origin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : null;

  if (reqOrigin && !origin) {
    return res.status(403).json({ success: false, message: "Origin not allowed." });
  }

  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  const auth = req.headers.authorization || req.headers.Authorization;
  if (!INTERNAL_TOKEN || auth !== `Bearer ${INTERNAL_TOKEN}`) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  if (!SECRET) {
    return res.status(500).json({ success: false, message: "Server misconfiguration." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ success: false, message: "Invalid request body." });
  }

  const tier = typeof body.tier === "string" ? body.tier.trim() : "";
  // EXTRACT THE USER ID / EMAIL
  const sub = typeof body.sub === "string" ? body.sub.trim() : ""; 
  const validTiers = new Set(["Plus", "Pro", "Max"]);

  if (!validTiers.has(tier)) {
    return res.status(400).json({ success: false, message: `Invalid tier: "${tier}". Must be Plus, Pro, or Max.` });
  }

  // REQUIRE THE SUB TO PREVENT RATE LIMIT BYPASSES
  if (!sub) {
    return res.status(400).json({ success: false, message: "Missing user ID (sub)." });
  }

  const days = PLAN_DAYS[tier];
  
  // SIGN WITH 'tier' AND 'sub'. No more random 'jti'.
  const token = jwt.sign(
    { tier, sub }, 
    SECRET,
    { expiresIn: `${days}d` }
  );

  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[GENERATE-KEY] tier=${tier} sub=${sub} days=${days} expiresAt=${expiresAt}`);

  return res.status(200).json({
    success: true,
    token,
    tier,
    sub,
    expiresAt,
    days,
  });
};

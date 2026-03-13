// ============================================================================
//  eSAMz AI — /api/generate-key
//  Called by n8n after payment — generates signed JWT activation token
// ============================================================================

const jwt = require("jsonwebtoken");

const SECRET         = process.env.ESAMZ_MASTER_SECRET;
const INTERNAL_TOKEN = process.env.ESAMZ_INTERNAL_TOKEN;

const PLAN_DAYS = { Plus: 30, Pro: 30, Max: 30 };

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, message: "Method not allowed." });

  // Auth — only n8n can call this
  const auth = req.headers["authorization"];
  if (!INTERNAL_TOKEN || auth !== `Bearer ${INTERNAL_TOKEN}`)
    return res.status(401).json({ success: false, message: "Unauthorized." });

  if (!SECRET)
    return res.status(500).json({ success: false, message: "Server misconfiguration." });

  // Parse body
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== "object")
    return res.status(400).json({ success: false, message: "Invalid request body." });

  const tier = typeof body.tier === "string" ? body.tier.trim() : "";
  const validTiers = new Set(["Plus", "Pro", "Max"]);

  if (!validTiers.has(tier))
    return res.status(400).json({ success: false, message: `Invalid tier: "${tier}". Must be Plus, Pro, or Max.` });

  const days      = PLAN_DAYS[tier];
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const token = jwt.sign(
    { tier, expiresAt, days },
    SECRET,
    { expiresIn: `${days}d` }
  );

  console.log(`[GENERATE-KEY] tier=${tier} days=${days} expiresAt=${expiresAt}`);

  return res.status(200).json({
    success: true,
    token,
    tier,
    expiresAt,
    days,
  });
};

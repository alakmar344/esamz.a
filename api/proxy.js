// api/proxy.js
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const TEXT_LIMIT = 30;
const VOICE_LIMIT = 30;
const TEXT_TTL = 60;
const VOICE_TTL = 86400;

function sha256(x) {
  return crypto.createHash("sha256").update(x).digest("hex");
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function ip(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 🔐 INTERNAL AUTH (server-only)
  const raw = process.env.ESAMZ_INTERNAL_KEY;
  const hash = process.env.ESAMZ_KEY_HASH;

  if (!raw || !hash || !timingSafeEqual(sha256(raw), hash)) {
    return res.status(500).json({ error: "Server auth failure" });
  }

  const body = req.body || {};
  const clientIP = ip(req);

  // ⏱ TEXT RATE LIMIT
  const textKey = `rl:text:${clientIP}`;
  const tCount = await redis.incr(textKey);
  if (tCount === 1) await redis.expire(textKey, TEXT_TTL);
  if (tCount > TEXT_LIMIT) {
    return res.status(429).json({ error: "Text rate limit exceeded" });
  }

  // 🔊 VOICE RATE LIMIT (only if requested)
  if (body.enableVoice === true) {
    const voiceKey = `rl:voice:${clientIP}:${today()}`;
    const used = Number(await redis.get(voiceKey)) || 0;
    if (used >= VOICE_LIMIT) {
      return res.status(403).json({ error: "Voice limit reached" });
    }
    await redis.incr(voiceKey);
    await redis.expire(voiceKey, VOICE_TTL);
  }

  // ✅ PASS THROUGH — NO AI LOGIC HERE
  return res.status(200).json({ ok: true });
}


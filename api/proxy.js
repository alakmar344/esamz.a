import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= REDIS ================= */

const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

/* ================= CONFIG ================= */

const TEXT_LIMIT_PER_MIN = 10;
const VOICE_LIMIT_TOTAL = 3;
const WINDOW_SEC = 60;

/* ================= UTIL ================= */

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

/* ================= RATE LIMITERS ================= */

async function checkTextLimit(userKey) {
  const redisKey = `rl:text:${userKey}`;

  const count = await redis.incr(redisKey);

  if (count === 1) {
    await redis.expire(redisKey, WINDOW_SEC);
  }

  return count <= TEXT_LIMIT_PER_MIN;
}

async function checkVoiceLimit(userKey) {
  const redisKey = `rl:voice:${userKey}`;

  const used = await redis.get(redisKey) || 0;

  if (used >= VOICE_LIMIT_TOTAL) {
    return false;
  }

  await redis.incr(redisKey);
  // optional: expire daily
  await redis.expire(redisKey, 86400);

  return true;
}

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    /* -------- SERVER KEY CHECK -------- */

    const internalKey = process.env.ESAMZ_INTERNAL_KEY;
    const storedHash = process.env.ESAMZ_KEY_HASH;

    if (
      !internalKey ||
      !storedHash ||
      !timingSafeEqual(sha256(internalKey), storedHash)
    ) {
      return res.status(500).json({ error: "Server auth failure" });
    }

    /* -------- BODY -------- */

    const {
      message,
      threadId = "default",
      mode = "text" // "text" | "voice"
    } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Invalid message" });
    }

    /* -------- USER KEY -------- */

    const ip = getClientIP(req);
    const userKey = `${ip}:${threadId}`;

    /* -------- TEXT LIMIT -------- */

    if (!(await checkTextLimit(userKey))) {
      return res.status(429).json({
        error: "Text rate limit exceeded (10/min)"
      });
    }

    /* -------- VOICE LIMIT -------- */

    if (mode === "voice") {
      const allowed = await checkVoiceLimit(userKey);

      if (!allowed) {
        return res.status(403).json({
          error: "Voice limit reached (3 total)"
        });
      }
    }

    /* -------- CALL SARVAM -------- */

    const reply = await callSarvamLLM(message);

    /* -------- OPTIONAL TTS -------- */

    let voice = null;
    if (mode === "voice") {
      voice = await callSarvamTTS(reply);
    }

    return res.status(200).json({
      reply,
      voice,
      provider: "sarvam",
      persona: "eSAMz v9-redis-secure"
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/* ================= SARVAM ================= */

async function callSarvamLLM(message) {
  // Replace with real Sarvam API call
  return `Hello! You said: ${message}`;
}

async function callSarvamTTS(text) {
  // Replace with Sarvam TTS call
  return {
    audioUrl: "https://example.com/audio.mp3"
  };
}


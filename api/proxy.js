import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= REDIS ================= */

const redis = Redis.fromEnv();

/* ================= CONFIG ================= */

const TEXT_LIMIT_PER_MIN = 10;
const VOICE_LIMIT_TOTAL = 3;
const WINDOW_SEC = 60;
const VOICE_RESET_SEC = 86400;

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

/* ================= RATE LIMIT ================= */

async function checkTextLimit(userKey) {
  const key = `rl:text:${userKey}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SEC);
  return count <= TEXT_LIMIT_PER_MIN;
}

async function checkVoiceLimit(userKey) {
  const key = `rl:voice:${userKey}`;
  const used = Number(await redis.get(key)) || 0;
  if (used >= VOICE_LIMIT_TOTAL) return false;
  await redis.incr(key);
  await redis.expire(key, VOICE_RESET_SEC);
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

    const { message, threadId = "default", mode = "text" } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    /* -------- USER KEY -------- */

    const ip = getClientIP(req);
    const userKey = `${ip}:${threadId}`;

    /* -------- TEXT LIMIT -------- */

    if (!(await checkTextLimit(userKey))) {
      return res.status(429).json({
        error: "Text limit exceeded (10/min)"
      });
    }

    /* -------- VOICE LIMIT -------- */

    if (mode === "voice") {
      if (!(await checkVoiceLimit(userKey))) {
        return res.status(403).json({
          error: "Voice limit reached (3 total)"
        });
      }
    }

    /* -------- SARVAM CHAT -------- */

    const reply = await callSarvamChat(message);

    /* -------- SARVAM TTS -------- */

    let voice = null;
    if (mode === "voice") {
      voice = await callSarvamTTS(reply);
    }

    return res.status(200).json({
      reply,
      voice,
      provider: "sarvam",
      model: "sarvam-m",
      persona: "eSAMz v9"
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/* ================= SARVAM REAL CALLS ================= */

async function callSarvamChat(message) {
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`
    },
    body: JSON.stringify({
      model: "sarvam-m",
      messages: [{ role: "user", content: message }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Sarvam chat error:", err);
    throw new Error("Sarvam chat failed");
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callSarvamTTS(text) {
  const res = await fetch("https://api.sarvam.ai/v1/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`
    },
    body: JSON.stringify({
      model: "bulbul-v2",
      input: text,
      voice: "neutral"
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Sarvam TTS error:", err);
    throw new Error("Sarvam TTS failed");
  }

  return await res.json();
}


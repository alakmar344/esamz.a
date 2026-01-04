import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= REDIS ================= */

const redis = Redis.fromEnv();

/* ================= CONFIG ================= */

const TEXT_LIMIT_PER_MIN = 10;
const VOICE_LIMIT_TOTAL = 3;
const TEXT_WINDOW_SEC = 60;
const VOICE_RESET_SEC = 86400;

/* ================= UTILS ================= */

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
  if (count === 1) await redis.expire(key, TEXT_WINDOW_SEC);
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
    /* -------- SERVER AUTH -------- */

    const internalKey = process.env.ESAMZ_INTERNAL_KEY;
    const storedHash = process.env.ESAMZ_KEY_HASH;

    if (
      !internalKey ||
      !storedHash ||
      !timingSafeEqual(sha256(internalKey), storedHash)
    ) {
      return res.status(500).json({
        error: "Server authentication failure"
      });
    }

    /* -------- BODY -------- */

    const {
      message,
      enableVoice = false,
      voiceLanguage = "en-IN",
      voiceSpeaker = "anushka"
    } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Invalid request body"
      });
    }

    /* -------- USER KEY -------- */

    const ip = getClientIP(req);
    const userKey = ip;

    /* -------- TEXT RATE LIMIT -------- */

    if (!(await checkTextLimit(userKey))) {
      return res.status(429).json({
        error: "Text limit exceeded (10 per minute)"
      });
    }

    /* -------- SARVAM CHAT -------- */

    const reply = await callSarvamChat(message);

    /* -------- VOICE (OPTIONAL) -------- */

    let audio = null;

    if (enableVoice === true) {
      if (!(await checkVoiceLimit(userKey))) {
        return res.status(403).json({
          error: "Voice limit reached (3 total)"
        });
      }

      audio = await callSarvamTTS({
        text: reply,
        target_language_code: voiceLanguage,
        speaker: voiceSpeaker,
        enable_preprocessing: true
      });
    }

    /* -------- RESPONSE -------- */

    return res.status(200).json({
      reply,
      audio,
      provider: "sarvam",
      model: "sarvam-m"
    });

  } catch (err) {
    console.error("Proxy fatal error:", err);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
}

/* ================= SARVAM CHAT ================= */

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

  const raw = await res.text();

  if (!res.ok) {
    console.error("Sarvam chat error:", raw);
    throw new Error("Sarvam chat failed");
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Sarvam chat JSON");
  }

  return data.choices?.[0]?.message?.content || "";
}

/* ================= SARVAM BULBUL TTS ================= */

async function callSarvamTTS({
  text,
  target_language_code,
  speaker,
  enable_preprocessing
}) {
  const res = await fetch("https://api.sarvam.ai/v1/text-to-speech/convert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": process.env.SARVAM_API_KEY
    },
    body: JSON.stringify({
      text,
      target_language_code,
      speaker,
      enable_preprocessing
    })
  });

  const raw = await res.text();

  if (!res.ok) {
    console.error("Bulbul TTS error:", raw);
    throw new Error("Bulbul TTS failed");
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Bulbul JSON");
  }

  if (!data.audio || typeof data.audio !== "string") {
    console.error("Bulbul audio missing:", data);
    throw new Error("Bulbul audio missing");
  }

  // base64 WAV string (frontend-ready)
  return data.audio;
}

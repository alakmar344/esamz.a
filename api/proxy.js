// api/proxy.js
import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { runChat, runTTS } from "./chat.js";

/* ---------- REDIS ---------- */
const redis = Redis.fromEnv();

/* ---------- LIMIT CONFIG ---------- */
const CHAT_LIMIT_PER_MIN = 10;
const VOICE_LIMIT_PER_DAY = 3;

const CHAT_TTL_SEC = 60;
const VOICE_TTL_SEC = 86400;

/* ---------- UTILS ---------- */
function sha256(x) {
  return crypto.createHash("sha256").update(x).digest("hex");
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- USER IDENTIFIER ---------- */
// sessionId preferred, IP fallback
function getUserKey(req, body) {
  if (body.sessionId && typeof body.sessionId === "string") {
    return `sid:${body.sessionId}`;
  }
  return `ip:${getIP(req)}`;
}

/* ---------- RATE LIMITS ---------- */
async function checkChatLimit(userKey) {
  const key = `rl:chat:${userKey}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, CHAT_TTL_SEC);
  return count <= CHAT_LIMIT_PER_MIN;
}

async function checkVoiceLimit(userKey) {
  const key = `rl:voice:${userKey}:${today()}`;
  const used = Number(await redis.get(key)) || 0;
  if (used >= VOICE_LIMIT_PER_DAY) return false;
  await redis.incr(key);
  await redis.expire(key, VOICE_TTL_SEC);
  return true;
}

/* ---------- HANDLER ---------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    /* ----- SERVER INTEGRITY (emz + hash) ----- */
    const raw = process.env.ESAMZ_INTERNAL_KEY;
    const hash = process.env.ESAMZ_KEY_HASH;

    if (!raw || !hash || !timingSafeEqual(sha256(raw), hash)) {
      return res.status(500).json({ error: "Server auth failure" });
    }

    /* ----- BODY ----- */
    const {
      message,
      enableVoice = false,
      voiceLanguage = "en-IN",
      voiceSpeaker = "anushka",
      sessionId
    } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message required" });
    }

    /* ----- USER KEY ----- */
    const userKey = getUserKey(req, { sessionId });

    /* ----- CHAT LIMIT (BEFORE AI) ----- */
    if (!(await checkChatLimit(userKey))) {
      return res.status(429).json({
        error: "Chat limit exceeded. Please wait a moment."
      });
    }

    /* ----- CHAT (MONEY SPENT HERE ONLY) ----- */
    const reply = await runChat({
      message,
      sarvamKey: process.env.SARVAM_API_KEY
    });

    /* ----- VOICE ----- */
    let audio = null;

    if (enableVoice === true) {
      if (!(await checkVoiceLimit(userKey))) {
        return res.status(403).json({
          error: "Voice limit reached for today."
        });
      }

      audio = await runTTS({
        text: reply,
        language: voiceLanguage,
        speaker: voiceSpeaker,
        sarvamKey: process.env.SARVAM_API_KEY
      });
    }

    /* ----- RESPONSE ----- */
    return res.json({
      reply,
      audio
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

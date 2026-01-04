// /api/proxy.js

import { Redis } from "@upstash/redis";

// =====================
// CONFIG
// =====================
const DAILY_VOICE_LIMIT = 3;
const DAY_SECONDS = 86400;
const SARVAM_ENDPOINT = "https://api.sarvam.ai/v1/chat/completions";

// =====================
// REDIS CLIENT (GLOBAL SAFE)
// =====================
const redis = Redis.fromEnv();

// =====================
// HELPERS
// =====================
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function getUserKey(req, body) {
  return (
    body.sessionId ||
    req.headers["x-client-session-id"] ||
    getClientIp(req)
  );
}

function voiceKey(userKey) {
  return `voice:${userKey}:${todayUTC()}`;
}

// =====================
// VOICE LIMIT (ATOMIC)
// =====================
async function checkAndConsumeVoice(req, body) {
  const userKey = getUserKey(req, body);
  const key = voiceKey(userKey);

  const count = (await redis.get(key)) ?? 0;

  if (count >= DAILY_VOICE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  const newCount = count + 1;

  await redis.set(key, newCount, { ex: DAY_SECONDS });

  return {
    allowed: true,
    remaining: DAILY_VOICE_LIMIT - newCount
  };
}

// =====================
// API HANDLER
// =====================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
   const clientKey =
  req.headers["x-esamz-key"] ||
  req.headers["X-ESAMZ-KEY"];

if (!clientKey || clientKey !== process.env.ESAMZ_API_KEY) {
  return res.status(401).json({
    error: "Unauthorized"
  });
}


  try {
    const body = req.body ?? {};
    const wantsVoice = body.enableVoice === true;

    let voiceRemaining = null;

    // 🔒 ENFORCE DAILY VOICE LIMIT
    if (wantsVoice) {
      const check = await checkAndConsumeVoice(req, body);

      if (!check.allowed) {
        return res.status(429).json({
          error: "Daily voice limit reached",
          voiceRemaining: 0
        });
      }

      voiceRemaining = check.remaining;
    }

    // 🤖 CALL SARVAM
    const ai = await callSarvam(body.message || "");

    return res.status(200).json({
      reply: ai,
      audio: null, // TTS later
      voiceRemaining
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// =====================
// SARVAM CHAT
// =====================
async function callSarvam(message) {
  const resp = await fetch(SARVAM_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SARVAM_API_KEY}`
    },
    body: JSON.stringify({
      model: "sarvam-m",
      messages: [
        { role: "user", content: message }
      ]
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sarvam error ${resp.status}: ${text}`);
  }

  const data = await resp.json();

  return (
    data?.choices?.[0]?.message?.content ||
    "No response from Sarvam"
  );
}


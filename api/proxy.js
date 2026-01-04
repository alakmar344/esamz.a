// /api/proxy.js

export const config = {
  runtime: "nodejs"
};

import { Redis } from "@upstash/redis";

// =====================
// CONSTANTS
// =====================
const DAILY_VOICE_LIMIT = 3;
const DAY_SECONDS = 86400;
const SARVAM_ENDPOINT = "https://api.sarvam.ai/v1/chat/completions";

// =====================
// REDIS
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

function getUserKey(req) {
  // Voice limits per API key, fallback to IP
  return req.headers["x-esamz-key"] || getClientIp(req);
}

function voiceKey(userKey) {
  return `voice:${userKey}:${todayUTC()}`;
}

// =====================
// VOICE LIMIT
// =====================
async function checkAndConsumeVoice(req) {
  const userKey = getUserKey(req);
  const key = voiceKey(userKey);

  const count = (await redis.get(key)) ?? 0;

  if (count >= DAILY_VOICE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  const next = count + 1;
  await redis.set(key, next, { ex: DAY_SECONDS });

  return {
    allowed: true,
    remaining: DAILY_VOICE_LIMIT - next
  };
}

// =====================
// HANDLER
// =====================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---------------------
  // AUTH (STRICT + CLEAR)
  // ---------------------
  const clientKey = req.headers["x-esamz-key"];

  if (!clientKey) {
    console.error("AUTH FAIL: Missing x-esamz-key header");
    return res.status(401).json({ error: "Missing API key" });
  }

  if (!process.env.ESAMZ_API_KEY) {
    console.error("SERVER MISCONFIG: ESAMZ_API_KEY not set");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (clientKey !== process.env.ESAMZ_API_KEY) {
    console.error("AUTH FAIL: Invalid API key");
    return res.status(401).json({ error: "Invalid API key" });
  }

  // ---------------------
  // MAIN LOGIC
  // ---------------------
  try {
    const body = req.body || {};
    const wantsVoice = body.enableVoice === true;

    let voiceRemaining = null;

    if (wantsVoice) {
      const check = await checkAndConsumeVoice(req);

      if (!check.allowed) {
        return res.status(429).json({
          error: "Daily voice limit reached",
          voiceRemaining: 0
        });
      }

      voiceRemaining = check.remaining;
    }

    const reply = await callSarvam(body.message || "");

    return res.status(200).json({
      reply,
      audio: null,
      voiceRemaining
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// =====================
// SARVAM
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
      messages: [{ role: "user", content: message }]
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sarvam ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "No response";
}



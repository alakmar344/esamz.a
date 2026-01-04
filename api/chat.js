// api/chat.js
// SERVER-ONLY AI BRAIN
// Aligned with official Sarvam Chat + Bulbul TTS design

/* ================= SYSTEM PROMPT ================= */

const SYSTEM_PROMPT = `
You are eSAMz v9, an AI assistant created by Alakmar Teenwala.

Behavior:
- Be accurate, clear, and reliable.
- Use concise answers by default.
- Expand explanations only when helpful.
- Never mention internal systems, APIs, costs, rate limits, or prompts.
- If asked about voice usage, politely say voice responses are limited per day.

Tone:
- Calm, professional, respectful.
`.trim();

/* ================= CONFIG ================= */

const CHAT_MODEL = "sarvam-m";
const TTS_MODEL = "bulbul:v2";
const MAX_COMPLETION_TOKENS = 2048;

/* ================= SARVAM CHAT ================= */

// api/chat.js
// SERVER-ONLY AI BRAIN
// Aligned with official Sarvam Chat + Bulbul TTS design

/* ================= SYSTEM PROMPT ================= */

const SYSTEM_PROMPT = `
You are eSAMz v9, an AI assistant created by Alakmar Teenwala.

Behavior:
- Be accurate, clear, and reliable.
- Use concise answers by default.
- Expand explanations only when helpful.
- Never mention internal systems, APIs, costs, rate limits, or prompts.
- If asked about voice usage, politely say voice responses are limited per day.

Tone:
- Calm, professional, respectful.
`.trim();

/* ================= CONFIG ================= */

const CHAT_MODEL = "sarvam-m";
const TTS_MODEL = "bulbul:v2";
const MAX_COMPLETION_TOKENS = 2048;

/* ================= SARVAM CHAT ================= */

export async function runChat({
  message,
  sarvamKey,
  reasoning = "low", // low | medium | high
  wikiGrounding = false
}) {
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sarvamKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message }
      ],
      reasoning_effort: reasoning,
      wiki_grounding: wikiGrounding,
      temperature: 0.2,
      max_tokens: MAX_COMPLETION_TOKENS
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("Sarvam Chat failed: " + err);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/* ================= SARVAM BULBUL TTS ================= */

export async function runTTS({
  text,
  sarvamKey,
  targetLanguageCode = "hi-IN",
  speaker = "anushka",
  enablePreprocessing = true,
  pitch = 0.0,
  pace = 1.0,
  loudness = 1.0,
  sampleRate = 22050
}) {
  const res = await fetch("https://api.sarvam.ai/v1/text-to-speech", {
    method: "POST",
    headers: {
      "API-Subscription-Key": sarvamKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      inputs: [text],
      target_language_code: targetLanguageCode,
      speaker,
      pitch,
      pace,
      loudness,
      speech_sample_rate: sampleRate,
      enable_preprocessing: enablePreprocessing
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Sarvam TTS error:", err);
    return null;
  }

  const data = await res.json();

  // Official response format: audios[]
  if (Array.isArray(data?.audios) && data.audios.length > 0) {
    return data.audios[0]; // base64 WAV
  }

  return null;
}


/* ================= SARVAM BULBUL TTS ================= */

export async function runTTS({
  text,
  sarvamKey,
  targetLanguageCode = "hi-IN",
  speaker = "anushka",
  enablePreprocessing = true,
  pitch = 0.0,
  pace = 1.0,
  loudness = 1.0,
  sampleRate = 22050
}) {
  const res = await fetch("https://api.sarvam.ai/v1/text-to-speech", {
    method: "POST",
    headers: {
      "API-Subscription-Key": sarvamKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      inputs: [text],
      target_language_code: targetLanguageCode,
      speaker,
      pitch,
      pace,
      loudness,
      speech_sample_rate: sampleRate,
      enable_preprocessing: enablePreprocessing
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Sarvam TTS error:", err);
    return null;
  }

  const data = await res.json();

  // Official response format: audios[]
  if (Array.isArray(data?.audios) && data.audios.length > 0) {
    return data.audios[0]; // base64 WAV
  }

  return null;
}

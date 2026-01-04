/* ============================================
   eSAMz v9.9 – chat.js (MAIN AI HANDLER)
   ============================================ */

const Chat = {
  api: "/api/proxy",

  state: {
    busy: false,
    voice: false,
    language: "en-IN",
    speaker: "anushka"
  },

  /* ---------- MAIN ENTRY ---------- */
  async send(text) {
    text = (text || "").trim();
    if (!text || this.state.busy) return;

    this.state.busy = true;
    this.add("user", text);

    try {
      // 1️⃣ SECURITY CHECK (proxy)
      const gate = await fetch(this.api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enableVoice: this.state.voice
        })
      });

      const gateData = await gate.json();
      if (!gate.ok) {
        this.system(gateData.error || "Blocked");
        return;
      }

      // 2️⃣ SARVAM CHAT
      const reply = await this.callSarvamChat(text);
      this.add("assistant", reply);

      // 3️⃣ SARVAM TTS (optional)
      if (this.state.voice) {
        const audio = await this.callSarvamTTS(reply);
        if (audio) this.play(audio);
      }

    } catch (e) {
      console.error(e);
      this.system("Something went wrong.");
    } finally {
      this.state.busy = false;
    }
  },

  /* ---------- SARVAM CHAT ---------- */
  async callSarvamChat(userText) {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${window.SARVAM_PUBLIC_TOKEN}`
      },
      body: JSON.stringify({
        model: "sarvam-m",
        messages: [
          {
            role: "system",
            content:
              "You are eSAMz AI. Be accurate, calm, and helpful. Do not mention internal limits."
          },
          { role: "user", content: userText }
        ],
        temperature: 0.2
      })
    });

    if (!res.ok) throw new Error("Chat failed");
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  },

  /* ---------- SARVAM TTS ---------- */
  async callSarvamTTS(text) {
    const res = await fetch("https://api.sarvam.ai/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": window.SARVAM_PUBLIC_TOKEN
      },
      body: JSON.stringify({
        text,
        target_language_code: this.state.language,
        speaker: this.state.speaker,
        enable_preprocessing: true
      })
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.audio || null;
  },

  /* ---------- AUDIO ---------- */
  play(base64) {
    const audio = new Audio(`data:audio/wav;base64,${base64}`);
    audio.play().catch(() => {});
  },

  /* ---------- UI HOOKS ---------- */
  add(role, text) {
    console.log(role, text); // replace with UI
  },

  system(text) {
    console.warn(text); // replace with UI
  },

  /* ---------- CONTROLS ---------- */
  setVoice(v) {
    this.state.voice = !!v;
  }
};

window.Chat = Chat;


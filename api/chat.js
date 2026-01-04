/* ============================================
   chat.js – UX Gatekeeper (Client-side)
   ============================================ */

const ChatApp = {
  api: "/api/proxy",

  state: {
    busy: false,
    voiceEnabled: false,
    voiceLanguage: "en-IN",
    voiceSpeaker: "anushka"
  },

  async sendMessage(rawText) {
    const text = (rawText || "").trim();

    // 🚧 UX GATEKEEPING (soft)
    if (!text) return;
    if (this.state.busy) return;

    this.state.busy = true;
    this.disableInput(true);

    this.addMessage("user", text);

    try {
      const res = await fetch(this.api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          enableVoice: this.state.voiceEnabled,
          voiceLanguage: this.state.voiceLanguage,
          voiceSpeaker: this.state.voiceSpeaker
        })
      });

      const data = await res.json();

      if (!res.ok) {
        this.handleError(res.status, data?.error);
        return;
      }

      // reply from server brain
      this.addMessage("assistant", data.reply);

      // optional voice
      if (this.state.voiceEnabled && data.audio) {
        this.playAudio(data.audio);
      }

    } catch (err) {
      console.error("Chat error:", err);
      this.addSystemMessage("Network or server error.");
    } finally {
      this.state.busy = false;
      this.disableInput(false);
    }
  },

  /* ---------- AUDIO ---------- */
  playAudio(base64) {
    try {
      const audio = new Audio(`data:audio/wav;base64,${base64}`);
      audio.play().catch(() => {});
    } catch {
      console.warn("Audio failed");
    }
  },

  /* ---------- ERROR HANDLING ---------- */
  handleError(status, msg) {
    if (status === 429) {
      this.addSystemMessage("Slow down. You are sending messages too fast.");
    } else if (status === 403) {
      this.addSystemMessage("Voice limit reached for today.");
    } else {
      this.addSystemMessage(msg || "Request blocked.");
    }
  },

  /* ---------- UI HOOKS (KEEP YOUR OWN) ---------- */
  addMessage(role, text) {
    console.log(role.toUpperCase(), text);
  },

  addSystemMessage(text) {
    console.warn("SYSTEM:", text);
  },

  disableInput(disabled) {
    // disable input / button
  },

  /* ---------- CONTROLS ---------- */
  setVoice(enabled) {
    this.state.voiceEnabled = Boolean(enabled);
  },

  setVoiceLanguage(lang) {
    this.state.voiceLanguage = lang || "en-IN";
  },

  setVoiceSpeaker(spk) {
    this.state.voiceSpeaker = spk || "anushka";
  }
};

window.ChatApp = ChatApp;

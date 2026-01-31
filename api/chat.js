/**
 * HYBRID MEMORY MANAGER (Client-Side)
 * Merges local localStorage with server history.
 * Keeps your "30k" context alive.
 */

const appState = {
    id: null,
    isTyping: false
};

async function handleChat() {
    const userInput = document.getElementById('userInput');
    const sendBtn = document.getElementById('btnSend'); // Make sure your button has this ID

    if (!appState.id) {
        // Generate or Retrieve Local ID
        let localId = localStorage.getItem('esamz_sid');
        if (!localId) {
            localId = crypto.randomUUID(); // Need a unique ID for localStorage
            localStorage.setItem('esamz_sid', localId);
        }
        appState.id = localId;
    }

    const message = userInput.value.trim();
    if (!message) return;

    // UI Updates
    sendBtn.disabled = true;
    sendBtn.innerHTML = `<svg class="stop-icon" style="display:none;"></svg>
        <svg class="send-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="22" y2="22" /><polygon points="20 22 8 15 12 22 22 4 15 12 2"></polygon></svg>`;
    
    // Add User Message to Local History (Client-Side Memory)
    const localHistory = JSON.parse(localStorage.getItem(`esamz_history_${appState.id}`) || '[]');
    localHistory.push({ role: 'user', content: message });
    localStorage.setItem(`esamz_history_${appState.id}`, JSON.stringify(localHistory));

    // 1. SYNC: Send Current Client History to Server
    // We send the last 20 messages to let the server know context
    // The Server also sends back its last 20-25.
    // This creates a "Hybrid" memory of ~40-50 messages.
    const historyToSend = JSON.stringify(localHistory.slice(-30)); 

    try {
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: message,
                sessionId: appState.id,
                history: historyToSend, // <--- SEND CLIENT HISTORY
                action: 'sync_history' // Tell server we are syncing
            })
        });

        // Read Stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            fullText += chunk;

            // Handle "CHUNK|", "STATUS|", "DONE|"
            const lines = chunk.split('\n');
            for (const line of lines) {
                const sep = line.indexOf('|');
                if (sep !== -1) {
                    const type = line.substring(0, sep);
                    const data = line.substring(sep + 1);

                    if (type === 'STATUS') {
                        // Optional: Show status in UI
                    } else if (type === 'CHUNK') {
                        const safeData = data.replace(/\\n/g, '\n');
                        appendToChatWindow('assistant', safeData);
                    } else if (type === 'DONE') {
                        // Server finished. We update our local storage with the final polished reply
                        // This ensures the final polished version is saved on the user's device (persistent!)
                        appendToChatWindow('assistant', fullText); 
                        
                        // Also update last message in LocalStorage
                        // We use a rolling buffer of last 20 messages to keep memory small but fresh
                        updateLocalStorage(fullText);
                    } else if (type.startsWith('ERROR')) {
                        // Handle Error
                    }
                }
            }
        }
    } catch (e) {
        console.error("Chat Error:", e);
        alert("Failed to send message. Please try again.");
    } finally {
        // Re-enable button
        sendBtn.disabled = false;
        userInput.value = "";
    }
}

// Helper to add messages to DOM and State
function appendToChatWindow(role, text) {
    const chatList = document.getElementById('chatList');
    
    // Create welcome div if empty
    if (chatList.children.length === 0) {
        const welcome = document.getElementById('welcomeScreen');
        welcome.style.display = 'flex';
    } else {
        welcome.style.display = 'none';
    }

    // Add Message
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    msgDiv.innerHTML = `
        <div class="avatar">${role === 'user' ? 'U' : 'eS'}</div>
        <div class="msg-content">
            <div class="bubble">${text}</div>
            <div class="msg-actions">
                <button onclick="navigator.clipboard.writeText(this.parentElement.previousElementSibling.textContent); alert('Copied')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a1 1 0-8h3a1 4h2a1 4-6-1-1-1h2a1 4h2a1 16zm0-11.296.951 12 12-.95 12.951 21 12.95 21 9 12-9a3 9 12-9a3 9 18a3 0 0 0 24v24"/></svg>
                </button>
            </div>
        </div>
    `;

    chatList.appendChild(msgDiv);
    // Scroll to bottom
    document.querySelector('.chat-container').scrollTop = document.querySelector('.chat-container').scrollHeight;
}

// Updates LocalStorage with the last 20 messages (Persistent on user device)
function updateLocalStorage(newAssistantMessage) {
    const localHistory = JSON.parse(localStorage.getItem(`esamz_history_${appState.id}`) || '[]');
    
    // Add the new assistant message
    localHistory.push({ role: 'assistant', content: newAssistantMessage });
    
    // Keep only last 20
    if (localHistory.length > 20) {
        localHistory = localHistory.slice(-20);
    }
    
    localStorage.setItem(`esamz_history_${appState.id}`, JSON.stringify(localHistory));
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const sendBtn = document.getElementById('btnSend');
    const userInput = document.getElementById('userInput');
    
    if (sendBtn && userInput) {
        sendBtn.addEventListener('click', handleChat);
    }
});

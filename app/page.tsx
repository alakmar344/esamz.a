// @ts-nocheck
'use client'

import { useEffect, useRef, useState } from 'react'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __clerk: {
      isSignedIn: boolean
      openSignIn: () => void
      getToken: () => Promise<string | null>
    }
    __syncTierFromServer?: () => void
    app: any
    marked: any
    DOMPurify: any
    Prism: any
    Tesseract: any
    dataLayer: any[]
  }
}

const hasClerk = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

let useAuth: any, useClerk: any, UserButton: any
if (hasClerk) {
  const clerk = require('@clerk/nextjs')
  useAuth = clerk.useAuth
  useClerk = clerk.useClerk
  UserButton = clerk.UserButton
}

function ClerkBridge() {
  const { isSignedIn, getToken } = useAuth()
  const { openSignIn } = useClerk()

  const isSignedInRef = useRef<boolean>(false)
  const getTokenRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null))
  const openSignInRef = useRef<() => void>(() => {})

  useEffect(() => {
    isSignedInRef.current = !!isSignedIn
    // Sync tier from server whenever the user becomes signed in
    if (isSignedIn) {
      window.__syncTierFromServer?.()
    }
  }, [isSignedIn])
  useEffect(() => { openSignInRef.current = () => openSignIn() }, [openSignIn])
  useEffect(() => { getTokenRef.current = getToken }, [getToken])

  useEffect(() => {
    window.__clerk = {
      get isSignedIn() { return isSignedInRef.current },
      openSignIn: () => openSignInRef.current(),
      getToken: () => getTokenRef.current(),
    }
  }, [])

  return null
}

export default function ChatPage() {
  const appInitialized = useRef(false)
  const [mounted, setMounted] = useState(false)

  // Only render Clerk hooks after mount to avoid prerender errors
  useEffect(() => { setMounted(true) }, [])

  // Set up a default (unauthenticated) Clerk bridge when Clerk is not available
  useEffect(() => {
    if (!hasClerk) {
      window.__clerk = {
        isSignedIn: false,
        openSignIn: () => {},
        getToken: () => Promise.resolve(null),
      }
    }
  }, [])

  // Initialize the vanilla JS app after mount
  useEffect(() => {
    if (appInitialized.current) return
    appInitialized.current = true

    ;(function () {
        'use strict';
        const BACKEND_CHAT_URL    = '/api/chat/proxy';
        const BACKEND_CHAT_URL_ANON = 'https://backend-for-esamzai.onrender.com/api/chat';
        const BACKEND_BASE_URL    = 'https://backend-for-esamzai.onrender.com';

        const LS_PLAN      = 'esamz_plan';
        const LS_STORAGE   = 'esamz_conversations_v9';
        const LS_LAST_CHAT = 'esamz_last_chat_id';

        // ====================================================================
        //  UTILITIES
        // ====================================================================
        const Utils = {
            toastContainer: document.getElementById('toast-container'),
            showToast(message, type = 'info') {
                const t = document.createElement('div');
                t.className = 'toast';
                const icon = type === 'error' ? '⚠' : type === 'success' ? '✓' : '·';
                const iconSpan = document.createElement('span');
                iconSpan.style.cssText = 'font-size:14px;opacity:.6;';
                iconSpan.textContent = icon;
                const msgSpan = document.createElement('span');
                msgSpan.textContent = message;
                t.appendChild(iconSpan);
                t.appendChild(msgSpan);
                this.toastContainer.appendChild(t);
                const duration = type === 'error' ? 5500 : 3000;
                setTimeout(() => {
                    t.style.opacity = '0';
                    t.style.transition = 'opacity 0.3s';
                    setTimeout(() => t.remove(), 300);
                }, duration);
            },
            confirm(message, title = 'Confirm') {
                let _cancel = null;
                const promise = new Promise(resolve => {
                    const dlg = document.getElementById('confirmDialog');
                    document.getElementById('confirmTitle').textContent    = title;
                    document.getElementById('confirmMessage').textContent  = message;
                    const ok  = document.getElementById('confirmOk');
                    const cancel = document.getElementById('confirmCancel');
                    const close = () => {
                        _cancel = null; dlg.close();
                        ok.removeEventListener('click', onOk);
                        cancel.removeEventListener('click', onCancel);
                    };
                    const onOk     = () => { close(); resolve(true);  };
                    const onCancel = () => { close(); resolve(false); };
                    _cancel = onCancel;
                    ok.addEventListener('click', onOk);
                    cancel.addEventListener('click', onCancel);
                    dlg.showModal();
                });
                promise.cancel = () => { if (_cancel) _cancel(); };
                return promise;
            }
        };

        // ====================================================================
        //  CLERK AUTHENTICATION (handled via window.__clerk bridge from React)
        // ====================================================================

        function requireSignIn() {
            if (!window.__clerk?.isSignedIn) {
                window.__clerk?.openSignIn();
                return false;
            }
            return true;
        }

        // ====================================================================
        //  SUBSCRIPTION CORE (plan UI only)
        // ====================================================================
        function checkPermissions() {
            const storedPlan = localStorage.getItem(LS_PLAN);

            const ragWrapper = document.getElementById('rag-toggle-wrapper');
            const ragToggle  = document.getElementById('rag-toggle');
            const spe        = document.getElementById('system-prompt-editor');
            const badgeEl    = document.getElementById('planBadgeContainer');

            function resetPlanUI() {
                ragWrapper.classList.remove('visible');
                spe.classList.remove('visible');
                ragToggle.disabled = false;
                ragToggle.checked  = true;
                badgeEl.innerHTML  = '';
            }

            function applyPlan(plan) {
                resetPlanUI();
                if (!plan) return;
                const ICONS = { Plus: '⚡', Pro: '🚀', Max: '♾️' };
                const badge = document.createElement('div');
                badge.className = `plan-badge ${plan.toLowerCase()}`;
                badge.innerHTML = `<span>${ICONS[plan] || '✦'}</span><span>${plan} Plan Active</span>`;
                badgeEl.appendChild(badge);
                if (plan === 'Plus') {
                    ragWrapper.classList.add('visible');
                    ragToggle.checked = true;
                    ragToggle.disabled = true;
                }
                if (plan === 'Pro')  { ragWrapper.classList.add('visible'); ragToggle.disabled = false; }
                if (plan === 'Max')  { ragWrapper.classList.add('visible'); ragToggle.disabled = false; spe.classList.add('visible'); }
            }

            const VALID_PLANS = ['Plus', 'Pro', 'Max'];
            if (storedPlan && VALID_PLANS.includes(storedPlan)) {
                applyPlan(storedPlan);
            } else {
                resetPlanUI();
            }
        }

        // ====================================================================
        //  PLANS PAGE MODAL UI
        // ====================================================================
        const PlansModal = {
            overlay: document.getElementById('plansModal'),

            init() {
                document.getElementById('btnViewPlans')
                    .addEventListener('click', () => this.open());
                document.getElementById('plansModalClose')
                    .addEventListener('click', () => this.close());
                this.overlay.addEventListener('click', e => {
                    if (e.target === this.overlay) this.close();
                });
            },

            open() {
                this.overlay.classList.remove('hidden');
            },

            close() {
                this.overlay.classList.add('hidden');
            }
        };

        // ====================================================================
        //  SYSTEM PROMPT EDITOR
        // ====================================================================
        (function initSpe() {
            const toggleBtn = document.getElementById('btnToggleSpe');
            const textarea  = document.getElementById('spe-textarea');
            const hint      = document.getElementById('speHint');

            if (!toggleBtn) return;

            toggleBtn.addEventListener('click', () => {
                const isOpen = textarea.classList.contains('open');
                if (isOpen) {
                    textarea.classList.remove('open');
                    hint.style.display     = 'none';
                    toggleBtn.textContent  = 'Edit ↓';
                } else {
                    textarea.classList.add('open');
                    hint.style.display     = 'block';
                    toggleBtn.textContent  = 'Collapse ↑';
                    textarea.focus();
                }
            });
        })();

        // ====================================================================
        //  CIBO MODAL
        // ====================================================================
        const CiboModal = {
            modal: document.getElementById('ciboModal'),
            _bound: false,
            _bind() {
                if (this._bound) return;
                this._bound = true;
                document.getElementById('ciboModalClose').addEventListener('click',   () => this.dismiss());
                document.getElementById('ciboModalDismiss').addEventListener('click', () => this.dismiss());
                this.modal.addEventListener('click', e => { if (e.target === this.modal) this.dismiss(); });
            },
            init() {
                if (localStorage.getItem('esamz_cibo_shown') === '1') return;
                this._bind();
                // Delay 800ms so the modal doesn't compete with page load
                setTimeout(() => {
                    if (localStorage.getItem('esamz_cibo_shown') !== '1') this.modal.classList.remove('hidden');
                }, 800);
            },
            show() {
                if (localStorage.getItem('esamz_cibo_shown') === '1') return;
                this._bind();
                setTimeout(() => {
                    if (localStorage.getItem('esamz_cibo_shown') !== '1') this.modal.classList.remove('hidden');
                }, 300);
            },
            dismiss() {
                this.modal.classList.add('hidden');
                localStorage.setItem('esamz_cibo_shown', '1');
            }
        };

        // ====================================================================
        //  MAIN APP CLASS
        // ====================================================================
        class App {
            constructor() {
                this.dom = {
                    chatList:    document.getElementById('chatList'),
                    input:       document.getElementById('userInput'),
                    welcome:     document.getElementById('welcomeScreen'),
                    historyList: document.getElementById('historyList'),
                    filePreview: document.getElementById('filePreview'),
                    sidebar:     document.getElementById('sidebar'),
                    overlay:     document.getElementById('overlay'),
                    statusText:  document.getElementById('statusText'),
                    statusIndicator: document.getElementById('statusIndicator'),
                    sendBtn:     document.getElementById('btnSend'),
                    sendIcon:    document.querySelector('.send-icon'),
                    stopIcon:    document.querySelector('.stop-icon'),
                    chatContainer: document.getElementById('chatContainer'),
                    uploadBtn:   document.getElementById('btnUpload'),
                    fileInput:   document.getElementById('fileInput'),
                    newChatBtn:  document.getElementById('btnNewChat'),
                    clearChatBtn:document.getElementById('btnClearChat'),
                    exportBtn:   document.getElementById('btnExportChat'),
                    themeToggle: document.getElementById('btnThemeToggle'),
                    closeSidebarBtn:        document.getElementById('btnCloseSidebar'),
                    openSidebarDesktopBtn:  document.getElementById('btnOpenSidebarDesktop'),
                    openSidebarMobileBtn:   document.getElementById('openSidebar'),
                };
                this.state = {
                    chatId: null, files: [],
                    isProcessing: false, abortController: null
                };
                this.storageKey  = LS_STORAGE;
                this.LAST_CHAT_KEY = LS_LAST_CHAT;
                this.init();
            }

            init() {
                this.initTheme();

                checkPermissions();
                PlansModal.init();

                CiboModal.init();
                this.loadHistory();
                this.setupEventListeners();
                this.updateButtonState();
                this.initDraft();
                this.initPasteSupport();

                const lastId = localStorage.getItem(this.LAST_CHAT_KEY);
                if (lastId) {
                    const tryLoad = () => {
                        if (window.marked) {
                            if (this.getHistory().find(c => c.id === lastId)) this.loadChat(lastId);
                        } else {
                            setTimeout(tryLoad, 100);
                        }
                    };
                    tryLoad();
                }
                this.dom.input.focus();
            }

            getHistory() {
                const r = localStorage.getItem(this.storageKey);
                return r ? JSON.parse(r) : [];
            }

            setupEventListeners() {
                this.dom.input.addEventListener('focus', () => {
                    if (!requireSignIn()) {
                        this.dom.input.blur();
                    }
                });
                this.dom.input.addEventListener('input', () => this.handleInput());
                this.dom.input.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this.state.isProcessing ? this.abortGeneration() : this.handleSend();
                    }
                });
                this.dom.sendBtn.addEventListener('click', () => {
                    this.state.isProcessing ? this.abortGeneration() : this.handleSend();
                });
                this.dom.newChatBtn.addEventListener('click',  () => this.newChat());

                // FIX P6: Clear Chat also calls DELETE /api/session to wipe server-side memory
                this.dom.clearChatBtn.addEventListener('click', async () => {
                    if (await Utils.confirm('Clear current chat session?', 'Clear Chat')) {
                        try {
                            await fetch(`${BACKEND_BASE_URL}/api/session`, {
                                method: 'DELETE',
                                credentials: 'include',
                            });
                        } catch (_) { /* offline — local clear still proceeds */ }
                        this.newChat();
                    }
                });

                this.dom.uploadBtn.addEventListener('click', () => this.dom.fileInput.click());
                this.dom.fileInput.addEventListener('change', e => this.handleFiles(e.target.files));

                const exportDialog = document.getElementById('exportDialog');
                document.getElementById('closeDialog').addEventListener('click', () => exportDialog.close());
                this.dom.exportBtn.addEventListener('click', () => {
                    if (this.state.chatId) exportDialog.showModal();
                    else Utils.showToast('No chat to export', 'error');
                });
                document.querySelectorAll('[data-export-type]').forEach(btn => {
                    btn.addEventListener('click', e => this.exportChat(e.currentTarget.dataset.exportType));
                });

                // Mobile sidebar
                this.dom.openSidebarMobileBtn.addEventListener('click', () => {
                    this.dom.sidebar.classList.add('active');
                    this.dom.overlay.classList.add('active');
                    document.body.style.overflow = 'hidden';
                });
                this.dom.overlay.addEventListener('click', () => {
                    this.dom.sidebar.classList.remove('active');
                    this.dom.overlay.classList.remove('active');
                    document.body.style.overflow = '';
                });

                // Desktop sidebar collapse/expand
                this.dom.closeSidebarBtn.addEventListener('click', () => {
                    this.dom.sidebar.classList.add('collapsed');
                });
                this.dom.openSidebarDesktopBtn.addEventListener('click', () => {
                    this.dom.sidebar.classList.remove('collapsed');
                });

                this.dom.themeToggle.addEventListener('click', () => this.toggleTheme());

                document.querySelectorAll('.suggestion-card').forEach(card => {
                    card.setAttribute('role', 'button');
                    card.setAttribute('tabindex', '0');
                    card.addEventListener('click', () => {
                        if (card.dataset.prompt) this.fillInput(card.dataset.prompt);
                    });
                    card.addEventListener('keydown', e => {
                        if (e.key === 'Enter') {
                            if (card.dataset.prompt) this.fillInput(card.dataset.prompt);
                        } else if (e.key === ' ') {
                            e.preventDefault();
                            if (card.dataset.prompt) this.fillInput(card.dataset.prompt);
                        }
                    });
                });
            }

            handleInput() {
                this.dom.input.style.height = 'auto';
                this.dom.input.style.height = Math.min(this.dom.input.scrollHeight, 200) + 'px';
                this.updateButtonState();
                this.updateCharCount();
            }

            updateCharCount() {
                const charCount = document.getElementById('charCount');
                if (!charCount) return;
                const len = this.dom.input.value.length;
                charCount.textContent = len > 0 ? `${len.toLocaleString()} char${len !== 1 ? 's' : ''}` : '';
            }

            updateButtonState() {
                if (this.state.isProcessing) {
                    this.dom.sendBtn.disabled = false;
                    return;
                }
                const hasContent = this.dom.input.value.trim().length > 0 || this.state.files.length > 0;
                this.dom.sendBtn.disabled = !hasContent;
            }

            fillInput(text) {
                this.dom.input.value = text;
                this.dom.input.dispatchEvent(new Event('input'));
                this.dom.input.focus();
            }

            updateStatus(text) {
                this.dom.statusText.textContent = text;
                if (text === 'Ready') this.dom.statusIndicator.classList.remove('processing');
                else this.dom.statusIndicator.classList.add('processing');
            }

            async handleFiles(fileList) {
                if (!fileList.length) return;
                for (const file of fileList) {
                    const chipId = 'chip-' + Date.now() + Math.random().toString(36).substr(2, 9);
                    const chip   = document.createElement('div');
                    chip.className = 'file-chip';
                    chip.id        = chipId;
                    const isImage  = file.type.startsWith('image/');
                    let objectUrl  = null;
                    let iconHtml   = '<span>📄</span>';
                    if (isImage) { objectUrl = URL.createObjectURL(file); iconHtml = `<img src="${objectUrl}" alt="preview">`; }
                    chip.innerHTML = `${iconHtml}<span>${file.name}</span>`;
                    const removeBtn = document.createElement('button');
                    removeBtn.innerHTML = '✕';
                    removeBtn.onclick = () => {
                        chip.remove();
                        const f = this.state.files.find(x => x.id === chipId);
                        if (f && f.url) URL.revokeObjectURL(f.url);
                        this.state.files = this.state.files.filter(x => x.id !== chipId);
                        this.updateButtonState();
                    };
                    chip.appendChild(removeBtn);
                    this.dom.filePreview.appendChild(chip);
                    try {
                        const ext = file.name.split('.').pop().toLowerCase();
                        const imgExts = ['png','jpg','jpeg','gif','webp','bmp'];
                        let content = '';
                        if (imgExts.includes(ext)) { chip.querySelector('span').textContent = 'Scanning…'; content = await this.runOCR(file); chip.querySelector('span').textContent = file.name; }
                        else { content = await file.text(); }
                        this.state.files.push({ id: chipId, name: file.name, type: imgExts.includes(ext) ? 'image' : 'text', content, url: objectUrl });
                        this.updateButtonState();
                    } catch (e) { console.error(e); Utils.showToast(`Failed to process ${file.name}`, 'error'); chip.remove(); if (objectUrl) URL.revokeObjectURL(objectUrl); }
                }
                this.dom.fileInput.value = '';
            }

            async runOCR(file) {
                if (typeof Tesseract === 'undefined') {
                    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@v5/dist/tesseract.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
                }
                const worker = await Tesseract.createWorker('eng');
                const { data: { text } } = await worker.recognize(file);
                await worker.terminate();
                if (!text || text.trim() === '') throw new Error('No text found in image');
                return text;
            }

            async handleSend() {
                if (!requireSignIn()) return;
                const text = this.dom.input.value.trim();
                if ((!text && this.state.files.length === 0) || this.state.isProcessing) return;

                this.dom.input.value = '';
                this.dom.input.style.height = 'auto';
                this.updateCharCount();
                this.state.files.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); });
                const attachedFiles = [...this.state.files];
                this.state.files    = [];
                this.dom.filePreview.innerHTML = '';
                this.dom.welcome.classList.add('hidden');

                if (!this.state.chatId) {
                    this.state.chatId = Date.now().toString();
                    const title = text.slice(0, 30) || 'Untitled Chat';
                    this.saveToHistory({ id: this.state.chatId, title, messages: [], lastUpdated: Date.now() });
                    this.renderHistoryItem(this.state.chatId, title);
                    localStorage.setItem(this.LAST_CHAT_KEY, this.state.chatId);
                }

                let userMsgText = text;
                if (attachedFiles.length > 0) {
                    const fc = attachedFiles.map(f => `${f.type === 'image' ? '🖼️' : '📄'} **${f.name}**\n\`\`\`\n${f.content}\n\`\`\``).join('\n');
                    userMsgText += '\n\n' + fc;
                }
                this.appendMessage('user', userMsgText);

                let finalPayload = text;
                if (attachedFiles.length > 0) {
                    finalPayload += '\n\n[Attached Content]:\n' + attachedFiles.map(f => f.content).join('\n\n');
                }

                this.setProcessingState(true);

                const aiMsgDiv  = this.appendMessage('ai', '', true);
                const contentDiv = aiMsgDiv.querySelector('.bubble');
                this.state.abortController = new AbortController();

                const clientHistory    = this.getRawHistory(this.state.chatId);
                const clientLastActive = Date.now();

                const ragToggle      = document.getElementById('rag-toggle');
                const speTextarea    = document.getElementById('spe-textarea');
                const plan           = localStorage.getItem(LS_PLAN);

                // Compute effective RAG flag — matches backend's effective_rag_enabled logic
                // Free (no plan): omit field entirely so backend defaults to its own gating
                // Plus: always true (backend enforces this but we align)
                // Pro/Max: honour the toggle
                const ragEnabled = plan === 'Plus' ? true
                    : (plan === 'Pro' || plan === 'Max') ? ragToggle.checked
                    : undefined;

                // customSystemPrompt only sent for Max tier
                const customSystemPrompt = (plan === 'Max' && speTextarea && speTextarea.value.trim())
                    ? speTextarea.value.trim()
                    : undefined;

                try {
                    const reqBody = {
                        message:         finalPayload,
                        sessionId:       this.state.chatId,
                        clientHistory,
                        clientLastActive,
                    };
                    if (ragEnabled !== undefined)   reqBody.ragEnabled         = ragEnabled;
                    if (customSystemPrompt)         reqBody.customSystemPrompt = customSystemPrompt;

                    const reqHeaders = { 'Content-Type': 'application/json' };
                    // Use the authenticated proxy when signed in (it fetches tier from MongoDB).
                    // Fall back to direct backend call for anonymous users.
                    const chatUrl = window.__clerk?.isSignedIn ? BACKEND_CHAT_URL : BACKEND_CHAT_URL_ANON;
                    if (!window.__clerk?.isSignedIn) {
                        // Anonymous path: pass Clerk token if available (backend treats absent token as free)
                        try {
                            const token = await window.__clerk?.getToken();
                            if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
                        } catch (e) {
                            console.error('[Clerk] Failed to retrieve session token:', e);
                        }
                    }

                    // Retry up to 2 times on 504 Gateway Timeout (transient AI service errors).
                    let response;
                    for (let attempt = 0; attempt <= 2; attempt++) {
                        if (attempt > 0) {
                            this.updateStatus(`Retrying… (${attempt}/2)`);
                            await new Promise(r => setTimeout(r, 2000 * attempt));
                        }
                        response = await fetch(chatUrl, {
                            method:  'POST',
                            headers: reqHeaders,
                            body:    JSON.stringify(reqBody),
                            signal:  this.state.abortController.signal,
                        });
                        if (response.ok || response.status !== 504) break;
                    }
                    if (!response.ok) {
                        const msg = response.status === 504
                            ? 'AI service timed out. Please try again in a moment.'
                            : 'Something went wrong. Please try again.';
                        throw new Error(msg);
                    }

                    const reader  = response.body.getReader();
                    const decoder = new TextDecoder('utf-8');
                    let buffer    = '';
                    let fullText  = '';
                    let incomingHistory = null;

                    let renderScheduled = false;
                    const scheduleRender = () => {
                        if (renderScheduled) return;
                        renderScheduled = true;
                        requestAnimationFrame(() => {
                            renderScheduled = false;
                            if (window.marked && window.DOMPurify) {
                                try { contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(fullText)); if (window.Prism) Prism.highlightAllUnder(contentDiv); this.injectCodeButtons(contentDiv); }
                                catch (_) { contentDiv.textContent = fullText; }
                            } else { contentDiv.textContent = fullText; }
                            this.scrollToBottom();
                        });
                    };

                    const processLine = line => {
                        if (!line.trim()) return;
                        const sep  = line.indexOf('|');
                        if (sep === -1) return;
                        const type = line.substring(0, sep);
                        const data = line.substring(sep + 1);
                        if (type === 'STATUS') {
                            if (data === 'SEARCHING') this.updateStatus('Searching…');
                            if (data === 'TYPING')    this.updateStatus('Generating…');
                        } else if (type === 'CHUNK') {
                            fullText += data.replace(/\\n/g, '\n');
                            scheduleRender();
                        } else if (type === 'HISTORY_UPDATE') {
                            try { incomingHistory = JSON.parse(data); } catch (_) {}
                        } else if (type === 'ERROR') {
                            const errMsg = /504|gateway timeout|timed out/i.test(data)
                                ? 'AI service timed out. Please try again in a moment.'
                                : /sarvam/i.test(data)
                                    ? 'Something went wrong with the AI service. Please try again.'
                                    : data;
                            throw new Error(errMsg);
                        }
                    };

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const l of lines) processLine(l);
                    }
                    if (buffer.trim()) for (const l of buffer.split('\n')) processLine(l);

                    if (fullText && window.marked && window.DOMPurify) {
                        try { contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(fullText)); if (window.Prism) Prism.highlightAllUnder(contentDiv); this.injectCodeButtons(contentDiv); }
                        catch (_) { contentDiv.textContent = fullText; }
                    }

                    if (incomingHistory) {
                        this.overwriteHistory(this.state.chatId, incomingHistory);
                    } else {
                        const msgs = Array.from(this.dom.chatList.querySelectorAll('.message')).map(m => ({
                            role:    m.classList.contains('user') ? 'user' : 'assistant',
                            content: m.querySelector('.bubble').innerText
                        }));
                        this.overwriteHistory(this.state.chatId, msgs);
                    }
                    this.addCopyButton(aiMsgDiv);
                    this.addRegenButton(aiMsgDiv);

                } catch (error) {
                    if (error.name === 'AbortError') {
                        contentDiv.innerHTML += '<p style="font-style:italic;color:var(--ink-ghost);margin-top:10px;">[Stopped by user]</p>';
                        const msgs = Array.from(this.dom.chatList.querySelectorAll('.message')).map(m => ({ role: m.classList.contains('user') ? 'user' : 'assistant', content: m.querySelector('.bubble').innerText }));
                        if (msgs.length) this.overwriteHistory(this.state.chatId, msgs);
                    } else {
                        Utils.showToast(error.message, 'error');
                        contentDiv.innerHTML = `<span style="color:var(--vermillion)">Error: ${error.message}</span>`;
                    }
                } finally {
                    this.setProcessingState(false);
                    const c = this.dom.chatContainer;
                    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 120;
                    if (atBottom) this.scrollToBottom();
                }
            }

            setProcessingState(on) {
                this.state.isProcessing = on;
                if (on) {
                    this.updateStatus('Thinking…');
                    this.dom.sendBtn.classList.add('stop-mode');
                    this.dom.sendBtn.disabled = false;
                    this.dom.sendIcon.classList.add('hidden');
                    this.dom.stopIcon.classList.remove('hidden');
                } else {
                    this.updateStatus('Ready');
                    this.dom.sendBtn.classList.remove('stop-mode');
                    this.dom.sendIcon.classList.remove('hidden');
                    this.dom.stopIcon.classList.add('hidden');
                    this.state.abortController = null;
                    this.updateButtonState();
                }
            }

            initDraft() {
                const KEY = 'esamz_draft_v9';
                const saved = localStorage.getItem(KEY);
                if (saved && saved.trim()) { this.dom.input.value = saved; this.handleInput(); }
                let timer;
                const indicator = document.getElementById('draftIndicator');
                this.dom.input.addEventListener('input', () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => {
                        const v = this.dom.input.value;
                        if (v) {
                            localStorage.setItem(KEY, v);
                            if (indicator) { indicator.classList.add('visible'); setTimeout(() => indicator.classList.remove('visible'), 1500); }
                        } else {
                            localStorage.removeItem(KEY);
                        }
                    }, 800);
                });
            }

            initPasteSupport() {
                this.dom.input.addEventListener('paste', e => {
                    const items = e.clipboardData?.items;
                    if (!items) return;
                    for (const item of items) {
                        if (item.type.startsWith('image/')) {
                            e.preventDefault();
                            const file = item.getAsFile();
                            if (file) this.handleFiles([file]);
                            break;
                        }
                    }
                });
            }

            addCopyButton(msgDiv) {
                if (!msgDiv || !msgDiv.classList.contains('ai')) return;
                const content = msgDiv.querySelector('.message-content');
                if (!content || content.querySelector('.msg-action-bar')) return;
                const bubble = msgDiv.querySelector('.bubble');
                if (!bubble) return;
                const bar     = document.createElement('div');
                bar.className = 'msg-action-bar';
                const copyBtn = document.createElement('button');
                copyBtn.className = 'msg-copy-btn';
                copyBtn.title = 'Copy';
                copyBtn.setAttribute('aria-label', 'Copy');
                copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
                copyBtn.addEventListener('click', function () {
                    navigator.clipboard.writeText(bubble.innerText || bubble.textContent).then(() => {
                        copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
                        setTimeout(() => { copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`; }, 2000);
                    }).catch(() => {});
                });
                bar.appendChild(copyBtn);
                content.appendChild(bar);
            }

            addRegenButton(msgDiv) {
                if (!msgDiv || !msgDiv.classList.contains('ai')) return;
                const content = msgDiv.querySelector('.message-content');
                if (!content) return;
                let bar = content.querySelector('.msg-action-bar');
                if (!bar) { bar = document.createElement('div'); bar.className = 'msg-action-bar'; content.appendChild(bar); }
                if (bar.querySelector('.msg-regen-btn')) return;
                const btn = document.createElement('button');
                btn.className = 'msg-regen-btn';
                btn.title = 'Regenerate';
                btn.setAttribute('aria-label', 'Regenerate');
                btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`;
                btn.addEventListener('click', () => this.regenerateMessage(msgDiv));
                bar.appendChild(btn);
            }

            addEditButton(msgDiv) {
                if (!msgDiv || !msgDiv.classList.contains('user')) return;
                const content = msgDiv.querySelector('.message-content');
                if (!content || content.querySelector('.msg-action-bar')) return;
                const bubble = msgDiv.querySelector('.bubble');
                const bar    = document.createElement('div');
                bar.className = 'msg-action-bar';
                const copyBtn = document.createElement('button');
                copyBtn.className = 'msg-copy-btn';
                copyBtn.title = 'Copy';
                copyBtn.setAttribute('aria-label', 'Copy prompt');
                copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
                if (bubble) {
                    copyBtn.addEventListener('click', function () {
                        navigator.clipboard.writeText(bubble.innerText || bubble.textContent).then(() => {
                            copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
                            setTimeout(() => { copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`; }, 2000);
                        });
                    });
                }
                const editBtn = document.createElement('button');
                editBtn.className = 'msg-edit-btn';
                editBtn.title = 'Edit';
                editBtn.setAttribute('aria-label', 'Edit message');
                editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
                editBtn.addEventListener('click', () => this.editMessage(msgDiv));
                bar.appendChild(copyBtn);
                bar.appendChild(editBtn);
                content.appendChild(bar);
            }

            editMessage(msgDiv) {
                if (this.state.isProcessing) return;
                const bubble = msgDiv.querySelector('.bubble');
                if (!bubble) return;
                const originalText = bubble.innerText;
                bubble.style.display = 'none';
                const bar = msgDiv.querySelector('.msg-action-bar');
                if (bar) bar.style.display = 'none';
                const editContainer = document.createElement('div');
                editContainer.className = 'msg-edit-container';
                const textarea = document.createElement('textarea');
                textarea.className = 'msg-edit-textarea';
                textarea.value = originalText;
                const actions  = document.createElement('div');
                actions.className = 'msg-edit-actions';
                const saveBtn   = document.createElement('button');
                saveBtn.className   = 'msg-edit-save-btn';
                saveBtn.textContent = 'Save & Resend';
                const cancelBtn = document.createElement('button');
                cancelBtn.className   = 'msg-edit-cancel-btn';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.addEventListener('click', () => { editContainer.remove(); bubble.style.display = ''; if (bar) bar.style.display = ''; });
                saveBtn.addEventListener('click', () => {
                    const newText = textarea.value.trim();
                    if (!newText) return;
                    editContainer.remove(); bubble.style.display = ''; if (bar) bar.style.display = '';
                    this.resendEditedMessage(msgDiv, newText);
                });
                textarea.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
                    if (e.key === 'Escape') cancelBtn.click();
                });
                actions.appendChild(saveBtn);
                actions.appendChild(cancelBtn);
                editContainer.appendChild(textarea);
                editContainer.appendChild(actions);
                msgDiv.querySelector('.message-content').insertBefore(editContainer, bubble);
                textarea.focus();
                textarea.select();
            }

            async resendEditedMessage(msgDiv, newText) {
                const all  = Array.from(this.dom.chatList.querySelectorAll('.message'));
                const idx  = all.indexOf(msgDiv);
                for (let i = idx; i < all.length; i++) all[i].remove();
                if (this.state.chatId) {
                    const trimmed = this.getRawHistory(this.state.chatId).slice(0, idx);
                    this.overwriteHistory(this.state.chatId, trimmed);
                }
                this.dom.input.value = newText;
                await this.handleSend();
            }

            async regenerateMessage(msgDiv) {
                if (this.state.isProcessing) return;
                const all     = Array.from(this.dom.chatList.querySelectorAll('.message'));
                const aiIndex = all.indexOf(msgDiv);
                let userMsg   = null;
                for (let i = aiIndex - 1; i >= 0; i--) { if (all[i].classList.contains('user')) { userMsg = all[i]; break; } }
                if (!userMsg) return;
                const userText  = userMsg.querySelector('.bubble')?.innerText;
                if (!userText) return;
                const userIndex = all.indexOf(userMsg);
                for (let i = userIndex; i < all.length; i++) all[i].remove();
                if (this.state.chatId) {
                    const trimmed = this.getRawHistory(this.state.chatId).slice(0, userIndex);
                    this.overwriteHistory(this.state.chatId, trimmed);
                }
                this.dom.input.value = userText;
                await this.handleSend();
            }

            abortGeneration() { if (this.state.abortController) this.state.abortController.abort(); }

            scrollToBottom() {
                requestAnimationFrame(() => {
                    this.dom.chatContainer.scrollTo({ top: this.dom.chatContainer.scrollHeight, behavior: 'smooth' });
                });
            }

            appendMessage(role, text, isLoading = false) {
                const div     = document.createElement('div');
                div.className = `message ${role}`;
                const avatar  = document.createElement('div');
                avatar.className  = 'avatar';
                avatar.textContent = role === 'user' ? 'U' : 'eS';
                const content = document.createElement('div');
                content.className = 'message-content';
                const bubble  = document.createElement('div');
                bubble.className  = 'bubble';
                if (isLoading) {
                    bubble.innerHTML = `<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
                } else {
                    try {
                        bubble.innerHTML = DOMPurify.sanitize(marked.parse(text));
                        if (window.Prism) Prism.highlightAllUnder(bubble);
                        this.injectCodeButtons(bubble);
                    } catch (_) { bubble.textContent = text; }
                    if (role === 'user' && bubble.querySelector('pre')) bubble.classList.add('has-code');
                }
                content.appendChild(bubble);
                div.appendChild(avatar);
                div.appendChild(content);
                this.dom.chatList.appendChild(div);
                if (role === 'ai'   && !isLoading) this.addCopyButton(div);
                if (role === 'user' && !isLoading) this.addEditButton(div);
                this.scrollToBottom();
                return div;
            }

            injectCodeButtons(container) {
                const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
                const CHECK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
                const DL_ICON    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
                const EXT = { javascript:'js',js:'js',typescript:'ts',ts:'ts',python:'py',py:'py',java:'java',c:'c',cpp:'cpp','c++':'cpp',ruby:'rb',go:'go',rust:'rs',bash:'sh',sh:'sh',shell:'sh',sql:'sql',json:'json',yaml:'yaml',yml:'yaml',html:'html',css:'css',markdown:'md',md:'md',xml:'xml' };
                container.querySelectorAll('pre').forEach(pre => {
                    if (pre.parentElement.classList.contains('code-block-wrapper')) return;
                    const code = pre.querySelector('code');
                    const lm   = code ? code.className.match(/language-(\w+)/) : null;
                    const lang = lm ? lm[1].toLowerCase() : 'code';
                    const wrapper = document.createElement('div');
                    wrapper.className = 'code-block-wrapper';
                    const header  = document.createElement('div');
                    header.className = 'code-header';
                    const label   = document.createElement('span');
                    label.textContent = lang;
                    const btns    = document.createElement('div');
                    btns.className = 'code-header-btns';
                    const copyBtn = document.createElement('button');
                    copyBtn.title = 'Copy'; copyBtn.setAttribute('aria-label','Copy code'); copyBtn.innerHTML = COPY_ICON;
                    copyBtn.onclick = () => { const t = code ? code.textContent : pre.textContent; navigator.clipboard.writeText(t).then(() => { copyBtn.innerHTML = CHECK_ICON; setTimeout(() => { copyBtn.innerHTML = COPY_ICON; }, 2000); }); };
                    const dlBtn = document.createElement('button');
                    dlBtn.title = 'Download'; dlBtn.setAttribute('aria-label','Download code'); dlBtn.innerHTML = DL_ICON;
                    dlBtn.onclick = () => { const t = code ? code.textContent : pre.textContent; const ext = EXT[lang] || 'txt'; const blob = new Blob([t],{type:'text/plain'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `code.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 200); };
                    btns.appendChild(copyBtn); btns.appendChild(dlBtn);
                    header.appendChild(label); header.appendChild(btns);
                    pre.parentNode.insertBefore(wrapper, pre);
                    wrapper.appendChild(header); wrapper.appendChild(pre);
                });
            }

            getRawHistory(chatId) {
                const h = this.getHistory();
                const c = h.find(x => x.id === chatId);
                return c ? c.messages : [];
            }

            overwriteHistory(chatId, newMessages) {
                let all  = this.getHistory();
                const ci = all.findIndex(c => c.id === chatId);
                if (ci !== -1) {
                    all[ci].messages    = newMessages;
                    all[ci].lastUpdated = Date.now();
                    if (all[ci].title === 'Untitled Chat' && newMessages.length > 0) {
                        const fu = newMessages.find(m => m.role === 'user');
                        if (fu) { all[ci].title = fu.content.slice(0, 30) + '…'; this.renderHistoryItem(chatId, all[ci].title); }
                    }
                    localStorage.setItem(this.storageKey, JSON.stringify(all));
                }
            }

            _refreshHistoryFromStorage() {
                this.dom.historyList.innerHTML = '';
                const history = this.getHistory();
                [...history].reverse().forEach(c => { if (c.id) this.renderHistoryItem(c.id, c.title); });
                if (this.state.chatId) {
                    const updated = history.find(c => c.id === this.state.chatId);
                    if (updated) {
                        this.dom.chatList.innerHTML = '';
                        updated.messages.forEach(m => this.appendMessage(m.role, m.content));
                        this.scrollToBottom();
                    }
                }
            }

            loadHistory() {
                const h = this.getHistory();
                [...h].reverse().forEach(c => { if (c.id) this.renderHistoryItem(c.id, c.title); });
            }

            renderHistoryItem(id, title) {
                const existing = document.querySelector(`[data-row-id="${id}"]`);
                if (existing) {
                    const nb = existing.querySelector('.nav-item');
                    if (nb) { nb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>${title}`; nb.onclick = () => this.loadChat(id); }
                    return;
                }
                const row = document.createElement('div');
                row.className = 'nav-item-row';
                row.setAttribute('data-row-id', id);
                const btn = document.createElement('button');
                btn.className = 'nav-item';
                btn.setAttribute('data-id', id);
                btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>${title}`;
                btn.onclick = () => this.loadChat(id);
                const actions = document.createElement('div');
                actions.className = 'nav-item-actions';
                const exportBtn = document.createElement('button');
                exportBtn.className = 'nav-item-action-btn';
                exportBtn.title = 'Export chat';
                exportBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
                exportBtn.onclick = e => { e.stopPropagation(); this.exportSingleChat(id, title); };
                const delBtn = document.createElement('button');
                delBtn.className = 'nav-item-action-btn';
                delBtn.title = 'Delete chat';
                delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
                delBtn.onclick = async e => {
                    e.stopPropagation();
                    const ok = await Utils.confirm(`Delete "${title}"?`, 'Delete Chat');
                    if (!ok) return;
                    let all = this.getHistory();
                    all = all.filter(c => c.id !== id);
                    localStorage.setItem(this.storageKey, JSON.stringify(all));
                    row.remove();
                    if (this.state.chatId === id) this.newChat();
                    Utils.showToast('Chat deleted', 'success');
                };
                actions.appendChild(exportBtn);
                actions.appendChild(delBtn);
                row.appendChild(btn);
                row.appendChild(actions);
                this.dom.historyList.prepend(row);
            }

            loadChat(id) {
                localStorage.setItem(this.LAST_CHAT_KEY, id);
                this.state.chatId = id;
                this.dom.welcome.classList.add('hidden');
                this.dom.chatList.innerHTML = '';
                document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
                const ab = document.querySelector(`button[data-id="${id}"]`);
                if (ab) ab.classList.add('active');
                const h = this.getHistory();
                const c = h.find(x => x.id === id);
                if (c && c.messages) c.messages.forEach(m => this.appendMessage(m.role, m.content));
                this.scrollToBottom();
                if (window.innerWidth <= 768) {
                    this.dom.sidebar.classList.remove('active');
                    this.dom.overlay.classList.remove('active');
                    document.body.style.overflow = '';
                }
                this.updateButtonState();
            }

            saveToHistory(chatObj) {
                let h = this.getHistory();
                h = h.filter(x => x.id !== chatObj.id);
                h.unshift(chatObj);
                if (h.length > 50) h = h.slice(0, 50);
                localStorage.setItem(this.storageKey, JSON.stringify(h));
            }

            newChat() {
                localStorage.removeItem(this.LAST_CHAT_KEY);
                this.state.chatId = null;
                this.state.files.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); });
                this.state.files = [];
                this.dom.filePreview.innerHTML = '';
                this.dom.chatList.innerHTML    = '';
                this.dom.welcome.classList.remove('hidden');
                this.dom.input.focus();
                document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
                const speTa = document.getElementById('spe-textarea');
                if (speTa) speTa.value = '';
                this.updateButtonState();
            }

            exportChat(type) {
                const msgs = Array.from(document.querySelectorAll('.message'));
                if (!msgs.length) return Utils.showToast('Nothing to export', 'error');
                const content = msgs.map(m => `### ${m.classList.contains('user') ? 'User' : 'eSAMz AI'}\n${m.querySelector('.bubble').innerText}`).join('\n\n---\n\n');
                const mimeType = type === 'md' ? 'text/markdown' : 'text/plain';
                const blob = new Blob([content], { type: mimeType });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url; a.download = `esamz-chat-${Date.now()}.${type}`; a.click();
                URL.revokeObjectURL(url);
                document.getElementById('exportDialog').close();
            }

            exportSingleChat(chatId, title) {
                const all  = this.getHistory();
                const chat = all.find(c => c.id === chatId);
                if (!chat || !chat.messages || !chat.messages.length) return Utils.showToast('No messages to export', 'error');
                const content = chat.messages.map(m => `### ${m.role === 'user' ? 'User' : 'eSAMz AI'}\n${m.content}`).join('\n\n---\n\n');
                const blob = new Blob([content], { type: 'text/plain' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url; a.download = `esamz-${title.slice(0,20).replace(/\s+/g,'-')}-${chatId}.txt`; a.click();
                URL.revokeObjectURL(url);
                Utils.showToast('Chat exported', 'success');
            }

            initTheme() {
                const saved       = localStorage.getItem('esamz_theme');
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                const theme       = saved || (prefersDark ? 'dark' : 'light');
                document.body.classList.remove('theme-light', 'theme-dark');
                document.body.classList.add(`theme-${theme}`);
            }

            toggleTheme() {
                const isDark = document.body.classList.contains('theme-dark');
                document.body.classList.remove('theme-dark', 'theme-light');
                document.body.classList.add(isDark ? 'theme-light' : 'theme-dark');
                localStorage.setItem('esamz_theme', isDark ? 'light' : 'dark');
            }
        }

        // ====================================================================
        //  KEYBOARD SHORTCUTS
        // ====================================================================
        (function initKeyboardShortcuts() {
            const modal    = document.getElementById('shortcutsModal');
            const closeBtn = document.getElementById('closeShortcutsModal');
            if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
            if (modal)     modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
            document.addEventListener('keydown', function (e) {
                const ctrl = e.ctrlKey || e.metaKey;
                if (e.key === 'Escape') {
                    if (modal && !modal.classList.contains('hidden'))                           { modal.classList.add('hidden'); e.preventDefault(); return; }
                    const ed = document.getElementById('exportDialog');
                    const cd = document.getElementById('confirmDialog');
                    if (ed && ed.open) { ed.close(); e.preventDefault(); return; }
                    if (cd && cd.open) { cd.close(); e.preventDefault(); return; }
                }
                if (ctrl && e.key === 'k') { e.preventDefault(); document.getElementById('userInput')?.focus(); }
                if (ctrl && e.key === 'n') { e.preventDefault(); window.app?.newChat(); }
                if (ctrl && e.key === 'e') { e.preventDefault(); if (window.app?.state?.chatId) document.getElementById('exportDialog')?.showModal(); else Utils.showToast('No chat to export','error'); }
                if (ctrl && e.shiftKey && e.key === 'D') { e.preventDefault(); window.app?.toggleTheme(); }
                if (ctrl && e.key === 'b') {
                    e.preventDefault();
                    const sb = document.getElementById('sidebar');
                    if (sb) sb.classList.toggle('collapsed');
                }
                if (ctrl && e.key === 'u') { e.preventDefault(); document.getElementById('plansModal')?.classList.remove('hidden'); }
                if (ctrl && e.key === '/') { e.preventDefault(); if (modal) modal.classList.toggle('hidden'); }
            });
        })();

        // ====================================================================
        //  MESSAGE SEARCH
        // ====================================================================
        (function initMessageSearch() {
            const input = document.getElementById('historySearch');
            if (!input) return;
            input.addEventListener('input', function () {
                const q = this.value.trim().toLowerCase();
                document.querySelectorAll('.nav-item-row[data-row-id]').forEach(row => {
                    if (!q) { row.classList.remove('search-hidden'); return; }
                    const text = row.querySelector('.nav-item')?.textContent?.toLowerCase() || '';
                    row.classList.toggle('search-hidden', !text.includes(q));
                });
            });
        })();

        // ====================================================================
        //  SCROLL TO TOP
        // ====================================================================
        (function initScrollTop() {
            const btn       = document.getElementById('scrollTopBtn');
            const container = document.getElementById('chatContainer');
            if (!btn || !container) return;
            container.addEventListener('scroll', () => btn.classList.toggle('visible', container.scrollTop > 300));
            btn.addEventListener('click', () => container.scrollTo({ top: 0, behavior: 'smooth' }));
        })();

        // ====================================================================
        //  CONNECTION PING — polls /health endpoint
        // ====================================================================
        (function initConnectionPing() {
            const dotEl      = document.querySelector('.status-dot');
            const statusText = document.getElementById('statusText');
            if (!dotEl || !statusText) return;
            const latency = document.createElement('span');
            latency.className = 'status-latency';
            latency.id        = 'statusLatency';
            dotEl.parentNode.appendChild(latency);
            async function ping() {
                if (document.getElementById('statusIndicator')?.classList.contains('processing')) return;
                const G = 200, W = 500;
                const start = Date.now();
                try {
                    const sig = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : (() => { const ac = new AbortController(); setTimeout(() => ac.abort(), 5000); return ac.signal; })();
                    await fetch(`${BACKEND_BASE_URL}/health`, { method:'GET', signal:sig, cache:'no-store' });
                    const ms = Date.now() - start;
                    latency.textContent = `· ${ms}ms`;
                    dotEl.classList.remove('quality-warn','quality-bad');
                    if (ms < G) dotEl.classList.add('quality-good');
                    else if (ms < W) { dotEl.classList.remove('quality-good'); dotEl.classList.add('quality-warn'); }
                    else { dotEl.classList.remove('quality-good'); dotEl.classList.add('quality-bad'); }
                } catch(_) { latency.textContent = '· Offline'; dotEl.classList.remove('quality-good','quality-warn'); dotEl.classList.add('quality-bad'); }
            }
            ping();
            setInterval(ping, 30000);
        })();

        // ====================================================================
        //  BOOT
        // ====================================================================
        // Clean up stale PeerJS localStorage keys from previous versions
        ['esamz_peer_code', 'esamz_known_peers', 'esamz_blacklist'].forEach(k => localStorage.removeItem(k));

        window.app = new App();

        // ====================================================================
        //  TIER SYNC — fetch real tier from MongoDB via /api/user/tier
        // ====================================================================
        async function syncTierFromServer() {
            if (!window.__clerk?.isSignedIn) return;
            try {
                const res = await fetch('/api/user/tier');
                if (!res.ok) return;
                const data = await res.json();
                const VALID_PLANS = ['Plus', 'Pro', 'Max'];
                if (data.tier && VALID_PLANS.includes(data.tier)) {
                    localStorage.setItem(LS_PLAN, data.tier);
                } else {
                    localStorage.removeItem(LS_PLAN);
                }
                checkPermissions();
            } catch (_) { /* server offline — keep existing localStorage value */ }
        }

        // Expose so ClerkBridge can trigger sync on sign-in
        window.__syncTierFromServer = syncTierFromServer;

        // Sync immediately if user is already signed in on page load
        syncTierFromServer();

        // ====================================================================
        //  FIX P8: Privacy status — fetch /api/privacy-status and show badge
        // ====================================================================
        (async function syncPrivacyStatus() {
            try {
                const res  = await fetch(`${BACKEND_BASE_URL}/api/privacy-status`, { credentials: 'include' });
                if (!res.ok) return;
                const data = await res.json();
                const disclaimerSpan = document.getElementById('disclaimerText');
                if (!disclaimerSpan) return;
                const ragLabel = data.rag        ? ` · RAG: ${data.rag}` : '';
                const retLabel = data.dataRetentionMinutes
                    ? ` · Session cleared after ${data.dataRetentionMinutes}m idle`
                    : '';
                const badge = document.createElement('span');
                badge.style.cssText = 'margin-left:10px;font-family:"DM Mono",monospace;font-size:9px;color:var(--ink-ghost);letter-spacing:0.06em;opacity:0.8;';
                badge.textContent   = `${data.privacyMode ? '🔒 Zero-storage' : '🗄 Session memory'}${ragLabel}${retLabel}`;
                disclaimerSpan.parentNode.appendChild(badge);
            } catch (_) { /* backend offline — no badge shown */ }
        })();

    })()
  }, [])

  return (
    <>
    {hasClerk && mounted && <ClerkBridge />}
    
    
    <div className="cibo-modal-overlay hidden" id="ciboModal">
        <div className="cibo-modal">
            <button className="cibo-modal-close" id="ciboModalClose" aria-label="Close">✕</button>
            <div className="cibo-modal-emoji">🍳</div>
            <h2>Try Cibo Cocinar</h2>
            <p>Voice-powered AI cooking assistance — step-by-step guidance, recipes, and culinary wisdom, entirely hands-free.</p>
            <div className="cibo-modal-actions">
                <a href="https://cibo.esamz.site" target="_blank" rel="noopener" className="cibo-modal-btn cibo-modal-btn-primary">Try Cibo Now</a>
                <button className="cibo-modal-btn cibo-modal-btn-secondary" id="ciboModalDismiss">Maybe Later</button>
            </div>
        </div>
    </div>

    
    <div className="plans-modal-overlay hidden" id="plansModal" role="dialog" aria-modal="true" aria-labelledby="plansModalTitle">
        <div className="plans-modal">
            <button className="plans-modal-close" id="plansModalClose" aria-label="Close">✕</button>
            <div className="plans-modal-header">
                <div className="plans-modal-eyebrow">eSAMz AI — Plans &amp; Pricing</div>
                <div className="plans-modal-title" id="plansModalTitle">Choose your plan</div>
                <div className="plans-modal-sub">Unlock advanced features with a premium subscription.</div>
            </div>
            <div className="plans-modal-body">
                <div className="plans-grid">
                    <div className="plan-card">
                        <div className="plan-card-icon">⚡</div>
                        <div className="plan-card-content">
                            <div className="plan-card-header">
                                <div className="plan-card-name">Plus</div>
                                <div className="plan-card-price">₹99/mo</div>
                            </div>
                            <ul className="plan-card-features">
                                <li>RAG always on</li>
                                <li>Wikipedia + web search</li>
                                <li>50 messages/day</li>
                            </ul>
                        </div>
                    </div>
                    <div className="plan-card">
                        <div className="plan-card-icon">🚀</div>
                        <div className="plan-card-content">
                            <div className="plan-card-header">
                                <div className="plan-card-name">Pro</div>
                                <div className="plan-card-price">₹199/mo</div>
                            </div>
                            <ul className="plan-card-features">
                                <li>Everything in Plus</li>
                                <li>RAG on/off toggle</li>
                                <li>100 messages/day</li>
                            </ul>
                        </div>
                    </div>
                    <div className="plan-card">
                        <div className="plan-card-icon">♾️</div>
                        <div className="plan-card-content">
                            <div className="plan-card-header">
                                <div className="plan-card-name">Max</div>
                                <div className="plan-card-price">₹499/mo</div>
                            </div>
                            <ul className="plan-card-features">
                                <li>Everything in Pro</li>
                                <li>Custom system prompt editor</li>
                                <li>1000 messages/day</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <a href="https://payments.cashfree.com/forms/esamz-ai" className="plans-upgrade-btn" target="_blank" rel="noopener">Get a Plan →</a>
            </div>
        </div>
    </div>

    <div id="toast-container"></div>
    <div className="overlay" id="overlay"></div>

    <div className="app-container">
        
        <aside className="sidebar" id="sidebar">
            <div className="sidebar-header">
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:"14px"}}>
                    <div className="brand" style={{marginBottom:0}}>
                        <div className="brand-eyebrow">Strategic Mind</div>
                        <div className="brand-name">e<span>S</span>AMz</div>
                        <div className="brand-tagline">Understands in 2 messages, not 2 years.</div>
                    </div>
                    <button className="btn-sidebar-close" id="btnCloseSidebar" title="Close sidebar" aria-label="Close sidebar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6"/></svg>
                    </button>
                </div>
                <button className="btn-new-chat" id="btnNewChat">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
                    New Conversation
                </button>
                <button className="btn-view-plans" id="btnViewPlans">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                    View Plans
                </button>
            </div>
            <div className="sidebar-nav">
                <div className="search-box">
                    <input type="search" id="historySearch" className="search-input" placeholder="Search conversations…" aria-label="Search conversations" autoComplete="off" />
                </div>
                <div className="nav-section">
                    <div className="nav-label">Recent</div>
                    <div id="historyList"></div>
                </div>
                <div className="nav-section">
                    <div className="nav-label">Tools</div>
                    <a href="https://cibo.esamz.site" className="nav-item" target="_blank" rel="noopener">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><path d="M7 2v20M21 15V2a5 5 0 00-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>
                        Cibo Cocinar
                    </a>
                </div>
            </div>

            
            <div className="sidebar-footer">
                <div id="planBadgeContainer"></div>
                <div className="sidebar-footer-text">© <a href="https://esamz.info" target="_blank" rel="noopener">eSAMz AI</a> 2026 All rights reserved</div>
            </div>
        </aside>

        
        <main className="main-content">
            <header className="header">
                <div style={{display:"flex",alignItems:"center",gap:"14px"}}>
                    
                    <button className="icon-btn mobile-toggle" id="openSidebar" aria-label="Open menu">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    </button>
                    
                    <button className="icon-btn btn-open-sidebar-desktop" id="btnOpenSidebarDesktop" title="Open sidebar" aria-label="Open sidebar">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    </button>
                    <div className="status-pill" id="statusIndicator">
                        <div className="status-dot"></div>
                        <span id="statusText">Ready</span>
                    </div>
                </div>
                <div className="header-right">
                    <div id="clerkUserButton" style={{display:"flex",alignItems:"center"}}>{hasClerk && UserButton && <UserButton />}</div>
                    <button className="theme-toggle" id="btnThemeToggle" title="Toggle theme" aria-label="Toggle theme">
                        <svg className="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                        <svg className="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                    </button>
                    <button className="btn-clear" id="btnExportChat" title="Export chat">Export</button>
                    <button className="btn-clear" id="btnClearChat">Clear Chat</button>
                </div>
            </header>

            <div className="chat-container" id="chatContainer">
                <div className="chat-wrapper">
                    <div className="welcome" id="welcomeScreen">
                        <div className="welcome-dateline">eSAMz AI · Strategic Artificial Mind</div>
                        <h1 className="welcome-headline" id="welcomeHeadline">Ask anything.<br />Think <em>deeper</em>.</h1>
                        <p className="welcome-deck">Deep reasoning with emotional clarity — for complex problems that demand more than a quick answer.</p>
                        <div className="welcome-rule"></div>
                        <div className="suggestions">
                            <div className="suggestion-card" data-prompt="Write a Python script for data analysis">
                                <div className="suggestion-header"><span className="suggestion-kicker"><span className="suggestion-kicker-icon">🐍</span>Code</span><span className="suggestion-arrow">→</span></div>
                                <div className="suggestion-title">Python Data Analysis</div>
                                <div className="suggestion-desc">Generate efficient scripts &amp; logic</div>
                            </div>
                            <div className="suggestion-card" data-prompt="Explain quantum computing concepts">
                                <div className="suggestion-header"><span className="suggestion-kicker"><span className="suggestion-kicker-icon">🧠</span>Learn</span><span className="suggestion-arrow">→</span></div>
                                <div className="suggestion-title">Deep Explanations</div>
                                <div className="suggestion-desc">Complex topics made crystal clear</div>
                            </div>
                            <div className="suggestion-card" data-prompt="Draft a professional business proposal">
                                <div className="suggestion-header"><span className="suggestion-kicker"><span className="suggestion-kicker-icon">✍️</span>Write</span><span className="suggestion-arrow">→</span></div>
                                <div className="suggestion-title">Professional Writing</div>
                                <div className="suggestion-desc">Proposals, emails, reports &amp; more</div>
                            </div>
                            <div className="suggestion-card" data-prompt="Research latest AI developments">
                                <div className="suggestion-header"><span className="suggestion-kicker"><span className="suggestion-kicker-icon">🔬</span>Research</span><span className="suggestion-arrow">→</span></div>
                                <div className="suggestion-title">Current Trends</div>
                                <div className="suggestion-desc">Insights backed by deep reasoning</div>
                            </div>
                        </div>
                    </div>
                    <div id="chatList"></div>
                </div>
            </div>

            
            <div className="input-wrapper">
                <div className="input-container">
                    <div className="input-box">
                        <div className="file-preview" id="filePreview"></div>
                        <span className="draft-indicator" id="draftIndicator">Draft saved</span>
                        <div className="input-row">
                            <button className="icon-btn" id="btnUpload" title="Attach file" aria-label="Attach file">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                            </button>
                            <textarea id="userInput" rows="1" placeholder="Ask eSAMz anything…"></textarea>
                            <button className="send-btn" id="btnSend" disabled aria-label="Send message">
                                <svg className="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                                <svg className="stop-icon hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                            </button>
                        </div>

                        
                        <div id="rag-toggle-wrapper" role="group" aria-label="RAG settings">
                            <label id="rag-toggle-label" htmlFor="rag-toggle">
                                <input type="checkbox" id="rag-toggle" defaultChecked />
                                <span className="toggle-track"></span>
                                Web search
                            </label>
                            <span className="rag-pro-badge">PRO</span>
                        </div>

                        
                        <div id="system-prompt-editor" role="group" aria-label="Custom system prompt">
                            <div className="spe-header">
                                <div className="spe-label">
                                    <span>System Prompt</span>
                                    <span className="spe-max-badge">MAX</span>
                                </div>
                                <button className="spe-toggle-btn" id="btnToggleSpe">Edit ↓</button>
                            </div>
                            <textarea
                                id="spe-textarea"
                                placeholder="Override the default system prompt for this session. Leave empty to use the default."
                                rows="3"
                                spellCheck="false"
                                aria-label="Custom system prompt"
                            ></textarea>
                            <div className="spe-hint" id="speHint" style={{display:"none"}}>Changes apply from your next message. Cleared when you start a new chat.</div>
                        </div>
                    </div>
                    <div className="input-footer">
                        <span style={{fontFamily:"'DM Mono'",fontSize:"9px",border:"1.5px solid var(--vermillion-soft)",padding:"2px 6px",borderRadius:"6px",marginRight:"8px",verticalAlign:"middle",color:"var(--vermillion)",background:"var(--vermillion-soft)"}}>SGI</span>
                        <span style={{fontSize:"14px",marginRight:"4px",verticalAlign:"middle"}}>🤖</span>
                        <span style={{verticalAlign:"middle"}} id="disclaimerText">
                            eSAMz AI generates synthetic content and may be inaccurate.
                            By using this service, you agree to our
                            <a href="https://esamz.info/privacypolicy" target="_blank" rel="noopener" style={{fontWeight:600}}>Privacy Policy</a> &amp;
                            <a href="https://esamz.info/termsofservice" target="_blank" rel="noopener" style={{fontWeight:600}}>Terms</a>.
                        </span>
                        <span id="charCount" className="char-count"></span>
                        <span style={{display:"inline-block",marginLeft:"10px",verticalAlign:"middle",fontFamily:"'DM Mono'",fontSize:"9px",color:"var(--ink-ghost)",opacity:0.6}}>
                            <kbd style={{background:"var(--paper-aged)",border:"1.5px solid var(--rule-bold)",borderBottomWidth:"3px",padding:"1px 5px",borderRadius:"4px",fontFamily:"'DM Mono'",fontSize:"9px"}}>Ctrl</kbd>
                            {' '}<kbd style={{background:"var(--paper-aged)",border:"1.5px solid var(--rule-bold)",borderBottomWidth:"3px",padding:"1px 5px",borderRadius:"4px",fontFamily:"'DM Mono'",fontSize:"9px"}}>/</kbd> shortcuts
                        </span>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <input type="file" id="fileInput" hidden multiple accept=".txt,.md,.js,.py,.html,.css,.json,.java,.cpp,.c,.ts,.jsx,.tsx,.php,.rb,.go,.rs,.swift,.kt,.xml,.yaml,.yml,.sh,.sql,.csv,.log,.ini,.conf,.png,.jpg,.jpeg,.gif,.bmp,.webp" />

    <button className="scroll-top-btn" id="scrollTopBtn" title="Scroll to top" aria-label="Scroll to top">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
    </button>

    
    <div className="shortcuts-modal-overlay hidden" id="shortcutsModal">
        <div className="shortcuts-modal">
            <div className="shortcuts-modal-header">
                <span>Keyboard Shortcuts</span>
                <button className="icon-btn" id="closeShortcutsModal" aria-label="Close" style={{color:"var(--ink-faint)"}}>✕</button>
            </div>
            <div className="shortcuts-list">
                <div className="shortcut-row"><span>Focus input</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>K</kbd></div></div>
                <div className="shortcut-row"><span>New conversation</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>N</kbd></div></div>
                <div className="shortcut-row"><span>Export chat</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>E</kbd></div></div>
                <div className="shortcut-row"><span>Toggle theme</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>D</kbd></div></div>
                <div className="shortcut-row"><span>Toggle sidebar</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>B</kbd></div></div>
                <div className="shortcut-row"><span>Manage subscription</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>U</kbd></div></div>
                <div className="shortcut-row"><span>Close modal</span><div className="shortcut-keys"><kbd>Esc</kbd></div></div>
                <div className="shortcut-row"><span>Show shortcuts</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>/</kbd></div></div>
            </div>
        </div>
    </div>

    
    <dialog id="exportDialog">
        <div className="dialog-header">
            <span>Export Conversation</span>
            <button className="icon-btn" id="closeDialog" aria-label="Close dialog" style={{color:"var(--ink-faint)"}}>✕</button>
        </div>
        <div className="dialog-body">
            <button className="dialog-option" data-export-type="txt">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Plain Text (.txt)
            </button>
            <button className="dialog-option" data-export-type="md">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Markdown (.md)
            </button>
        </div>
    </dialog>

    <dialog id="confirmDialog">
        <div className="dialog-header">
            <span id="confirmTitle">Confirm</span>
        </div>
        <div className="dialog-body">
            <p id="confirmMessage" style={{color:"var(--ink-faint)",marginBottom:0,fontStyle:"italic",fontSize:"14px"}}></p>
            <div className="dialog-actions">
                <button className="btn-secondary" id="confirmCancel">Cancel</button>
                <button className="btn-primary" id="confirmOk">Confirm</button>
            </div>
        </div>
    </dialog>

    </>
  )
}

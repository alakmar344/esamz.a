// @ts-nocheck
'use client'

import { useEffect, useRef } from 'react'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __clerk: {
      isSignedIn: boolean
      openSignIn: () => void
      getToken: () => Promise<string | null>
    }
    app: any
    marked: any
    DOMPurify: any
    Prism: any
    Tesseract: any
    Paddle: any
    ort: any
    cv: any
    dataLayer: any[]
  }
}

import { UserButton } from "@clerk/nextjs";

const hasClerk = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
const DEBUG_CHAT_STREAM_LOGS = process.env.NEXT_PUBLIC_DEBUG_CHAT_STREAM === 'true'

export default function ChatPage() {
  const appInitialized = useRef(false)

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
        const BACKEND_CHAT_URL_ANON = 'https://backend.esamz.site/api/chat';
        const BACKEND_BASE_URL    = 'https://backend.esamz.site';

        const LS_STORAGE   = 'esamz_conversations_v9';
        const LS_LAST_CHAT = 'esamz_last_chat_id';
        const LS_PRIVACY_POLICY_ACCEPTED_AT = 'esamz_privacy_policy_accepted_at';
        const LS_PRIVACY_POLICY_SYNCED = 'esamz_privacy_policy_synced_to_db';
        const PRIVACY_POLICY_URL = 'https://esamz.info/privacypolicy';
        const TERMS_OF_SERVICE_URL = 'https://esamz.info/termsofservice';
        const CHAR_COUNT_DISPLAY_THRESHOLD = 3200;
        const TYPEWRITER_INTERVAL_MS = 18;
        const TYPEWRITER_SPEED_STEPS = {
            veryFastThreshold: 160,
            fastThreshold: 80,
            mediumThreshold: 30,
            veryFastChunk: 10,
            fastChunk: 6,
            mediumChunk: 3,
            slowChunk: 2,
        };
        const getTypewriterChunkSize = remaining => {
            if (remaining > TYPEWRITER_SPEED_STEPS.veryFastThreshold) return TYPEWRITER_SPEED_STEPS.veryFastChunk;
            if (remaining > TYPEWRITER_SPEED_STEPS.fastThreshold) return TYPEWRITER_SPEED_STEPS.fastChunk;
            if (remaining > TYPEWRITER_SPEED_STEPS.mediumThreshold) return TYPEWRITER_SPEED_STEPS.mediumChunk;
            return TYPEWRITER_SPEED_STEPS.slowChunk;
        };

        // ====================================================================
        //  UTILITIES
        // ====================================================================
        const Utils = {
            get toastContainer() { return document.getElementById('toast-container'); },
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
                this.toastContainer?.appendChild(t);
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
                    const titleEl = document.getElementById('confirmTitle');
                    const msgEl   = document.getElementById('confirmMessage');
                    if (titleEl) titleEl.textContent = title;
                    if (msgEl)   msgEl.textContent   = message;
                    const ok  = document.getElementById('confirmOk');
                    const cancel = document.getElementById('confirmCancel');
                    if (!dlg || !ok || !cancel) { resolve(false); return; }
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
        //  FEATURE INIT — all users are Max tier, always show RAG + SPE
        // ====================================================================
        function initFeatures() {
            const ragWrapper = document.getElementById('rag-toggle-wrapper');
            const ragToggle  = document.getElementById('rag-toggle');
            const spe        = document.getElementById('system-prompt-editor');
            ragWrapper?.classList.add('visible');
            if (ragToggle) ragToggle.disabled = false;
            spe?.classList.add('visible');
        }

        // ====================================================================
        //  SYSTEM PROMPT EDITOR
        // ====================================================================
        (function initSpe() {
            const toggleBtn = document.getElementById('btnToggleSpe');
            const textarea  = document.getElementById('spe-textarea');
            const hint      = document.getElementById('speHint');

            if (!toggleBtn) return;

            toggleBtn.addEventListener('click', () => {
                if (!textarea || !hint) return;
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
        //  MAIN APP CLASS
        // ====================================================================
        class App {
            constructor() {
                this.state = {
                    chatId: null, files: [],
                    isProcessing: false, abortController: null
                };
                this.storageKey  = LS_STORAGE;
                this.LAST_CHAT_KEY = LS_LAST_CHAT;
                this.init();
            }

            init() {
                this.dom = {
                    chatList:    document.getElementById('chatList'),
                    input:       document.getElementById('userInput'),
                    welcome:     document.getElementById('welcomeScreen'),
                    historyList: document.getElementById('historyList'),
                    filePreview: document.getElementById('filePreview'),
                    sidebar:     document.getElementById('sidebar'),
                    overlay:     document.getElementById('overlay'),
                    sendBtn:     document.getElementById('btnSend'),
                    sendIcon:    document.querySelector('.send-icon'),
                    privacyAgreement: document.getElementById('privacyAgreement'),
                    privacyAgreementCheckbox: document.getElementById('privacyAgreementCheckbox'),
                    privacyAgreementStatus: document.getElementById('privacyAgreementStatus'),
                    stopIcon:    document.querySelector('.stop-icon'),
                    chatContainer: document.getElementById('chatContainer'),
                    uploadBtn:   document.getElementById('btnUpload'),
                    fileInput:   document.getElementById('fileInput'),
                    newChatBtn:  document.getElementById('btnNewChat'),
                    mobileNewChatBtn: document.getElementById('mobileNewChatBtn'),
                    clearChatBtn:document.getElementById('btnClearChat'),
                    themeToggle: document.getElementById('btnThemeToggle'),
                    closeSidebarBtn:        document.getElementById('btnCloseSidebar'),
                    openSidebarDesktopBtn:  document.getElementById('btnOpenSidebarDesktop'),
                    openSidebarMobileBtn:   document.getElementById('openSidebar'),
                    openSidebarBottomBtn:   document.getElementById('openSidebarBottom'),
                    headerActionsToggle:    document.getElementById('headerActionsToggle'),
                    headerActionsMenu:      document.getElementById('headerActionsMenu'),
                    menuNewChatBtn:         document.getElementById('menuNewChatBtn'),
                    btnRevokeConsent:       document.getElementById('btnRevokeConsent'),
                    consentModal:           document.getElementById('consentModal'),
                    consentModalCheckbox:   document.getElementById('consentModalCheckbox'),
                    consentModalContinue:   document.getElementById('consentModalContinue'),
                    anonymousNotice:        document.getElementById('anonymousNotice'),
                    preLoginBanner:         document.getElementById('preLoginBanner'),
                    menuExportCurrentJsonBtn: document.getElementById('menuExportCurrentJsonBtn'),
                    menuExportCurrentMdBtn: document.getElementById('menuExportCurrentMdBtn'),
                    menuExportAllJsonBtn:   document.getElementById('menuExportAllJsonBtn'),
                    menuExportAllMdBtn:     document.getElementById('menuExportAllMdBtn'),
                    menuClearChatBtn:       document.getElementById('menuClearChatBtn'),
                };
                this.initTheme();

                initFeatures();

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
                this.dom.input?.focus();
            }

            updatePrivacyAgreementVisibility() {
                const isSignedIn = !!window.__clerk?.isSignedIn;
                const acceptedAt = localStorage.getItem(LS_PRIVACY_POLICY_ACCEPTED_AT);

                // 1. Pre-login banner (only for guest users)
                if (this.dom.preLoginBanner) {
                    this.dom.preLoginBanner.style.display = !isSignedIn ? 'block' : 'none';
                }

                // 2. Anonymous notice (only for guest users)
                if (this.dom.anonymousNotice) {
                    this.dom.anonymousNotice.style.display = !isSignedIn ? 'block' : 'none';
                }

                // 3. Consent Modal (for ALL users who haven't accepted — shown BEFORE sign-in)
                if (!acceptedAt) {
                    this.dom.consentModal?.classList.remove('hidden');
                    // Update button text based on sign-in state
                    if (this.dom.consentModalContinue) {
                        this.dom.consentModalContinue.textContent = isSignedIn ? 'Agree & Continue' : 'Agree & Sign In';
                    }
                    requestAnimationFrame(() => {
                        this.dom.consentModal?.classList.add('consent-modal-visible');
                    });
                } else {
                    this.dom.consentModal?.classList.remove('consent-modal-visible');
                    setTimeout(() => {
                        this.dom.consentModal?.classList.add('hidden');
                    }, 300);
                }

                // 4. Revoke Consent button visibility
                if (this.dom.btnRevokeConsent) {
                    this.dom.btnRevokeConsent.style.display = (isSignedIn && acceptedAt) ? 'block' : 'none';
                }

                // 5. Sync local consent to DB if user signed in after accepting locally
                if (isSignedIn && acceptedAt && !localStorage.getItem(LS_PRIVACY_POLICY_SYNCED)) {
                    this.syncConsentToServer(acceptedAt);
                }

                this.updateButtonState();
            }

            async syncConsentToServer(localAcceptedAt) {
                try {
                    const res = await fetch('/api/user/privacy-policy-acceptance', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({
                            accepted: true,
                            policyUrl: PRIVACY_POLICY_URL,
                            source: 'consent-sync-after-signin',
                            localAcceptedAt,
                        }),
                    });
                    if (res.ok) {
                        localStorage.setItem(LS_PRIVACY_POLICY_SYNCED, 'true');
                        console.log('[Privacy Policy] Local consent synced to DB after sign-in');
                    } else {
                        console.warn('[Privacy Policy] Sync to DB failed:', res.status);
                    }
                } catch (err) {
                    console.warn('[Privacy Policy] Sync to DB error:', err);
                }
            }

            async handleRevokeConsent() {
                // Step 1: First warning
                if (!await Utils.confirm(
                    '⚠ WARNING: This will permanently delete ALL your data — your account, chat history, MongoDB logs, browser cache, and Clerk user record. You will be completely removed from our system and must re-consent and sign up again to use eSAMz AI.',
                    'Delete My Data'
                )) return;

                // Step 2: Final confirmation with "Confirm Anyway" button
                if (!await Utils.confirm(
                    'This is your LAST chance. Once you confirm, there is NO WAY to recover your data. Are you absolutely sure?',
                    '⚠ This Cannot Be Undone'
                )) return;

                try {
                    Utils.showToast('Deleting your account and all data...', 'info');

                    const res = await fetch('/api/user/privacy-policy-acceptance/revoke', { method: 'POST' });
                    if (!res.ok) throw new Error('Account deletion failed');

                    const data = await res.json();

                    // ─── Clear all localStorage ──────────────────────────────
                    localStorage.clear();

                    // ─── Clear all sessionStorage ──────────────────────────────
                    sessionStorage.clear();

                    // ─── Clear all cookies (including httpOnly ones via server path) ──
                    document.cookie.split(';').forEach(c => {
                        const name = c.split('=')[0].trim();
                        // Delete on current path and root path
                        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
                        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${location.hostname}`;
                        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.${location.hostname}`;
                    });

                    // ─── Clear all caches (Cache API, Service Worker caches) ───
                    if ('caches' in window) {
                        try {
                            const cacheNames = await caches.keys();
                            await Promise.all(cacheNames.map(name => caches.delete(name)));
                        } catch (cacheErr) {
                            console.warn('Cache API clear failed:', cacheErr);
                        }
                    }

                    // ─── Unregister all service workers ────────────────────────
                    if ('serviceWorker' in navigator) {
                        try {
                            const registrations = await navigator.serviceWorker.getRegistrations();
                            await Promise.all(registrations.map(reg => reg.unregister()));
                        } catch (swErr) {
                            console.warn('Service worker unregister failed:', swErr);
                        }
                    }

                    // ─── Clear IndexedDB ──────────────────────────────────────
                    try {
                        const dbs = await indexedDB.databases?.() || [];
                        await Promise.all(dbs.map(db => {
                            if (db.name) indexedDB.deleteDatabase(db.name);
                        }));
                        // Fallback for browsers without indexedDB.databases()
                        if (!indexedDB.databases) {
                            // Try common Clerk/Next.js indexedDB names
                            ['clerk-db', '__clerk_db', 'next-auth'].forEach(name => {
                                try { indexedDB.deleteDatabase(name); } catch (_) {}
                            });
                        }
                    } catch (idbErr) {
                        console.warn('IndexedDB clear failed:', idbErr);
                    }

                    Utils.showToast('Account deleted. All data and cache cleared. Redirecting...', 'success');

                    // ─── Force full page reload (bypass cache) ─────────────────
                    setTimeout(() => {
                        // Use replace to prevent back-navigation to deleted session
                        window.location.replace(window.location.origin + window.location.pathname + '?cleared=' + Date.now());
                    }, 2000);
                } catch (err) {
                    console.error('Account deletion error:', err);
                    Utils.showToast('Failed to delete account. Please try again.', 'error');
                }
            }

            async handlePrivacyAgreementChange(source = 'modal') {
                const checkbox = source === 'modal' ? this.dom.consentModalCheckbox : this.dom.privacyAgreementCheckbox;
                const btn = source === 'modal' ? this.dom.consentModalContinue : null;
                
                if (!checkbox || !checkbox.checked) return;

                if (!window.__clerk?.isSignedIn) {
                    // Save consent locally first, then prompt sign-in
                    const acceptedAt = new Date().toISOString();
                    localStorage.setItem(LS_PRIVACY_POLICY_ACCEPTED_AT, acceptedAt);
                    Utils.showToast('Consent saved. Please sign in to continue.', 'success');
                    this.updatePrivacyAgreementVisibility();
                    // Open sign-in after a brief delay so the user sees the toast
                    setTimeout(() => { window.__clerk?.openSignIn(); }, 600);
                    return;
                }

                if (btn) btn.disabled = true;
                checkbox.disabled = true;

                try {
                    const res = await fetch('/api/user/privacy-policy-acceptance', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({
                            accepted: true,
                            policyUrl: PRIVACY_POLICY_URL,
                            source: `consent-${source}`,
                        }),
                    });

                    if (!res.ok) throw new Error('Acceptance log failed');
                    const data = await res.json();
                    const acceptedAt = data.acceptedAt || new Date().toISOString();
                    localStorage.setItem(LS_PRIVACY_POLICY_ACCEPTED_AT, acceptedAt);
                    localStorage.setItem(LS_PRIVACY_POLICY_SYNCED, 'true');
                    
                    Utils.showToast('Privacy policy agreement saved', 'success');
                    this.updatePrivacyAgreementVisibility();
                } catch (_) {
                    checkbox.checked = false;
                    checkbox.disabled = false;
                    if (btn) btn.disabled = false;
                    Utils.showToast('Could not save privacy policy agreement', 'error');
                }
            }


            getHistory() {
                const r = localStorage.getItem(this.storageKey);
                return r ? JSON.parse(r) : [];
            }

            setupEventListeners() {
              const required = [
  this.dom.input,
  this.dom.sendBtn,
  this.dom.chatList,
  this.dom.chatContainer,
  this.dom.sidebar
];

if (required.some(el => !el)) {
  console.error('Missing DOM elements during setup:', this.dom);
  return;
}
                const SIDEBAR_VISIBLE_PEEK_HEIGHT = 72;
                const DRAG_CLOSE_THRESHOLD = 0.5;
                this.dom.input?.addEventListener('focus', () => {
                    if (!requireSignIn()) {
                        this.dom.input?.blur();
                    }
                });
                this.dom.input?.addEventListener('input', () => this.handleInput());
                this.dom.input?.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this.state.isProcessing ? this.abortGeneration() : this.handleSend();
                    }
                });
                this.dom.sendBtn?.addEventListener('click', () => {
                    this.state.isProcessing ? this.abortGeneration() : this.handleSend();
                });
                this.dom.newChatBtn?.addEventListener('click',  () => this.newChat());

                // FIX P6: Clear Chat also calls DELETE /api/session to wipe server-side memory
                const clearChatAction = async () => {
                    if (await Utils.confirm('Clear current chat session?', 'Clear Chat')) {
                        try {
                            await fetch(`${BACKEND_BASE_URL}/api/session`, {
                                method: 'DELETE',
                                credentials: 'include',
                            });
                        } catch (_) { /* offline — local clear still proceeds */ }
                        this.newChat();
                    }
                };
                this.dom.clearChatBtn?.addEventListener('click', clearChatAction);

                this.dom.privacyAgreementCheckbox?.addEventListener('change', () => this.handlePrivacyAgreementChange('inline'));
                this.dom.consentModalCheckbox?.addEventListener('change', (e) => {
                    if (this.dom.consentModalContinue) this.dom.consentModalContinue.disabled = !e.target.checked;
                });
                this.dom.consentModalContinue?.addEventListener('click', () => this.handlePrivacyAgreementChange('modal'));
                this.dom.btnRevokeConsent?.addEventListener('click', () => this.handleRevokeConsent());
                this.updatePrivacyAgreementVisibility();

                if (this.dom.uploadBtn && this.dom.fileInput) {
                    this.dom.uploadBtn.addEventListener('click', () => this.dom.fileInput?.click());
                    this.dom.fileInput.addEventListener('change', e => this.handleFiles(e.target.files));
                }

                if (this.dom.menuNewChatBtn) this.dom.menuNewChatBtn.addEventListener('click', () => {
                    this.newChat();
                    this.dom.headerActionsMenu?.classList.remove('open');
                });
                if (this.dom.menuExportCurrentJsonBtn) this.dom.menuExportCurrentJsonBtn.addEventListener('click', () => {
                    this.exportChats('current', 'json');
                    this.dom.headerActionsMenu?.classList.remove('open');
                });
                if (this.dom.menuExportCurrentMdBtn) this.dom.menuExportCurrentMdBtn.addEventListener('click', () => {
                    this.exportChats('current', 'md');
                    this.dom.headerActionsMenu?.classList.remove('open');
                });
                if (this.dom.menuExportAllJsonBtn) this.dom.menuExportAllJsonBtn.addEventListener('click', () => {
                    this.exportChats('all', 'json');
                    this.dom.headerActionsMenu?.classList.remove('open');
                });
                if (this.dom.menuExportAllMdBtn) this.dom.menuExportAllMdBtn.addEventListener('click', () => {
                    this.exportChats('all', 'md');
                    this.dom.headerActionsMenu?.classList.remove('open');
                });
                if (this.dom.menuClearChatBtn) this.dom.menuClearChatBtn.addEventListener('click', async () => {
                    this.dom.headerActionsMenu?.classList.remove('open');
                    await clearChatAction();
                });
                if (this.dom.headerActionsToggle) {
                    this.dom.headerActionsToggle.addEventListener('click', e => {
                        e.stopPropagation();
                        this.dom.headerActionsMenu?.classList.toggle('open');
                    });
                }
                document.addEventListener('click', e => {
                    if (!this.dom.headerActionsMenu?.classList.contains('open')) return;
                    if (this.dom.headerActionsMenu.contains(e.target) || this.dom.headerActionsToggle?.contains(e.target)) return;
                    this.dom.headerActionsMenu.classList.remove('open');
                });
                // Mobile sidebar
                const openMobileSidebar = () => {
                    this.dom.sidebar.classList.add('active');
                    this.dom.overlay?.classList.add('active');
                    this.dom.openSidebarBottomBtn?.classList.add('is-hidden');
                    this.dom.sidebar.style.removeProperty('transform');
                    this.dom.sidebar.style.removeProperty('transition');
                    this.dom.overlay?.style.removeProperty('opacity');
                    document.body.style.overflow = 'hidden';
                };
                const closeMobileSidebar = () => {
                    this.dom.sidebar.classList.remove('active');
                    this.dom.overlay?.classList.remove('active');
                    this.dom.openSidebarBottomBtn?.classList.remove('is-hidden');
                    this.dom.sidebar.style.removeProperty('transform');
                    this.dom.sidebar.style.removeProperty('transition');
                    this.dom.overlay?.style.removeProperty('opacity');
                    document.body.style.overflow = '';
                };
                if (this.dom.openSidebarMobileBtn) this.dom.openSidebarMobileBtn.addEventListener('click', openMobileSidebar);
                if (this.dom.openSidebarBottomBtn) this.dom.openSidebarBottomBtn.addEventListener('click', openMobileSidebar);
                this.dom.overlay?.addEventListener('click', closeMobileSidebar);
                if (this.dom.mobileNewChatBtn) {
                    this.dom.mobileNewChatBtn.addEventListener('click', () => {
                        this.newChat();
                        closeMobileSidebar();
                    });
                }
                const mobileBottomBar = this.dom.sidebar?.querySelector('.mobile-bottom-bar');
                if (mobileBottomBar && window.matchMedia('(max-width: 640px)').matches) {
                    let dragging = false;
                    let pointerId = null;
                    let startY = 0;
                    let startOffset = 0;
                    let currentOffset = 0;
                    let hiddenOffset = 0;
                    const applyOffset = offset => {
                        this.dom.sidebar.style.transform = `translateY(${offset}px)`;
                        if (hiddenOffset > 0) {
                            const ratio = Math.max(0, Math.min(1, 1 - (offset / hiddenOffset)));
                            this.dom.overlay.style.opacity = `${ratio}`;
                        }
                    };
                    const onPointerMove = e => {
                        if (!dragging || e.pointerId !== pointerId) return;
                        const delta = e.clientY - startY;
                        currentOffset = Math.max(0, Math.min(hiddenOffset, startOffset + delta));
                        applyOffset(currentOffset);
                    };
                    const onPointerEnd = e => {
                        if (!dragging || e.pointerId !== pointerId) return;
                        dragging = false;
                        pointerId = null;
                        this.dom.sidebar.style.removeProperty('transition');
                        this.dom.overlay.style.removeProperty('opacity');
                        const moved = Math.abs(e.clientY - startY);
                        if (moved < 8) {
                            openMobileSidebar();
                        } else if (currentOffset > hiddenOffset * DRAG_CLOSE_THRESHOLD) {
                            closeMobileSidebar();
                        } else {
                            openMobileSidebar();
                        }
                    };
                    this.dom.sidebar.addEventListener('pointerdown', e => {
                        if (e.pointerType === 'mouse' && e.button !== 0) return;
                        // When active, only allow drag-to-close via the bottom handle bar
                        if (this.dom.sidebar.classList.contains('active') && !mobileBottomBar.contains(e.target)) return;
                        hiddenOffset = Math.max(this.dom.sidebar.getBoundingClientRect().height - SIDEBAR_VISIBLE_PEEK_HEIGHT, 0);
                        startOffset = this.dom.sidebar.classList.contains('active') ? 0 : hiddenOffset;
                        currentOffset = startOffset;
                        startY = e.clientY;
                        pointerId = e.pointerId;
                        dragging = true;
                        this.dom.sidebar.classList.add('active');
                        this.dom.overlay.classList.add('active');
                        this.dom.sidebar.style.transition = 'none';
                        applyOffset(startOffset);
                        document.body.style.overflow = 'hidden';
                        if (this.dom.sidebar.setPointerCapture) this.dom.sidebar.setPointerCapture(pointerId);
                        e.preventDefault();
                    });
                    window.addEventListener('pointermove', onPointerMove);
                    window.addEventListener('pointerup', onPointerEnd);
                    window.addEventListener('pointercancel', onPointerEnd);
                }

                // Desktop sidebar collapse/expand
                this.dom.closeSidebarBtn?.addEventListener('click', () => {
                    if (window.matchMedia('(max-width: 768px)').matches) {
                        closeMobileSidebar();
                        return;
                    }
                    this.dom.sidebar.classList.add('collapsed');
                });
                this.dom.openSidebarDesktopBtn?.addEventListener('click', () => {
                    this.dom.sidebar.classList.remove('collapsed');
                });

                // Desktop: drag from left edge to open collapsed sidebar
                {
                    const DRAG_THRESHOLD = 40; // px right to trigger open
                    let edgeDragActive = false;
                    let edgeDragStartX = 0;
                    const dragStrip = document.querySelector('.sidebar-drag-strip');
                    const startEdgeDrag = (clientX) => {
                        if (window.matchMedia('(max-width: 768px)').matches) return;
                        if (!this.dom.sidebar.classList.contains('collapsed')) return;
                        edgeDragActive = true;
                        edgeDragStartX = clientX;
                    };
                    const moveEdgeDrag = (clientX) => {
                        if (!edgeDragActive) return;
                        if (clientX - edgeDragStartX >= DRAG_THRESHOLD) {
                            this.dom.sidebar.classList.remove('collapsed');
                            edgeDragActive = false;
                        }
                    };
                    const endEdgeDrag = () => { edgeDragActive = false; };
                    if (dragStrip) {
                        dragStrip.addEventListener('mousedown', e => startEdgeDrag(e.clientX));
                        dragStrip.addEventListener('touchstart', e => { if (e.touches[0]) startEdgeDrag(e.touches[0].clientX); }, { passive: true });
                    }
                    document.addEventListener('mousemove', e => moveEdgeDrag(e.clientX));
                    document.addEventListener('touchmove', e => { if (e.touches[0]) moveEdgeDrag(e.touches[0].clientX); }, { passive: true });
                    document.addEventListener('mouseup', endEdgeDrag);
                    document.addEventListener('touchend', endEdgeDrag);
                }

                this.dom.themeToggle?.addEventListener('click', () => this.toggleTheme());
                document.querySelectorAll('.welcome-suggestion-card').forEach(card => {
                    card.addEventListener('click', () => {
                        this.fillInput(card.getAttribute('data-prompt') || '');
                        const mode = card.getAttribute('data-mode');
                        if (mode) {
                            const MODES = ['mode-analyst','mode-thinker','mode-planner','mode-strategist','mode-builder','mode-writer'];
                            document.body.classList.remove(...MODES);
                            document.body.classList.add(mode);
                        }
                    });
                });
                const suggestions = document.getElementById('welcomeSuggestions');
                if (suggestions) {
                    suggestions.addEventListener('keydown', e => {
                        if (e.key === 'ArrowRight') suggestions.scrollBy({ left: 180, behavior: 'smooth' });
                        if (e.key === 'ArrowLeft') suggestions.scrollBy({ left: -180, behavior: 'smooth' });
                    });
                }
                if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
                    const shortcutHint = document.getElementById('footerShortcuts');
                    if (shortcutHint) shortcutHint.style.display = 'none';
                }

                // Slash command menu click handlers
                document.querySelectorAll('.slash-cmd-item').forEach(item => {
                    item.addEventListener('click', () => {
                        const cmd = item.getAttribute('data-cmd');
                        if (cmd) {
                            this.dom.input.value = cmd;
                            this.dom.input.dispatchEvent(new Event('input'));
                            this.dom.input.focus();
                            const menu = document.getElementById('slashCmdMenu');
                            if (menu) menu.classList.add('hidden');
                        }
                    });
                });

            }

            handleInput() {
                this.dom.input.style.height = 'auto';
                this.dom.input.style.height = Math.min(this.dom.input.scrollHeight, 200) + 'px';
                this.updateButtonState();
                this.updateCharCount();
                this.updateSlashMenu();
            }

            updateSlashMenu() {
                const menu = document.getElementById('slashCmdMenu');
                if (!menu) return;
                const val = this.dom.input.value;
                // Show menu while typing a potential slash command (longest is "/search" = 7 chars)
                if (val.startsWith('/') && !val.includes(' ') && val.length < 10) {
                    const q = val.toLowerCase();
                    const items = menu.querySelectorAll('.slash-cmd-item');
                    let anyVisible = false;
                    items.forEach(item => {
                        const cmd = item.getAttribute('data-cmd') || '';
                        const match = cmd.startsWith(q);
                        item.style.display = match ? '' : 'none';
                        if (match) anyVisible = true;
                    });
                    menu.classList.toggle('hidden', !anyVisible);
                } else {
                    menu.classList.add('hidden');
                }
            }

            updateCharCount() {
                const charCount = document.getElementById('charCount');
                if (!charCount) return;
                const len = this.dom.input.value.length;
                charCount.textContent = len >= CHAR_COUNT_DISPLAY_THRESHOLD ? `${len.toLocaleString()} char${len !== 1 ? 's' : ''}` : '';
            }

            generateConversationTitle(text) {
                const words = (text || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
                    .split(' ')
                    .filter(Boolean);

                if (!words.length) return 'New Conversation';
                if (words.length >= 4) return words.slice(0, 6).join(' ');
                if (words.length === 3) return `Question about ${words.join(' ')}`;
                if (words.length === 2) return `Question about ${words[0]} ${words[1]}`;
                return `Discussion about ${words[0]} topic`;
            }

            updateButtonState() {
                if (!this.dom.sendBtn || !this.dom.input) return;
                
                const isSignedIn = !!window.__clerk?.isSignedIn;
                const acceptedAt = localStorage.getItem(LS_PRIVACY_POLICY_ACCEPTED_AT);
                const consentRequired = isSignedIn && !acceptedAt;

                if (this.state.isProcessing) {
                    this.dom.sendBtn.disabled = false;
                    return;
                }

                const hasContent = this.dom.input.value.trim().length > 0 || this.state.files.length > 0;
                this.dom.sendBtn.disabled = !hasContent || consentRequired;

                if (consentRequired) {
                    this.dom.input.placeholder = "Please agree to the privacy policy to continue...";
                } else {
                    this.dom.input.placeholder = "Ask anything — I love a challenge…";
                }
            }

            fillInput(text) {
                this.dom.input.value = text;
                this.dom.input.dispatchEvent(new Event('input'));
                this.dom.input.focus();
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
                    if (isImage) {
                        objectUrl = URL.createObjectURL(file);
                        const img = document.createElement('img');
                        img.src = objectUrl;
                        img.alt = 'preview';
                        chip.appendChild(img);
                    } else {
                        const icon = document.createElement('span');
                        icon.textContent = '📄';
                        chip.appendChild(icon);
                    }
                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = file.name;
                    chip.appendChild(nameSpan);
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
                if (this.dom.fileInput) this.dom.fileInput.value = '';
            }

            async runOCR(file) {
                try {
                    // Attempt PaddleOCR first
                    return await this.runPaddleOCR(file);
                } catch (e) {
                    console.warn('PaddleOCR failed, falling back to Tesseract:', e);
                    return await this.runTesseractOCR(file);
                }
            }

            async runPaddleOCR(file) {
                if (typeof window.Paddle === 'undefined') {
                    // Load dependencies for PaddleOCR
                    const scripts = [
                        'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js',
                        'https://docs.opencv.org/4.8.0/opencv.js'
                    ];
                    
                    for (const src of scripts) {
                        if (src.includes('ort') && typeof window.ort !== 'undefined') continue;
                        if (src.includes('opencv') && typeof window.cv !== 'undefined') continue;
                        await new Promise((res, rej) => {
                            const s = document.createElement('script');
                            s.src = src;
                            s.async = true;
                            s.onload = res;
                            s.onerror = rej;
                            document.head.appendChild(s);
                        });
                    }

                    // Load PaddleOCR library
                    await new Promise((res, rej) => {
                        const s = document.createElement('script');
                        s.type = 'module';
                        s.text = `
                            import * as Paddle from "https://cdn.jsdelivr.net/npm/esearch-ocr@5.1.5/dist/esearch-ocr.js";
                            window.Paddle = Paddle;
                            window.dispatchEvent(new CustomEvent('paddle-loaded'));
                        `;
                        s.onerror = rej;
                        document.head.appendChild(s);
                        window.addEventListener('paddle-loaded', res, { once: true });
                    });
                }

                // Initialize PaddleOCR if not already done
                if (!this.paddleInitialized) {
                    const assetsPath = "https://cdn.jsdelivr.net/npm/paddleocr-browser/dist/";
                    const res = await fetch(assetsPath + "ppocr_keys_v1.txt");
                    const dic = await res.text();
                    
                    await window.Paddle.init({
                        detPath: assetsPath + "ppocr_det.onnx",
                        recPath: assetsPath + "ppocr_rec.onnx",
                        dic: dic,
                        ort: window.ort,
                        node: false,
                        cv: window.cv
                    });
                    this.paddleInitialized = true;
                }

                // Convert file to dataURL for PaddleOCR
                const dataURL = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(file);
                });

                const result = await window.Paddle.ocr(dataURL);
                const text = result.map(r => r.text).join('\n');
                
                if (!text || text.trim() === '') throw new Error('No text found by PaddleOCR');
                return text;
            }

            async runTesseractOCR(file) {
                if (typeof Tesseract === 'undefined') {
                    await new Promise((res, rej) => {
                        const s = document.createElement('script');
                        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@v5/dist/tesseract.min.js';
                        s.onload = res;
                        s.onerror = rej;
                        document.head.appendChild(s);
                    });
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

                // Hide slash command menu
                const slashMenu = document.getElementById('slashCmdMenu');
                if (slashMenu) slashMenu.classList.add('hidden');

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
                    const title = this.generateConversationTitle(text);
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

                // All users are Max tier — always honour the RAG toggle and custom system prompt
                const ragEnabled = ragToggle?.checked ?? true;
                const customSystemPrompt = (speTextarea && speTextarea.value.trim())
                    ? speTextarea.value.trim()
                    : undefined;

                let typingTimer = null;
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
                    // Signed-in users hit the same-origin proxy (/api/chat/proxy) — cookies
                    // are sent automatically with 'same-origin'. Anonymous users call the
                    // cross-origin Render backend directly and need 'include' so the
                    // backend's esamz_sid HTTP-only session cookie is sent/received.
                    const fetchOpts = {
                        method:  'POST',
                        headers: reqHeaders,
                        body:    JSON.stringify(reqBody),
                        signal:  this.state.abortController.signal,
                        credentials: window.__clerk?.isSignedIn ? 'same-origin' : 'include',
                    };
                    for (let attempt = 0; attempt <= 2; attempt++) {
                        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
                        if (DEBUG_CHAT_STREAM_LOGS) {
                            console.debug('[ChatStream] Sending request', {
                                attempt: attempt + 1,
                                chatUrl,
                                sessionId: this.state.chatId,
                                messageLength: finalPayload.length,
                            });
                        }
                        response = await fetch(chatUrl, fetchOpts);
                        if (DEBUG_CHAT_STREAM_LOGS) {
                            console.debug('[ChatStream] Response received', {
                                status: response.status,
                                statusText: response.statusText,
                                contentType: response.headers.get('content-type'),
                            });
                        }
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
                    let buffer       = '';
                    let fullText     = '';
                    let displayedText = '';
                    let incomingHistory = null;
                    let streamDone = false;

                    const renderDisplayed = (showCursor = true) => {
                        if (window.marked && window.DOMPurify) {
                            try {
                                contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(displayedText));
                                if (showCursor && displayedText.length < fullText.length) {
                                    const cursor = document.createElement('span');
                                    cursor.className = 'streaming-cursor';
                                    contentDiv.appendChild(cursor);
                                }
                                if (window.Prism) Prism.highlightAllUnder(contentDiv);
                                this.injectCodeButtons(contentDiv);
                            } catch (_) { contentDiv.textContent = displayedText; }
                        } else { contentDiv.textContent = displayedText; }
                        this.scrollToBottom();
                    };

                    const startTypewriter = () => {
                        if (typingTimer) return;
                        const step = () => {
                            if (displayedText.length < fullText.length) {
                                const remaining = fullText.length - displayedText.length;
                                const add = getTypewriterChunkSize(remaining);
                                displayedText = fullText.slice(0, displayedText.length + add);
                                renderDisplayed(true);
                                typingTimer = setTimeout(step, TYPEWRITER_INTERVAL_MS);
                                return;
                            }
                            typingTimer = null;
                            if (streamDone) renderDisplayed(false);
                        };
                        step();
                    };

                    const appendTextChunk = text => {
                        if (!text) return;
                        fullText += text.replace(/\\n/g, '\n');
                        startTypewriter();
                    };

                    const tryProcessJsonLine = raw => {
                        if (!raw || (raw[0] !== '{' && raw[0] !== '[')) return false;
                        try {
                            const parsed = JSON.parse(raw);
                            const maybeText =
                                typeof parsed === 'string' ? parsed :
                                typeof parsed?.content === 'string' ? parsed.content :
                                typeof parsed?.text === 'string' ? parsed.text :
                                typeof parsed?.response === 'string' ? parsed.response :
                                typeof parsed?.answer === 'string' ? parsed.answer :
                                typeof parsed?.message === 'string' ? parsed.message :
                                typeof parsed?.data?.text === 'string' ? parsed.data.text :
                                '';
                            if (maybeText) {
                                appendTextChunk(maybeText);
                                return true;
                            }
                        } catch (e) {
                            if (DEBUG_CHAT_STREAM_LOGS) console.warn('[ChatStream] Failed to parse JSON line:', e, raw);
                        }
                        return false;
                    };

                    const processLine = line => {
                        if (!line.trim()) return;
                        if (DEBUG_CHAT_STREAM_LOGS) console.debug('[ChatStream] Raw line from backend:', line);

                        let normalizedLine = line.trim();
                        if (normalizedLine.startsWith('data:')) normalizedLine = normalizedLine.slice(5).trimStart();
                        if (!normalizedLine) return;
                        if (normalizedLine === '[DONE]') {
                            streamDone = true;
                            return;
                        }
                        if (normalizedLine.startsWith('event:') || normalizedLine.startsWith('id:') || normalizedLine.startsWith('retry:')) {
                            return;
                        }

                        const sep  = normalizedLine.indexOf('|');

                        if (sep === -1) {
                            if (tryProcessJsonLine(normalizedLine)) return;
                            appendTextChunk(normalizedLine);
                            return;
                        }

                        const type = normalizedLine.substring(0, sep);
                        const data = normalizedLine.substring(sep + 1);
                        if (type === 'STATUS') {
                            if (DEBUG_CHAT_STREAM_LOGS) console.debug('[ChatStream] STATUS:', data);
                            const loader = contentDiv.querySelector('.thinking-loader');
                            if (!loader) return;
                            if (data === 'SEARCHING') loader.textContent = 'Thinking…';
                            if (data === 'TYPING')    loader.textContent = 'Writing…';
                        } else if (type === 'CHUNK') {
                            if (DEBUG_CHAT_STREAM_LOGS) console.debug('[ChatStream] CHUNK length:', data.length);
                            fullText += data.replace(/\\n/g, '\n');
                            startTypewriter();
                        } else if (type === 'HISTORY_UPDATE') {
                            if (DEBUG_CHAT_STREAM_LOGS) console.debug('[ChatStream] HISTORY_UPDATE received');
                            try { incomingHistory = JSON.parse(data); } catch (_) {}
                        } else if (type === 'DONE') {
                            // Stream complete signal from backend; data = session_id
                            if (DEBUG_CHAT_STREAM_LOGS) console.debug('[ChatStream] DONE received:', data);
                            streamDone = true;
                        } else if (type === 'ERROR') {
                            if (DEBUG_CHAT_STREAM_LOGS) console.error('[ChatStream] ERROR received:', data);
                            const errMsg = /504|gateway timeout|timed out/i.test(data)
                                ? 'AI service timed out. Please try again in a moment.'
                                : /sarvam/i.test(data)
                                    ? 'Something went wrong with the AI service. Please try again.'
                                    : data;
                            throw new Error(errMsg);
                        } else {
                            if (DEBUG_CHAT_STREAM_LOGS) {
                                console.warn('[ChatStream] Unknown event type from backend:', {
                                    type,
                                    dataLength: data.length,
                                    dataPreview: data.slice(0, 120),
                                });
                            }
                        }
                    };

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunkText = decoder.decode(value, { stream: true });
                        if (DEBUG_CHAT_STREAM_LOGS) console.debug('[ChatStream] Raw chunk:', chunkText);
                        buffer += chunkText;
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const l of lines) processLine(l);
                    }
                    if (DEBUG_CHAT_STREAM_LOGS) console.debug('[ChatStream] Stream ended by backend');
                    if (buffer.trim()) for (const l of buffer.split('\n')) processLine(l);

                    streamDone = true;
                    if (!fullText.trim()) {
                        throw new Error('AI returned no content (possible timeout or backend failure). Please try again.');
                    }
                    if (!typingTimer) renderDisplayed(false);

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
                    if (typingTimer) {
                        clearTimeout(typingTimer);
                        typingTimer = null;
                    }
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
                    this.dom.sendBtn?.classList.add('stop-mode');
                    if (this.dom.sendBtn) this.dom.sendBtn.disabled = false;
                    this.dom.sendIcon?.classList.add('hidden');
                    this.dom.stopIcon?.classList.remove('hidden');
                } else {
                    this.dom.sendBtn?.classList.remove('stop-mode');
                    this.dom.sendIcon?.classList.remove('hidden');
                    this.dom.stopIcon?.classList.add('hidden');
                    this.state.abortController = null;
                    this.updateButtonState();
                }
            }

            initDraft() {
                const KEY = 'esamz_draft_v9';
                const saved = localStorage.getItem(KEY);
                if (saved && saved.trim() && this.dom.input) { this.dom.input.value = saved; this.handleInput(); }
                let timer;
                const indicator = document.getElementById('draftIndicator');
                this.dom.input?.addEventListener('input', () => {
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
                this.dom.input?.addEventListener('paste', e => {
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
                        }).catch(() => {});
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
                avatar.setAttribute('aria-label', role === 'user' ? 'User avatar' : 'AI assistant avatar');
                const content = document.createElement('div');
                content.className = 'message-content';
                const bubble  = document.createElement('div');
                bubble.className  = 'bubble';
                if (isLoading) {
                    bubble.innerHTML = `<div class="thinking-loader">Thinking…</div>`;
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
                    copyBtn.onclick = () => { const t = code ? code.textContent : pre.textContent; navigator.clipboard.writeText(t).then(() => { copyBtn.innerHTML = CHECK_ICON; setTimeout(() => { copyBtn.innerHTML = COPY_ICON; }, 2000); }).catch(() => {}); };
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
                    if (newMessages.length > 0) {
                        const fu = newMessages.find(m => m.role === 'user');
                        if (fu) {
                            const nextTitle = this.generateConversationTitle(fu.content);
                            if (nextTitle && nextTitle !== all[ci].title) {
                                all[ci].title = nextTitle;
                                this.renderHistoryItem(chatId, all[ci].title);
                            }
                        }
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
                    if (nb) { nb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span>${title}</span>`; nb.onclick = () => this.loadChat(id); }
                    return;
                }
                const row = document.createElement('div');
                row.className = 'nav-item-row';
                row.setAttribute('data-row-id', id);
                const btn = document.createElement('button');
                btn.className = 'nav-item';
                btn.setAttribute('data-id', id);
                btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span>${title}</span>`;
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
                this.setActiveHistoryItem(id);
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
                const doReset = () => {
                    localStorage.removeItem(this.LAST_CHAT_KEY);
                    this.state.chatId = null;
                    this.state.files.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); });
                    this.state.files = [];
                    this.dom.filePreview.innerHTML = '';
                    this.dom.chatList.innerHTML    = '';
                    this.dom.welcome.classList.remove('hidden');
                    this.dom.input.focus();
                    this.setActiveHistoryItem(null);
                    const speTa = document.getElementById('spe-textarea');
                    if (speTa) speTa.value = '';
                    this.updateButtonState();
                };
                const mainEl = document.querySelector('.main-content');
                if (mainEl && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    mainEl.classList.add('new-chat-exit');
                    setTimeout(() => {
                        mainEl.classList.remove('new-chat-exit');
                        doReset();
                    }, 260);
                } else {
                    doReset();
                }
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

            setActiveHistoryItem(id) {
                this.dom.historyList.querySelectorAll('.nav-item[data-id]').forEach(navItem => navItem.classList.remove('active'));
                if (!id) return;
                const activeBtn = this.dom.historyList.querySelector(`.nav-item[data-id="${id}"]`);
                if (activeBtn) activeBtn.classList.add('active');
            }

            toMarkdown(messages = []) {
                return messages
                    .map(m => `### ${m.role === 'user' ? 'User' : 'eSAMz AI'}\n${m.content ?? ''}`)
                    .join('\n\n---\n\n');
            }

            downloadFile(content, fileName, mimeType) {
                const blob = new Blob([content], { type: mimeType });
                const url  = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(url);
            }

            normalizeChatForExport(chat) {
                return {
                    id: chat.id,
                    title: chat.title || 'Untitled',
                    lastUpdated: chat.lastUpdated || null,
                    messages: (chat.messages || []).map(m => ({ role: m.role, content: m.content ?? '' })),
                };
            }

            exportChats(scope, format) {
                const allChats = this.getHistory();
                const safeDateTime = new Date().toISOString().replace(/[:.]/g, '-');

                if (scope === 'current') {
                    const chat = allChats.find(c => c.id === this.state.chatId);
                    if (!chat || !chat.messages?.length) {
                        Utils.showToast('No current chat to export', 'error');
                        return;
                    }
                    const normalized = this.normalizeChatForExport(chat);
                    if (format === 'json') {
                        const payload = JSON.stringify({
                            scope: 'current',
                            exportedAt: new Date().toISOString(),
                            chat: normalized,
                        }, null, 2);
                        this.downloadFile(payload, `esamz-current-chat-${safeDateTime}.json`, 'application/json;charset=utf-8');
                    } else {
                        const content = `# ${normalized.title}\n\n${this.toMarkdown(normalized.messages)}\n`;
                        this.downloadFile(content, `esamz-current-chat-${safeDateTime}.md`, 'text/markdown;charset=utf-8');
                    }
                    Utils.showToast('Current chat exported', 'success');
                    return;
                }

                if (!allChats.length) {
                    Utils.showToast('No chats found to export', 'error');
                    return;
                }
                const normalizedAll = allChats.map(chat => this.normalizeChatForExport(chat));
                if (format === 'json') {
                    const payload = JSON.stringify({
                        scope: 'all',
                        exportedAt: new Date().toISOString(),
                        chats: normalizedAll,
                    }, null, 2);
                    this.downloadFile(payload, `esamz-all-chats-${safeDateTime}.json`, 'application/json;charset=utf-8');
                } else {
                    const content = normalizedAll
                        .map(chat => `# ${chat.title}\n\n${this.toMarkdown(chat.messages)}`)
                        .join('\n\n\n');
                    this.downloadFile(content, `esamz-all-chats-${safeDateTime}.md`, 'text/markdown;charset=utf-8');
                }
                Utils.showToast('All chats exported', 'success');
            }

            initTheme() {
                const saved       = localStorage.getItem('esamz_theme');
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                const theme       = saved || (prefersDark ? 'dark' : 'light');
                document.documentElement.setAttribute('data-theme', theme);
                document.body.classList.remove('theme-light', 'theme-dark');
                document.body.classList.add(`theme-${theme}`);
            }

            toggleTheme() {
                const isDark = document.body.classList.contains('theme-dark');
                const nextTheme = isDark ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', nextTheme);
                document.body.classList.remove('theme-dark', 'theme-light');
                document.body.classList.add(`theme-${nextTheme}`);
                localStorage.setItem('esamz_theme', nextTheme);
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
                    document.getElementById('headerActionsMenu')?.classList.remove('open');
                    if (modal && !modal.classList.contains('hidden'))                           { modal.classList.add('hidden'); e.preventDefault(); return; }
                    const cd = document.getElementById('confirmDialog');
                    if (cd && cd.open) { cd.close(); e.preventDefault(); return; }
                }
                if (ctrl && e.key === 'k') { e.preventDefault(); document.getElementById('userInput')?.focus(); }
                if (ctrl && e.key === 'n') { e.preventDefault(); window.app?.newChat(); }
                if (ctrl && e.key === 'e') { e.preventDefault(); window.app?.exportChats('current', 'md'); }
                if (ctrl && e.shiftKey && e.key === 'D') { e.preventDefault(); window.app?.toggleTheme(); }
                if (ctrl && e.key === 'b') {
                    e.preventDefault();
                    const sb = document.getElementById('sidebar');
                    if (sb) sb.classList.toggle('collapsed');
                }
                if (ctrl && e.key === '/') { e.preventDefault(); if (modal) modal.classList.toggle('hidden'); }
            });
        })();

        // ====================================================================
        //  SCROLL TO TOP
        // ====================================================================
        (function initScrollTop() {
            const btn       = document.getElementById('scrollTopBtn');
            const container = document.getElementById('chatContainer');
            const progress = document.getElementById('chatScrollProgressBar');
            const iconPath = btn?.querySelector('polyline');
            const MIN_SCROLL_HEIGHT_FOR_BUTTON = 320;
            const SCROLL_BOTTOM_THRESHOLD = 220;
            if (!btn || !container) return;
            const update = () => {
                const max = container.scrollHeight - container.clientHeight;
                const ratio = max > 0 ? (container.scrollTop / max) * 100 : 0;
                const show = max > MIN_SCROLL_HEIGHT_FOR_BUTTON;
                const goDown = max - container.scrollTop > SCROLL_BOTTOM_THRESHOLD;
                btn.classList.toggle('visible', show);
                btn.dataset.direction = goDown ? 'down' : 'up';
                btn.title = goDown ? 'Scroll to latest' : 'Scroll to top';
                btn.setAttribute('aria-label', goDown ? 'Scroll to latest' : 'Scroll to top');
                if (iconPath) iconPath.setAttribute('points', goDown ? '6 9 12 15 18 9' : '18 15 12 9 6 15');
                if (progress) {
                    progress.style.width = `${ratio}%`;
                    progress.parentElement?.classList.toggle('visible', max > 300);
                }
            };
            container.addEventListener('scroll', update);
            window.addEventListener('resize', update);
            update();
            btn.addEventListener('click', () => {
                const direction = btn.dataset.direction || 'up';
                container.scrollTo({ top: direction === 'down' ? container.scrollHeight : 0, behavior: 'smooth' });
            });
        })();

        // ====================================================================
        //  POLICY DISCLAIMER INTEGRITY GUARD
        // ====================================================================
        (function initPolicyFooterGuard() {
            const policyEl = document.getElementById('policyLinksText');
            if (!policyEl) return;

            let repairing = false;
            let EXPECTED_TEXT = '';
            const normalized = text => (text || '').replace(/\s+/g, ' ').trim();
            
            // Updated canonical HTML for the footer
            const CANONICAL_HTML = `
                You are interacting with an AI system. Outputs may be incorrect, incomplete, or biased — always verify critical information independently. By using this service, you agree to our 
                <a href="${PRIVACY_POLICY_URL}" class="underline" target="_blank" rel="noopener">Privacy Policy</a> and 
                <a href="${TERMS_OF_SERVICE_URL}" class="underline" target="_blank" rel="noopener">Terms of Service</a>. This service is not intended for individuals under 18 years of age.
            `;
            
            const CANONICAL_LINKS = [
                { href: PRIVACY_POLICY_URL, label: 'Privacy Policy' },
                { href: TERMS_OF_SERVICE_URL, label: 'Terms of Service' }
            ];

            const rebuild = () => {
                if (repairing) return;
                repairing = true;
                try {
                    policyEl.innerHTML = CANONICAL_HTML;
                    policyEl.className = "text-xs text-gray-500 text-center";
                    policyEl.style.display = "block";
                    policyEl.style.width = "100%";
                } finally {
                    repairing = false;
                }
            };

            const hasExpectedStructure = () => {
                const text = normalized(policyEl.textContent);
                // Check if key phrases are present instead of exact match to be more resilient
                if (!text.includes("interacting with an AI system") || !text.includes("Terms of Service")) return false;
                const links = Array.from(policyEl.querySelectorAll('a'));
                if (links.length !== CANONICAL_LINKS.length) return false;
                return links.every((link, index) => (
                    link.href.includes(CANONICAL_LINKS[index].href) &&
                    normalized(link.textContent) === CANONICAL_LINKS[index].label
                ));
            };

            rebuild();
            EXPECTED_TEXT = normalized(policyEl.textContent);

            const observer = new MutationObserver(() => {
                if (repairing) return;
                if (!hasExpectedStructure()) rebuild();
            });

            observer.observe(policyEl, {
                childList: true,
                subtree: true, characterData: true, attributes: true,
                attributeFilter: ['href'],
            });
        })();

        // ====================================================================
        //  BOOT
        // ====================================================================
        // Clean up stale PeerJS localStorage keys from previous versions
        ['esamz_peer_code', 'esamz_known_peers', 'esamz_blacklist'].forEach(k => localStorage.removeItem(k));

        function waitForDOM() {
  const requiredIds = [
    'userInput',
    'btnSend',
    'chatList',
    'chatContainer',
    'sidebar'
  ];

  const missing = requiredIds.filter(id => !document.getElementById(id));

  if (missing.length > 0) {
    requestAnimationFrame(waitForDOM);
    return;
  }

  setTimeout(() => {
    window.app = new App();
  }, 80);
}

waitForDOM();


    })()
  }, [])

  // Cookie consent banner logic (GDPR / DPDP Act 2023 — per Privacy Policy §4)
  useEffect(() => {
    const banner = document.getElementById('cookieConsentBanner');
    if (!banner) return;
    const consent = localStorage.getItem('esamz_cookie_consent');
    if (consent === 'accepted' || consent === 'declined') {
      banner.style.display = 'none';
    } else {
      banner.style.display = 'flex';
    }
    const acceptBtn = document.getElementById('cookieConsentAccept');
    const declineBtn = document.getElementById('cookieConsentDecline');
    if (acceptBtn) {
      acceptBtn.onclick = () => {
        localStorage.setItem('esamz_cookie_consent', 'accepted');
        banner.style.display = 'none';
        // Grant consent for Google Analytics
        if (typeof gtag === 'function') {
          gtag('consent', 'update', { 'analytics_storage': 'granted' });
        }
      };
    }
    if (declineBtn) {
      declineBtn.onclick = () => {
        localStorage.setItem('esamz_cookie_consent', 'declined');
        banner.style.display = 'none';
      };
    }
  }, []);

  return (
    <>
    

    <div className="app-container">
        <div className="overlay" id="overlay"></div>
        
        <aside className="sidebar" id="sidebar">
            <div className="mobile-bottom-bar">
                <div className="mobile-bottom-handle" aria-hidden="true"></div>
                <div className="mobile-bottom-actions">
                    <button className="mobile-bottom-cta mobile-bottom-cta-new" id="mobileNewChatBtn">
                        ✨ New Chat
                    </button>
                </div>
            </div>
            <div className="sidebar-header">
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"16px"}}>
                    <div className="sidebar-brand-heading">eSAMz <span className="brand-z">AI</span></div>
                    <button className="btn-sidebar-close" id="btnCloseSidebar" title="Close sidebar" aria-label="Close sidebar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6"/></svg>
                    </button>
                </div>
                <button className="btn-new-chat" id="btnNewChat">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
                    New Chat
                </button>
            </div>
            <div className="sidebar-nav">
                <div className="nav-section">
                    <div className="nav-label">Tools</div>
                    <a href="https://me.esamz.site" className="nav-item" target="_blank" rel="noopener">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                        <span>MindEase</span>
                    </a>
                    <a href="https://hisaab.esamz.site" className="nav-item" target="_blank" rel="noopener">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                        <span>Hisaab</span>
                    </a>
                </div>
                <div className="nav-section" style={{flex:1}}>
                    <div className="nav-label">Chats</div>
                    <div id="historyList"></div>
                </div>
            </div>
            <div className="sidebar-footer">
            </div>
        </aside>

        
        <main className="main-content">
            {/* Drag strip – left-edge drag to reopen collapsed sidebar on desktop */}
            <div className="sidebar-drag-strip" aria-hidden="true"></div>
            <header className="header">
                <div style={{display:"flex",alignItems:"center",gap:"14px"}}>
                    <button className="icon-btn btn-open-sidebar-desktop" id="btnOpenSidebarDesktop" title="Open sidebar" aria-label="Open sidebar">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    </button>
                    <button className="icon-btn mobile-toggle" id="openSidebar" title="Open menu" aria-label="Open menu">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    </button>
                    <div className="header-context">
                        <span className="header-context-dot"></span>
                        <span>Sarvam 105B · Web Search On.</span>
                    </div>
                </div>
                <div className="header-right">
                    <button id="btnRevokeConsent" className="btn-clear" style={{display:"none",marginRight:"8px",borderColor:"var(--vermillion)",color:"var(--vermillion)"}}>Delete My Data</button>
                    <div id="clerkUserButton" style={{display:"flex",alignItems:"center"}}>{hasClerk && UserButton && <UserButton />}</div>
                    <button className="theme-toggle" id="btnThemeToggle" title="Toggle theme" aria-label="Toggle theme">
                        <svg className="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                        <svg className="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                    </button>
                    <button className="btn-clear desktop-only-action" id="btnClearChat">Clear Chat</button>
                    <div className="header-actions-wrap">
                        <button className="icon-btn header-actions-toggle" id="headerActionsToggle" aria-label="More actions" title="More actions">
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <circle cx="12" cy="5" r="1.8"></circle>
                                <circle cx="12" cy="12" r="1.8"></circle>
                                <circle cx="12" cy="19" r="1.8"></circle>
                            </svg>
                        </button>
                        <div className="header-actions-menu" id="headerActionsMenu">
                            <button id="menuNewChatBtn" className="header-actions-item">New chat</button>
                            <div className="header-actions-divider"></div>
                            <button id="menuExportCurrentJsonBtn" className="header-actions-item">Export this chat (.json)</button>
                            <button id="menuExportCurrentMdBtn" className="header-actions-item">Export this chat (.md)</button>
                            <button id="menuExportAllJsonBtn" className="header-actions-item">Export all chats (.json)</button>
                            <button id="menuExportAllMdBtn" className="header-actions-item">Export all chats (.md)</button>
                            <div className="header-actions-divider"></div>
                            <button id="menuClearChatBtn" className="header-actions-item danger">Clear chat</button>
                        </div>
                    </div>
                </div>
            </header>

            <div className="chat-container" id="chatContainer">
                <div className="chat-scroll-progress" id="chatScrollProgress"><span id="chatScrollProgressBar"></span></div>
                <div className="chat-wrapper">
                    <div className="welcome" id="welcomeScreen">
                        <div className="welcome-dateline" aria-label="eSAMz AI branding">✦ eSAMz AI</div>
                        <h1 className="welcome-headline" id="welcomeHeadline">Empowering Intelligence.<br />Think <em>deeper</em>.</h1>
                        <p className="welcome-deck">Advanced reasoning with strategic clarity. Designed for complex problems that demand more than just a quick response.</p>
                        <div className="welcome-suggestions-wrap">
                            <div className="welcome-suggestions" id="welcomeSuggestions" tabIndex={0} aria-label="Suggested prompts">
                                <button className="welcome-suggestion-card" data-prompt="Build me a practical Python data analysis workflow for messy CSV data." data-mode="mode-analyst">
                                    <span className="welcome-suggestion-icon">🐍</span>
                                    <span className="welcome-suggestion-title">Python Data Analysis</span>
                                    <span className="welcome-suggestion-copy">Practical workflow for real data</span>
                                </button>
                                <button className="welcome-suggestion-card" data-prompt="Give me a deep explanation of transformers with simple analogies and examples." data-mode="mode-thinker">
                                    <span className="welcome-suggestion-icon">🧠</span>
                                    <span className="welcome-suggestion-title">Deep Explanations</span>
                                    <span className="welcome-suggestion-copy">Complex topics made crystal clear</span>
                                </button>
                                <button className="welcome-suggestion-card" data-prompt="Help me design a 30-day learning plan for mastering system design interviews." data-mode="mode-planner">
                                    <span className="welcome-suggestion-icon">🗓️</span>
                                    <span className="welcome-suggestion-title">30-Day Learning Plan</span>
                                    <span className="welcome-suggestion-copy">Step-by-step with milestones</span>
                                </button>
                                <button className="welcome-suggestion-card" data-prompt="Review this startup idea and give risks, opportunities, and a go-to-market strategy." data-mode="mode-strategist">
                                    <span className="welcome-suggestion-icon">🚀</span>
                                    <span className="welcome-suggestion-title">Startup Strategy Review</span>
                                    <span className="welcome-suggestion-copy">Risks, opportunities, execution</span>
                                </button>
                                <button className="welcome-suggestion-card" data-prompt="Write a clean, production-ready REST API in Node.js with authentication and error handling." data-mode="mode-builder">
                                    <span className="welcome-suggestion-icon">⚡</span>
                                    <span className="welcome-suggestion-title">REST API Blueprint</span>
                                    <span className="welcome-suggestion-copy">Auth, errors, production-ready</span>
                                </button>
                                <button className="welcome-suggestion-card" data-prompt="Help me write a compelling cold email sequence to land my first 10 clients as a freelancer." data-mode="mode-writer">
                                    <span className="welcome-suggestion-icon">✉️</span>
                                    <span className="welcome-suggestion-title">Cold Email Sequence</span>
                                    <span className="welcome-suggestion-copy">Land your first 10 clients</span>
                                </button>
                            </div>
                            <div className="welcome-suggestions-hint">✨ Swipe for more ideas <span className="floating-arrow">→</span></div>
                        </div>
                    </div>
                    <div id="chatList"></div>
                </div>
            </div>

            
            <div className="input-wrapper">
                <div id="preLoginBanner" className="pre-login-banner" style={{display:"none"}}>
                    By starting a chat you consent to session-only processing. <a href="https://esamz.info/privacypolicy" target="_blank" rel="noopener" className="underline">Review Policy</a>
                </div>
                <div className="input-container">
                    <div id="anonymousNotice" className="anonymous-notice" style={{display:"none"}}>
                        You are in an anonymous session. Sign in to save your chats and access advanced features.
                    </div>
                    <div className="input-box">
                        <div className="file-preview" id="filePreview"></div>
                        <span className="draft-indicator" id="draftIndicator">Draft saved</span>
                        <div className="input-row">
                            <button className="icon-btn" id="btnUpload" title="Attach file" aria-label="Attach file">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                            </button>
                            <textarea id="userInput" rows="1" placeholder="Ask anything — I love a challenge…"></textarea>
                            <button className="send-btn" id="btnSend" disabled aria-label="Send message">
                                <svg className="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                                <svg className="stop-icon hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                            </button>
                        </div>

                        {/* Slash command autocomplete menu */}
                        <div className="slash-cmd-menu hidden" id="slashCmdMenu">
                            <button className="slash-cmd-item" data-cmd="/help">
                                <span className="slash-cmd-name">/help</span>
                                <span className="slash-cmd-desc">Show available commands</span>
                            </button>
                            <button className="slash-cmd-item" data-cmd="/clear">
                                <span className="slash-cmd-name">/clear</span>
                                <span className="slash-cmd-desc">Clear session memory</span>
                            </button>
                            <button className="slash-cmd-item" data-cmd="/search">
                                <span className="slash-cmd-name">/search</span>
                                <span className="slash-cmd-desc">Search the web</span>
                            </button>
                        </div>

                        
                        <div id="rag-toggle-wrapper" role="group" aria-label="RAG settings">
                            <label id="rag-toggle-label" htmlFor="rag-toggle">
                                <input type="checkbox" id="rag-toggle" defaultChecked />
                                <span className="toggle-track"></span>
                                Web search
                            </label>
                        </div>

                        
                        <div id="system-prompt-editor" role="group" aria-label="Custom system prompt">
                            <div className="spe-header">
                                <div className="spe-label">
                                    <span>System Prompt</span>
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
                    <div className="privacy-agreement" id="privacyAgreement" role="region" aria-label="Privacy policy agreement">
                        <label className="privacy-agreement-label" htmlFor="privacyAgreementCheckbox">
                            <input type="checkbox" id="privacyAgreementCheckbox" />
                            <span className="privacy-agreement-copy">
                                <strong>Do you agree with this Privacy Policy?</strong>
                                <span>We use your account details and app activity only to provide, secure, improve, and support eSAMz AI as described in our <a href="https://esamz.info/privacypolicy" target="_blank" rel="noopener">Privacy Policy</a>. Your agreement is saved as a timestamped log when you check this box.</span>
                            </span>
                        </label>
                        <span className="privacy-agreement-status" id="privacyAgreementStatus"></span>
                    </div>
                    <div className="input-footer">
                        <span className="footer-sgi-badge" title="SGI: Strategic Guidance Intelligence" aria-label="SGI: Strategic Guidance Intelligence">SGI</span>
                        <span className="footer-robot-icon" title="AI assistant indicator" aria-label="AI assistant indicator">🤖</span>
                        <div id="policyLinksText" className="text-xs text-gray-500 text-center" style={{flex:1}}>
                            You are interacting with an AI system. Outputs may be incorrect, incomplete, or biased — always verify critical information independently. By using this service, you agree to our{' '}
                            <a href="https://esamz.info/privacypolicy" className="underline" target="_blank" rel="noopener">Privacy Policy</a> and{' '}
                            <a href="https://esamz.info/termsofservice" className="underline" target="_blank" rel="noopener">Terms of Service</a>.{' '}
                            This service is not intended for individuals under 18 years of age.
                        </div>
                        <span id="charCount" className="char-count"></span>
                        <span id="footerShortcuts">
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
    <button className="mobile-bottom-open-btn" id="openSidebarBottom" title="Open menu" aria-label="Open menu">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
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
                <div className="shortcut-row"><span>Close modal</span><div className="shortcut-keys"><kbd>Esc</kbd></div></div>
                <div className="shortcut-row"><span>Show shortcuts</span><div className="shortcut-keys"><kbd>Ctrl</kbd><kbd>/</kbd></div></div>
            </div>
        </div>
    </div>

    
    <dialog id="confirmDialog">
        <div className="dialog-header">
            <span id="confirmTitle">Confirm</span>
        </div>
        <div className="dialog-body">
            <p id="confirmMessage" style={{marginBottom:0,fontStyle:"italic",fontSize:"14px"}}></p>
            <div className="dialog-actions">
                <button className="btn-secondary" id="confirmCancel">Cancel</button>
                <button className="btn-primary" id="confirmOk">Confirm</button>
            </div>
        </div>
    </dialog>

    <div id="consentModal" className="fixed inset-0 z-[120] hidden consent-modal-overlay">
      <div className="consent-modal-card">
        {/* Top accent bar */}
        <div className="consent-modal-accent"></div>

        {/* Icon */}
        <div className="consent-modal-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>

        <h3 className="consent-modal-title">Privacy Policy</h3>
        <p className="consent-modal-eyebrow">Agreement Required</p>

        <div className="consent-modal-body">
          <p>
            We process the following categories of personal data: account identifiers (name, email), chat content, device metadata, and usage analytics.
          </p>
          <p>
            Processing purposes: to provide, secure, improve, and support eSAMz AI as described in our{' '}
            <a href="https://esamz.info/privacypolicy" target="_blank" rel="noopener" className="consent-modal-link">Privacy Policy</a>.
          </p>
          <p>
            Your rights: Under the DPDP Act 2023 and GDPR, you may access, correct, erase, port, or withdraw consent for your data at any time via Settings → Privacy or by contacting us.
          </p>
          <p>
            Grievance redressal: Contact our Data Protection Officer at{' '}
            <a href="mailto:esamzai365@gmail.com" className="consent-modal-link">esamzai365@gmail.com</a>. We will respond within 30 days.
          </p>
          <p>
            This service is not intended for individuals under 18 years of age.
          </p>
        </div>

        <label className="consent-modal-checkbox-row">
          <input
            type="checkbox"
            id="consentModalCheckbox"
            className="consent-modal-checkbox"
          />
          <span className="consent-modal-checkbox-label">I agree to the Privacy Policy</span>
        </label>

        <button
          id="consentModalContinue"
          disabled
          className="consent-modal-btn"
        >
          Agree & Continue
        </button>

        <p className="consent-modal-footer">You can delete your account and all data at any time from the header menu.</p>
      </div>
    </div>

    {/* Cookie Consent Banner (GDPR / DPDP Act 2023 — per Privacy Policy §4) */}
    <div id="cookieConsentBanner" className="cookie-consent-banner" style={{display:'none'}}>
      <div className="cookie-consent-banner-text">
        We use cookies for analytics to improve your experience. No advertising cookies are used. Your conversations are never used for ad targeting. See our{' '}
        <a href="https://esamz.info/privacypolicy" target="_blank" rel="noopener">Privacy Policy</a> for details.
      </div>
      <div className="cookie-consent-banner-actions">
        <button id="cookieConsentDecline" className="cookie-consent-btn cookie-consent-btn-decline">Decline</button>
        <button id="cookieConsentAccept" className="cookie-consent-btn cookie-consent-btn-accept">Accept</button>
      </div>
    </div>

    </>
  )
}

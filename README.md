# esamz.a — the eSAMz AI flagship codebase

> **India's privacy-first AI assistant, live at [esamz.info](https://esamz.info) · the production code behind [esamz.me](https://esamz.me).**

This is the real flagship: **112 commits** of iteration (Dec 2025 → Jun 2026), built as a Next.js PWA with authentication, consent architecture, and a chat proxy layer.

**Live:** [esamz.info](https://esamz.info) · **Portfolio:** [esamz.me](https://esamz.me)

---

## 🔐 Privacy as architecture, not a policy page

The most distinctive engineering in this repo is **consent as a first-class backend feature**:

- `app/api/user/privacy-policy-acceptance/route.ts` — records explicit consent before any personalization runs
- `app/api/user/privacy-policy-acceptance/revoke/route.ts` — **one-call consent revocation**, symmetric with acceptance
- `app/api/user/tier/route.ts` — user tiering kept separate from identity
- Raw event data is deliberately not persisted on this path; the analytics used across eSAMz properties run on a separate, IP-hashing system ([analytics-hub](https://github.com/alakmar344/analytics-hub))

Consent isn't a checkbox here — it's an API surface with a documented revoke path. This is what "Privacy First" means in practice at eSAMz.

## 🏗 Architecture

```
Next.js (App Router) + TypeScript
├── app/api/chat/proxy/route.ts        → chat proxy (client never talks to the model directly)
├── app/api/user/*                     → consent + tier routes
├── app/components/ClerkBridge / ClerkWrapper / DynamicClerkWrapper
│                                        → authentication (Clerk) with SSR-safe hydration
├── public/sw.js + site.webmanifest     → installable PWA (offline shell, native-feel)
├── proxy.ts + vercel.json              → edge/deploy configuration
└── PwaInit.tsx                         → service-worker lifecycle management
```

**Stack:** Next.js · TypeScript · Clerk (auth) · PWA service worker · Vercel.

## 🚀 Run locally

```bash
npm install
cp .env.example .env.local   # then fill in the keys below
npm run dev
```

### Environment variables (set in Vercel Project Settings for prod)

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `MONGODB_URI`
- `CASHFREE_SECRET_KEY`
- `ESAMZ_MASTER_SECRET`

> `.env*` files are gitignored — never commit environment files. `.env.example` documents the shape without values.

## 📍 Where this fits in the eSAMz story

This repo is the current, active flagship in an evolution: `esamz` (first landing, Dec 2025) → `about-esamz` (info site) → `esamz-ai` (docs) → **`esamz.a` (the app)**. The 112 commits across six+ months are the real product history.

Related: [analytics-hub](https://github.com/alakmar344/analytics-hub) (privacy analytics) · [privacy-policy](https://github.com/alakmar344/privacy-policy) (DPDP-2023-aligned policy) · [See-market](https://github.com/alakmar344/See-market) (in-development market intelligence).

---

**Maintained by [Al-Aqmar Tinwala](https://esamz.me)** — eSAMz founder. Heart First · Privacy First.

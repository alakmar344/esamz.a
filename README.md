# esamz.a

## Cloudflare Workers deployment

This project can be deployed to Cloudflare Workers using OpenNext.

### 1) Install dependencies

```bash
npm install
```

### 2) Build for Cloudflare

```bash
npm run cf:build
```

### 3) Preview locally

```bash
npm run cf:preview
```

### 4) Deploy

```bash
npm run cf:deploy
```

### Required environment variables

Set these in your Cloudflare Worker settings/secrets:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `MONGODB_URI`
- `CASHFREE_SECRET_KEY`
- `ESAMZ_MASTER_SECRET`

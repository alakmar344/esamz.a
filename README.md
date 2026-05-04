# esamz.a

## Vercel deployment

This project is configured for Vercel deployment.

### Build Command

```bash
npm run build
```

### Output Directory

Use Next.js default output (`.next`).

### Required environment variables

Set these in Vercel Project Settings:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `MONGODB_URI`
- `CASHFREE_SECRET_KEY`
- `ESAMZ_MASTER_SECRET`

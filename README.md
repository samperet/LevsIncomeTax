# Lev's Income Tax Portal

Static client upload UI with a Node email backend for passwordless, email-only magic links and admin upload notifications.

## Run Locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:4173`.

Admin dashboard: `http://localhost:4173/admin/`

Customers use one access flow: enter an email address, receive a magic link, then confirm their tax profile after opening the link.

## Email Backend

Use either Resend:

```bash
RESEND_API_KEY=re_...
EMAIL_FROM="Lev's Income Tax <uploads@yourdomain.com>"
ADMIN_EMAIL=levsincometax@gmail.com
PUBLIC_APP_URL=https://your-domain.com
```

> **Resend sender address:** Use an address on a domain you have verified in Resend (e.g. `uploads@levsincometax.com`). `onboarding@resend.dev` is sandbox-only and only delivers to the email address that owns the Resend account — all other recipients are silently dropped.

Or SMTP:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM="Lev's Income Tax <uploads@yourdomain.com>"
ADMIN_EMAIL=levsincometax@gmail.com
PUBLIC_APP_URL=https://your-domain.com
```

If no email credentials are configured, the backend prints email previews and magic links to the server console.

## Storage (Cloudflare R2)

R2 is used for **two** things:

1. **Document storage** — Files are uploaded directly from the browser to R2 via presigned PUT URLs. The Node server never handles file bytes; it only issues and validates upload keys.
2. **Application state** — All clients, magic links, sessions, and alerts are stored as a single JSON blob at `app-state/store.json` in the same bucket. This makes the server stateless and lets it run on serverless platforms (Vercel) where the filesystem isn't persistent.

Add these to `.env` (see `.env.example` for all keys):

```bash
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET=your-bucket-name
```

Without R2 credentials, the server still starts and falls back to a local `data/store.json` file (useful for offline development), but `/api/uploads/presign` returns 503 since files have nowhere to go.

### R2 Bucket CORS Policy

Browser-direct uploads require a CORS policy on the bucket. In Cloudflare Dashboard → R2 → your bucket → Settings → CORS Policy, paste:

```json
[
  {
    "AllowedOrigins": ["http://localhost:4173", "https://levsincometax.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Replace `https://levsincometax.com` with your production domain (e.g. your Vercel URL) once you have one. For local-only development, the `localhost:4173` origin alone is sufficient.

## Deploy to Vercel

The app is structured as a hybrid static site + serverless function:

- Static assets (`index.html`, `lev-icon.svg`, etc.) are served directly by Vercel's CDN.
- All `/api/*` requests are routed to the Express app in `api/index.js`, which re-exports the app from `server.js`.
- Routing is declared in `vercel.json`.

### Environment variables to set in the Vercel project

Add each of these under **Project → Settings → Environment Variables** for the `Production` (and ideally `Preview`) environments:

| Variable | Notes |
|---|---|
| `ADMIN_PASSWORD` | Strong, unique. Default `levadmin` is fine for local but not for prod. |
| `ADMIN_EMAIL` | Where upload notifications go. |
| `EMAIL_FROM` | `"Lev's Income Tax <uploads@yourverifieddomain.com>"`. Must be on a Resend-verified domain. |
| `RESEND_API_KEY` | From the Resend dashboard. |
| `PUBLIC_APP_URL` | Your Vercel URL, e.g. `https://levsincometax.vercel.app`. Used in outgoing magic-link emails. |
| `R2_ACCOUNT_ID` | Cloudflare account ID. |
| `R2_ACCESS_KEY_ID` | R2 S3-API token. |
| `R2_SECRET_ACCESS_KEY` | R2 S3-API secret. |
| `R2_BUCKET` | Bucket name (e.g. `levsincometax`). |

### Don't forget the R2 CORS policy

Add your Vercel URL to the R2 bucket's `AllowedOrigins` (see CORS section above). Without it, browser uploads from the deployed site will be blocked with a CORS error even though presigning succeeds.

### Known limitation: concurrent writes

The R2-backed store is a single JSON blob. Two simultaneous requests that both mutate the store can race and clobber each other's writes. For this app's expected traffic (one tax preparer, a handful of clients per week) it's fine. If you ever scale up, migrate the store to Vercel KV or Postgres.

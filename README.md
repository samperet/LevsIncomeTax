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

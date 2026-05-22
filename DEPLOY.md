# Family Financial Command Center — Deployment Guide

## What you're deploying
- Login page at `your-app.vercel.app/`
- Dashboard at `your-app.vercel.app/dashboard`
- Bank sync API at `your-app.vercel.app/api/sync`
- Daily bill reminder emails at 8 AM via Vercel cron

---

## Step 1 — Run the Supabase schema

1. Open [supabase.com](https://supabase.com) → Your project → **SQL Editor**
2. Click **New query**
3. Paste the entire contents of `schema.sql` (in this folder)
4. Click **Run**

You should see "Success. No rows returned."

**Then turn off email confirmation** (so you can sign in immediately):
- Supabase → Authentication → Providers → Email
- Toggle OFF **"Enable email confirmations"**
- Save

---

## Step 2 — Get your Supabase service role key

You need this for the daily cron job to send reminders.

1. Supabase → Project Settings → API
2. Copy the **service_role** key (under "Project API keys" — the long secret one)
3. Keep this safe — it bypasses row-level security

---

## Step 3 — Push to GitHub

```bash
# In this folder (fcc-app):
git init
git add .
git commit -m "Initial commit — Family Financial Command Center"

# Create a new repo on GitHub (github.com → New repository)
# Then:
git remote add origin https://github.com/YOUR_USERNAME/fcc-app.git
git push -u origin main
```

---

## Step 4 — Connect to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Click **Import Git Repository** → select your `fcc-app` repo
3. Leave all settings as default (no framework preset needed)
4. Click **Deploy** — it will fail the first time (no env vars yet, that's fine)

---

## Step 5 — Add environment variables in Vercel

1. Vercel → Your project → **Settings → Environment Variables**
2. Add each of these (copy from `.env.example`):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://pvlcnnnjjlcbwfptujqi.supabase.co` |
| `SUPABASE_ANON_KEY` | `eyJhbGciO...` (the full anon key) |
| `SUPABASE_SERVICE_ROLE_KEY` | The service_role key from Step 2 |
| `RESEND_API_KEY` | `re_AufXka6t_...` |
| `REMINDER_EMAIL` | `srobertson@dentalxchange.com` |
| `SIMPLEFIN_CLAIM_URL` | `https://beta-bridge.simplefin.org/simplefin/claim/4B4ECA49...` |
| `CRON_SECRET` | Any random password, e.g. `fcc-cron-2026` |

3. After adding all variables, go to **Deployments** → click the 3-dot menu on the latest → **Redeploy**

---

## Step 6 — Create your account

1. Visit `https://your-app.vercel.app/`
2. Click **Create Account** tab
3. Enter your email + a password
4. You'll be redirected to the dashboard automatically

---

## Step 7 — Migrate your existing data

Your current dashboard data is in your browser's localStorage. On first load, the app automatically reads from localStorage and saves it to the cloud — so just:

1. Open `your-app.vercel.app/dashboard` in the **same browser** you've been using
2. Sign in
3. Your data will load from localStorage and immediately sync to Supabase
4. After that, data stays in the cloud across all devices

---

## Step 8 — Sync your bank

Once signed in, click the **🏦 Sync Bank** button in the sidebar.

- First sync: claims your SimpleFIN access URL and fetches 90 days of history
- Subsequent syncs: only pulls new transactions since last sync
- Transactions appear in **Bank Statements** and are categorized automatically

---

## Bill reminder emails

Vercel automatically runs `/api/cron` every morning at 8 AM (UTC).
Bills due within 3 days trigger an email to `REMINDER_EMAIL`.

To test manually, call:
```
GET https://your-app.vercel.app/api/cron
Authorization: Bearer fcc-cron-2026
```

---

## Custom domain (optional)

Vercel → Project → Settings → Domains → Add domain

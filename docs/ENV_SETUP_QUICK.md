# Environment setup: the short version

Only the steps below need action. Everything else in `.env` is either already correct or has a working default.

**Already done, leave alone:** all secrets (JWT, encryption, audit, pepper, cookie, metrics, AI signing), Cloudflare R2, Qdrant and Groq.

---

## 1. Database: Supabase (fix the password)

1. Open https://supabase.com/dashboard and select your project. If it says **Paused**, click **Restore**.
2. Go to **Project Settings → Database → Reset database password** and save the new password.
3. Put it in `.env`:
   ```dotenv
   DB_PASSWORD=your_new_password
   ```
   Avoid `$` and `#` in the password.
4. Go to **Project Settings → Data API** and switch it **off** (a security fix; this app never uses it).

## 2. Admin account (no platform needed: choose the values yourself)

```dotenv
PLATFORM_ADMIN_EMAIL=you@example.com
PLATFORM_ADMIN_PASSWORD=YourStrongPass2026
PLATFORM_ADMIN_NAME="Your Name"
```

The password needs 12+ characters, with an uppercase letter, a lowercase letter and a number. It must not contain your name or email.

Then run these once:

```powershell
npm run migration:run
npm run seed
```

After the seed succeeds, delete `PLATFORM_ADMIN_PASSWORD` from `.env`.

## 3. Redis: Aiven Valkey (replace Upstash)

Upstash's free tier runs out after about one day of uptime. Aiven is free and needs no card.

1. Sign up at https://console.aiven.io/signup.
2. Go to **Create service → Valkey → Free plan** and pick the region nearest you.
3. When the service shows **Running**, copy its **Service URI**.
4. Put it in `.env`:
   ```dotenv
   REDIS_URL=rediss://default:PASSWORD@HOST:PORT
   ```

## 4. Email

**For testing: Ethereal** (free, no signup, catches every email):

1. Open https://ethereal.email and click **Create Ethereal Account**.
2. Put the generated values in `.env`:
   ```dotenv
   MAIL_TRANSPORT=smtp
   SMTP_HOST=smtp.ethereal.email
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USERNAME=generated_user@ethereal.email
   SMTP_PASSWORD=generated_password
   MAIL_FROM_ADDRESS=no-reply@daiap.test
   MAIL_FROM_NAME=DAIAP
   ```
3. Read the emails in the inbox on the Ethereal website.

**For real delivery: Brevo** (free, 300 emails a day):

1. Sign up at https://www.brevo.com.
2. Go to **Senders, Domains & Dedicated IPs → Senders**, add your from-address and verify it.
3. Go to **SMTP & API → SMTP** and generate an SMTP key.
4. Use the same variables as above, with:
   - `SMTP_HOST=smtp-relay.brevo.com`
   - `SMTP_USERNAME` = your Brevo SMTP login
   - `SMTP_PASSWORD` = the SMTP key
   - `MAIL_FROM_ADDRESS` = the address you verified

## 5. AI service (uploads, RAG search, name masking)

**This service is not in the repository. It must be built first** (spec: `docs/contracts/ai-service-v1.md`). Once it is running, set:

```dotenv
AI_SERVICE_URL=https://your-ai-service-url
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
PII_NER_PROVIDER=ai-service
PII_DEFAULT_ON_FAILURE=REFUSE
```

Give the AI service the **same** `AI_SERVICE_SIGNING_SECRET` that is already in your `.env`.

Where to host it for free:
- **Google Cloud Run** (https://console.cloud.google.com): has a free tier but needs a card. Set a $1 budget alert.
- **Your PC plus Cloudflare tunnel**, for testing: run `cloudflared tunnel --url http://localhost:8000` and use the `https://….trycloudflare.com` URL it prints.

Hugging Face Spaces is **not** free for this any more.

## 6. Two small edits in `.env`

```dotenv
LLM_ALLOWED_MODELS=qwen/qwen3.8-27b
TOOL_HTTP_ALLOWED_HOSTS=api.open-meteo.com
```

The first removes `gpt-oss-120b`, which breaks agents that use tools on Groq. The second is optional: it enables the HTTP-tool demo.

## 7. Check that it works

```powershell
npm run start:dev
```

Open http://localhost:3000/health. Every component should say `up`. Swagger is at http://localhost:3000/docs.

---

## 8. When you deploy: Render (free)

1. Go to https://dashboard.render.com and choose **New → Web Service**. Connect your GitHub repo.
2. Choose **Runtime: Node**, **Plan: Free**, **Region: Singapore**.
3. Set **Build:** `npm ci --include=dev && npm run build`
4. Set **Start:** `npm run start:prod`
5. Set **Health check path:** `/health/ready`
6. Under **Environment**, copy every value from your `.env` **except `APP_PORT`**, then change or add these:

```dotenv
NODE_ENV=production
NODE_VERSION=22.14.0
APP_URL=https://your-service.onrender.com
FRONTEND_URL=https://your-frontend-url
CORS_ORIGINS=https://your-frontend-url
COOKIE_SECURE=true
COOKIE_SAME_SITE=none
LOG_PRETTY=false
```

`COOKIE_SAME_SITE=none` is needed when the frontend runs on a different domain, for example Vercel. If the frontend and backend share a parent domain, use `lax`.

---

## Checklist

- [ ] Supabase password reset and `DB_PASSWORD` updated
- [ ] Supabase Data API turned off
- [ ] Admin variables set; `migration:run` and `seed` done
- [ ] `REDIS_URL` moved to Aiven Valkey
- [ ] SMTP set (Ethereal or Brevo)
- [ ] AI service built and deployed; `AI_SERVICE_URL` set
- [ ] `LLM_ALLOWED_MODELS` edited
- [ ] `/health` shows everything `up`
- [ ] Deployed on Render

Detailed version with reasons and limits: `docs/E2E_ENVIRONMENT_GAP_REPORT.md`.

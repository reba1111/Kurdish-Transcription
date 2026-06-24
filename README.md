# VoxScript — Kurdish Transcription & Translation

Kurdish audio transcription and translation app powered by Gemini 2.5 Pro and ElevenLabs Scribe.

---

## Run Locally

**Prerequisites:** Node.js 18+

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your `.env` file (copy from example):
   ```bash
   cp .env.example .env
   ```

3. Add your API keys to `.env`:
   ```
   GEMINI_API_KEY=your_key_here
   ELEVENLABS_API_KEY=your_key_here
   ```

4. Run the app:
   ```bash
   npm run dev
   ```

---

## Deploy to Vercel

**IMPORTANT: Never put real API keys in code or `.env.example` — use Vercel Environment Variables.**

### Step 1 — Push to GitHub
Push your code to GitHub (API keys must NOT be in any file).

### Step 2 — Import to Vercel
1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repository
3. Framework Preset: **Vite**
4. Build Command: `vite build`
5. Output Directory: `dist`

### Step 3 — Add Environment Variables
In Vercel Dashboard → your project → **Settings → Environment Variables**, add:

| Name | Value |
|------|-------|
| `GEMINI_API_KEY` | your Gemini API key |
| `ELEVENLABS_API_KEY` | your ElevenLabs API key |

Set environment to: **Production**, **Preview**, **Development** (tick all three).

### Step 4 — Deploy
Click **Deploy** — Vercel will build and deploy automatically.

Every time you push to GitHub, Vercel will redeploy automatically with the same environment variables.

---

## API Keys

- **Gemini API Key** → [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- **ElevenLabs API Key** → [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)

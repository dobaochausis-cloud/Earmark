# Earmark — website edition

This folder is Earmark as a normal website that anyone can open, with no Claude account needed.

| Part | What it does |
|---|---|
| `public/index.html` | The app. Built from `earmark.html`, the same file that runs on claude.ai. |
| `public/platform.js` | Saves each person's books, flashcards and scores **in their own browser**. Sends AI questions to the server. |
| `functions/api/sample.js` | The only server code. It passes questions to Claude using **your** Anthropic API key, which stays secret on the server. |

Nobody's books are uploaded to your server. Each student's library stays on their own device and browser.

---

## Before you start: what you need

1. **An Anthropic API account and some credit.** This is what pays for the AI answers.
   - Anthropic API accounts are for adults (18+). If you're under 18, ask a parent, guardian or teacher to create the account and API key.
   - Sign up at <https://console.anthropic.com>, add credit (you pay up front), then create an **API key**.
   - **Set a monthly spend limit** in the Console (Settings → Limits), for example $10. This is your main protection against surprise costs.
2. **A free Cloudflare account**: <https://dash.cloudflare.com/sign-up>
3. **A free GitHub account**: <https://github.com/signup>, to hold the code.

## Step 1: put the code on GitHub

1. On GitHub, click **New repository**, name it `earmark`, and create it.
2. Upload everything in this folder **except** `node_modules` and `.wrangler`.
   - On the repository page, use **Add file → Upload files**, and drag in `public`, `functions`, `earmark.html`, `build.mjs`, `package.json`, `package-lock.json`, `wrangler.toml`, `.gitignore` and `README.md`.

## Step 2: create the website on Cloudflare

1. In Cloudflare, go to **Workers & Pages → Create → Pages → Connect to Git**, and choose your `earmark` repository.
2. Build settings:
   - **Framework preset:** None
   - **Build command:** `npm run build`
   - **Build output directory:** `public`
3. Click **Save and Deploy**. Your site will be at something like `https://earmark.pages.dev` (Cloudflare picks another name if that one is taken).

## Step 3: add your API key (and a class code)

In your Cloudflare Pages project, go to **Settings → Variables and Secrets** and add:

| Name | Type | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Secret** | your key from console.anthropic.com |
| `ACCESS_CODE` | Secret (optional, recommended) | a class code, for example `owl42`. People must type it once before the AI works, so strangers who find your link can't spend your credit. |
| `MODEL` | Text (optional) | which Claude model to use (see costs below) |

Then go to **Deployments** and **retry the latest deployment** so the new settings take effect.

## What it costs

Hosting on Cloudflare is free. You only pay Anthropic for AI use, from the credit you added.

By default the site uses **Claude Opus 5** ($5 per million input tokens and $25 per million output tokens). Each question sends up to about 16,000 tokens of book text, so a rough guide is:

- **Asking a question, making flashcards or a quiz:** about 5–15¢ each
- **Word look-ups (hover for 3 seconds):** about 1¢ each

To spend less, set `MODEL` to one of these:

- `claude-sonnet-5`: about 2½× cheaper
- `claude-haiku-4-5`: about 5× cheaper, and less careful with harder questions

Read-aloud, the PDF viewer and the games don't use the AI, so they cost nothing.

## Updating the site later

When the app changes, replace `earmark.html` in your GitHub repository with the new version. Cloudflare rebuilds the site by itself within a minute or two.

## Trying it on your own computer (optional)

This needs Node.js from <https://nodejs.org>.

```bash
npm install
echo "ANTHROPIC_API_KEY=your-key-here" > .dev.vars
npm run build
npm run dev          # opens on http://localhost:8788
```

## Good to know

- **Books are saved per browser.** If someone clears their browsing data or switches devices, their library doesn't come with them. Each browser can typically store several hundred MB to a few GB.
- **Read-aloud voices come from each person's device**, so they sound different on a phone, a Chromebook or a Mac.
- **Keep your API key secret.** Never put it in `earmark.html`, `platform.js` or anywhere in GitHub. It only goes in Cloudflare's **Secret** settings.

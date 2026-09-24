# Earmark — website edition

This folder is Earmark as a normal website that anyone can open, with no Claude account needed.

| Part | What it does |
|---|---|
| `public/index.html` | The app. Built from `earmark.html`, the same file that runs on claude.ai. |
| `public/platform.js` | Saves each person's books, flashcards and scores **in their own browser**. Sends AI questions to the server. |
| `functions/api/sample.js` | The only server code. It asks Cloudflare's free AI, or Claude if you add an Anthropic API key (the key stays secret on the server). |
| `functions/api/fetch.js` | Reads a web page someone adds by link (Add a book → Or add a web page) and keeps only its readable text. Refuses private and local addresses, and uses the same class code as the AI. |

Nobody's books are uploaded to your server. Each student's library stays on their own device and browser.

---

## Before you start: what you need

1. **Optional: an Anthropic API account and some credit**, only if you want Claude's answers instead of the free AI.
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

## Step 3: the AI

**It works for free out of the box.** With no key added, the site uses **Cloudflare Workers AI** (Google's Gemma 4 model) on Cloudflare's free daily allowance. That allowance resets every day. If it runs out, people see "Today's free AI allowance is used up", and everything else keeps working.

**Checking the free AI:** open `https://YOUR-SITE.pages.dev/api/sample?test=1` in your browser (add `&code=YOUR_CLASS_CODE` if you set one). It shows whether the AI answered, and the exact error if it didn't.

To get Claude's better answers later, add these in your Pages project under **Settings → Variables and Secrets**, then **retry the latest deployment**:

| Name | Type | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Secret** | your key from console.anthropic.com. Once it's set, the site uses Claude instead of the free AI. |
| `ACCESS_CODE` | Secret (optional) | a class code, for example `owl42`. People type it once before the AI works, so strangers can't use up your allowance or credit. |
| `MODEL` | Text (optional) | which Claude model to use (see costs below) |
| `FREE_MODEL` | Text (optional) | a different Workers AI model, for example `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

## What it costs

- **Free AI (no key):** $0. Hosting on Cloudflare is free too.
- **Claude (with a key):** you pay Anthropic per use from credit you add ahead of time. With the default **Claude Opus 5**, asking a question or making flashcards or a quiz costs about 5–15¢, and a word look-up about 1¢. Set `MODEL` to `claude-sonnet-5` (about 2½× cheaper) or `claude-haiku-4-5` (about 5× cheaper) to spend less.

Read-aloud, the PDF viewer and the games never use the AI.

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

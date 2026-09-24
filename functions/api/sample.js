/* Earmark — the website's only server code.
 *
 * POST /api/sample   { messages, tier: "quick"|"default"|"complex", json: bool }
 * Streams back one JSON object per line:
 *   {"d": "text"}                  – more of the answer
 *   {"done": true, "stop": "..."}  – finished (stop = the API's stop_reason)
 *   {"error": {code, message}}     – failed part-way
 *
 * GET /api/sample    → { provider, maxPromptBytes } so the page sizes its requests.
 *
 * Which AI answers:
 *   - Claude, when ANTHROPIC_API_KEY is set (paid per use, best answers).
 *   - Otherwise Cloudflare Workers AI through the "AI" binding in wrangler.toml
 *     (free daily allowance on every Cloudflare account; resets each day).
 *
 * Settings (Cloudflare Pages → Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY  (optional, secret)  your key from console.anthropic.com
 *   ACCESS_CODE        (optional, secret)  a class code people must enter to use the AI
 *   MODEL              (optional)          Claude model; defaults to claude-opus-5
 *   FREE_MODEL         (optional)          Workers AI model; defaults to Gemma 4 (see below)
 */
// The official Anthropic SDK, pre-packed into one file (npm run vendor) so
// Cloudflare needs no install step to run this.
import Anthropic from "../../lib/anthropic-sdk.mjs";

const DEFAULT_MODEL = "claude-opus-5";
// Google's Gemma 4 on Workers AI: quick, cheap on the free allowance, and good
// in many languages (Vietnamese included).
const DEFAULT_FREE_MODEL = "@cf/google/gemma-4-26b-a4b-it";

// How much book text the page may send. The free model gets less, so each
// question uses less of the daily allowance.
const PROMPT_BYTES = { claude: 65536, free: 24000 };

// How hard Claude thinks, per kind of request. Word look-ups are "quick";
// answers, flashcards and quizzes are "default".
const EFFORT = { quick: "low", default: "medium", complex: "high" };
const MAX_TOKENS = { quick: 2000, default: 16000, complex: 32000 };

const SYSTEM =
  "You are the study helper inside Earmark, an app for students who learn by listening. " +
  "Follow the instructions in each request exactly, answer only from the book text you are given, " +
  "and write clearly for a student.";
const SYSTEM_JSON = SYSTEM + " Reply with only the JSON that was asked for: no code fences and no other text.";

// Best-effort per-visitor limit (each server instance counts on its own).
// The real safety net is the monthly spend limit you set in the Anthropic Console.
const WINDOW_MS = 60_000, MAX_PER_WINDOW = 60;
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content) return null;
    out.push({ role: m.role, content: m.content });
  }
  return out[0].role === "user" && out[out.length - 1].role === "user" ? out : null;
}

function providerFor(env) {
  if (env.ANTHROPIC_API_KEY) return "claude";
  if (env.AI) return "free";
  return null;
}

export async function onRequestGet({ request, env }) {
  const provider = providerFor(env);
  const url = new URL(request.url);
  if (url.searchParams.get("test") && provider === "free") {
    if (env.ACCESS_CODE && url.searchParams.get("code") !== env.ACCESS_CODE) {
      return json(401, { code: "not_granted", message: "Add &code=YOUR_CLASS_CODE to the address." });
    }
    return testWorkersAI(env);
  }
  return json(200, { provider, maxPromptBytes: provider ? PROMPT_BYTES[provider] : 0 });
}

export async function onRequestPost({ request, env }) {
  const provider = providerFor(env);
  if (!provider) {
    return json(503, { code: "not_configured", message: "The site owner hasn't turned on an AI yet." });
  }
  if (env.ACCESS_CODE && request.headers.get("x-earmark-code") !== env.ACCESS_CODE) {
    return json(401, { code: "not_granted", message: "A class code is needed to use the AI." });
  }
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (tooMany(ip)) return json(429, { code: "rate_limited", message: "Slow down a little — try again in a minute." });

  const raw = await request.text();
  if (raw.length > PROMPT_BYTES[provider] + 4096) {
    return json(413, { code: "prompt_too_large", message: "That request is too large." });
  }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json(400, { code: "bad_request", message: "Bad request." }); }
  const messages = cleanMessages(body.messages);
  if (!messages) return json(400, { code: "bad_request", message: "Bad request." });
  const tier = EFFORT[body.tier] ? body.tier : "default";
  const system = body.json ? SYSTEM_JSON : SYSTEM;
  if (provider === "free") return askWorkersAI(env, messages, system, tier);

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Only used for local testing against a stand-in server.
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
  });

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (obj) => writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

  const model = env.MODEL || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: MAX_TOKENS[tier],
    system,
    messages,
  };
  // Haiku doesn't take an effort setting; the other current models do.
  if (!/haiku/.test(model)) params.output_config = { effort: EFFORT[tier] };
  // On Claude Opus 5, if a safety check declines a request, let Anthropic
  // retry it on its recommended fallback model instead of failing.
  if (model === "claude-opus-5") {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  (async () => {
    try {
      const stream = client.beta.messages.stream(params);
      stream.on("text", (delta) => { send({ d: delta }); });
      const final = await stream.finalMessage();
      await send({ done: true, stop: final.stop_reason });
    } catch (err) {
      let code = "server_error", message = "The AI isn't available right now.";
      if (err instanceof Anthropic.RateLimitError) { code = "rate_limited"; message = "The AI is busy — try again in a moment."; }
      else if (err instanceof Anthropic.AuthenticationError) { code = "not_configured"; message = "The site's API key isn't working."; }
      else if (err instanceof Anthropic.BadRequestError) { code = "bad_request"; message = "The AI couldn't handle that request."; }
      else if (err instanceof Anthropic.APIError) { message = "The AI had a problem (" + (err.status || "no status") + ")."; }
      await send({ error: { code, message } }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ---- the free option: Cloudflare Workers AI ----
   Same reply format as above. The binding streams OpenAI-style chunks
   ("data: {choices:[{delta:{content}}]}"); some older models send
   {"response": "..."} instead, so both are read.

   Gemma 4 "thinks" before answering unless told not to, and that thinking
   can use up the whole token limit and leave no answer. So thinking is
   switched off, and if a model still gives nothing (or fails) before any
   text has reached the page, the next attempt runs instead. */
const FALLBACK_FREE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function freeAttempts(env) {
  const primary = env.FREE_MODEL || DEFAULT_FREE_MODEL;
  const list = [
    { model: primary, extra: { chat_template_kwargs: { enable_thinking: false } } },
    { model: primary, extra: {} },
  ];
  if (primary !== FALLBACK_FREE_MODEL) list.push({ model: FALLBACK_FREE_MODEL, extra: {} });
  return list;
}

// Runs one attempt, passing each piece of answer text to onText.
// Resolves { stop, chars }; throws if the model call itself fails.
async function streamWorkersAI(env, attempt, messages, system, maxTokens, onText) {
  const out = await env.AI.run(attempt.model, {
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: maxTokens,
    stream: true,
    ...attempt.extra,
  });
  let stop = "end_turn", chars = 0;
  const handle = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(data); } catch (e) { return; }
    const choice = chunk.choices && chunk.choices[0];
    const text = choice ? (choice.delta && choice.delta.content) || "" : chunk.response || "";
    if (text) { chars += text.length; onText(text); }
    if (choice && choice.finish_reason === "length") stop = "max_tokens";
  };
  if (out && typeof out.getReader === "function") {
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    handle(buf);
  } else if (out) {
    // Some models ignore stream:true and answer all at once.
    const choice = out.choices && out.choices[0];
    const text = (choice && choice.message && choice.message.content) || out.response || "";
    if (text) { chars += text.length; onText(text); }
  }
  return { stop, chars };
}

const usedUpMessage = (msg) => /neuron|daily free allocation|4006|3036/i.test(msg);

async function askWorkersAI(env, messages, system, tier) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (obj) => writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

  (async () => {
    let lastError = "";
    try {
      for (const attempt of freeAttempts(env)) {
        let sent = 0;
        try {
          const r = await streamWorkersAI(env, attempt, messages, system, tier === "quick" ? 800 : 4000,
            (text) => { sent += text.length; send({ d: text }); });
          if (r.chars > 0) { await send({ done: true, stop: r.stop }); return; }
          lastError = "empty answer from " + attempt.model;
        } catch (err) {
          lastError = String((err && err.message) || err);
          if (usedUpMessage(lastError)) break;
          if (sent > 0) break;   // part of an answer already went out; don't mix in another
        }
      }
      await send({ error: usedUpMessage(lastError)
        ? { code: "daily_limit", message: "Today's free AI allowance is used up. It resets tomorrow." }
        : { code: "server_error", message: "The free AI isn't available right now. Try again in a moment." } });
    } catch (e) {
      /* the page went away */
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

// Open /api/sample?test=1 in a browser to see exactly what the free AI does.
async function testWorkersAI(env) {
  const tries = [];
  for (const attempt of freeAttempts(env)) {
    let text = "";
    try {
      const r = await streamWorkersAI(env, attempt,
        [{ role: "user", content: 'Reply with exactly: POS: noun / DEFINITION: a small living unit / SYNONYMS: unit' }],
        SYSTEM, 200, (t) => { text += t; });
      tries.push({ model: attempt.model, settings: attempt.extra, ok: r.chars > 0, stop: r.stop, text: text.slice(0, 200) });
      if (r.chars > 0) break;
    } catch (err) {
      tries.push({ model: attempt.model, settings: attempt.extra, ok: false, error: String((err && err.message) || err).slice(0, 300) });
      if (usedUpMessage(String(err && err.message))) break;
    }
  }
  return json(200, { provider: "free", works: tries.some((t) => t.ok), tries });
}

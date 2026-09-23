/* Earmark — the website's only server code.
 *
 * POST /api/sample   { messages, tier: "quick"|"default"|"complex", json: bool }
 * Streams back one JSON object per line:
 *   {"d": "text"}                  – more of the answer
 *   {"done": true, "stop": "..."}  – finished (stop = the API's stop_reason)
 *   {"error": {code, message}}     – failed part-way
 *
 * Settings (Cloudflare Pages → Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY  (required, secret)  your key from console.anthropic.com
 *   ACCESS_CODE        (optional, secret)  a class code people must enter to use the AI
 *   MODEL              (optional)          defaults to claude-opus-5; claude-sonnet-5 or
 *                                          claude-haiku-4-5 cost less per question
 */
// The official Anthropic SDK, pre-packed into one file (npm run vendor) so
// Cloudflare needs no install step to run this.
import Anthropic from "../../lib/anthropic-sdk.mjs";

const MAX_BODY_BYTES = 65536 + 4096;   // matches the page's prompt budget
const DEFAULT_MODEL = "claude-opus-5";

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
const WINDOW_MS = 60_000, MAX_PER_WINDOW = 20;
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

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json(503, { code: "not_configured", message: "The site owner hasn't added an Anthropic API key yet." });
  }
  if (env.ACCESS_CODE && request.headers.get("x-earmark-code") !== env.ACCESS_CODE) {
    return json(401, { code: "not_granted", message: "A class code is needed to use the AI." });
  }
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (tooMany(ip)) return json(429, { code: "rate_limited", message: "Slow down a little — try again in a minute." });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { code: "prompt_too_large", message: "That request is too large." });
  }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json(400, { code: "bad_request", message: "Bad request." }); }
  const messages = cleanMessages(body.messages);
  if (!messages) return json(400, { code: "bad_request", message: "Bad request." });
  const tier = EFFORT[body.tier] ? body.tier : "default";

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
    system: body.json ? SYSTEM_JSON : SYSTEM,
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

/* Earmark — a natural, human-sounding reading voice.
 *
 * GET  /api/tts           → { available, model, langs }
 * GET  /api/tts?test=1    → tries the voice once and shows what happened
 * POST /api/tts  { text, lang, voice: "female" | "male" }  → audio/mpeg
 *   errors: { code, message } with codes not_configured, not_granted,
 *   rate_limited, bad_request, daily_limit, unsupported_lang, server_error
 *
 * Uses Cloudflare Workers AI (the same "AI" binding as the free AI answers):
 *   TTS_MODEL = "melotts" (default) — MeloTTS: natural, very cheap, so the
 *               free daily allowance covers many hours of listening.
 *   TTS_MODEL = "aura-2"  — Deepgram Aura 2: the most human-sounding, but it
 *               costs far more per word (needs the Workers Paid plan for
 *               real use). English and Spanish; other languages use MeloTTS.
 *   TTS_MODEL = "aura-1"  — Deepgram Aura 1, English only.
 *   TTS_VOICE = a speaker name for Aura (for example "luna").
 *   TTS_MALE  = "aura-1" or "aura-2" — a natural MALE voice (English) from
 *               Deepgram Aura. MeloTTS only has one (female-sounding) voice,
 *               so without this the app uses the device's best male voice.
 *               Aura costs far more per word than MeloTTS (see README).
 *   TTS_MALE_VOICE = the Aura speaker for it (default "orion" / "apollo").
 *
 * Every clip is cached, so a class listening to the same book only pays once.
 */

const MAX_CHARS = 700;
const MELO = "@cf/myshell-ai/melotts";
const MELO_LANGS = { en: ["en"], es: ["es"], fr: ["fr"], zh: ["zh"], ja: ["ja", "jp"], ko: ["ko", "kr"] };
const PREMIUM = {
  "aura-2": { langs: { en: "@cf/deepgram/aura-2-en", es: "@cf/deepgram/aura-2-es" }, female: "luna", male: "apollo" },
  "aura-1": { langs: { en: "@cf/deepgram/aura-1" }, female: "asteria", male: "orion" },
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Per student browser, with a higher cap for a whole school on one address.
const hits = new Map();
function count(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 20000) hits.clear();
  return recent.length;
}
function tooMany(request) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const dev = (request.headers.get("x-earmark-device") || "").toLowerCase();
  const device = /^[a-z0-9]{8,40}$/.test(dev) ? dev : "none";
  return count("ip:" + ip) > 1500 || count("dev:" + ip + ":" + device) > 90;
}

function choice(env) {
  const name = String(env.TTS_MODEL || "melotts").toLowerCase();
  return PREMIUM[name] ? name : "melotts";
}
function maleChoice(env) {
  const name = String(env.TTS_MALE || "").toLowerCase();
  return PREMIUM[name] ? name : "";
}
function langsFor(env, voice) {
  if (voice === "male") return maleChoice(env) ? ["en"] : [];
  const premium = PREMIUM[choice(env)];
  return Array.from(new Set([...Object.keys(MELO_LANGS), ...(premium ? Object.keys(premium.langs) : [])]));
}
// The model runs to try for a language and voice, best first.
function plan(env, lang, voice) {
  const out = [];
  if (voice === "male") {
    // Never fall back to MeloTTS here: it would answer in a female voice.
    const m = PREMIUM[maleChoice(env)];
    if (m && m.langs[lang]) out.push({ model: m.langs[lang], kind: "aura", input: { text: "", speaker: String(env.TTS_MALE_VOICE || m.male) } });
    return out;
  }
  const premium = PREMIUM[choice(env)];
  if (premium && premium.langs[lang] && (lang === "en" || env.TTS_VOICE)) {
    out.push({ model: premium.langs[lang], kind: "aura", input: { text: "", speaker: String(env.TTS_VOICE || premium.female) } });
  }
  for (const code of MELO_LANGS[lang] || []) out.push({ model: MELO, kind: "melo", input: { prompt: "", lang: code } });
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Workers AI answers with base64 in { audio }, raw bytes, or a stream,
// depending on the model; all become bytes here.
async function toBytes(out) {
  if (!out) return null;
  if (out instanceof Response) return new Uint8Array(await out.arrayBuffer());
  if (typeof out.getReader === "function") return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (ArrayBuffer.isView(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  if (typeof out.audio === "string") return base64ToBytes(out.audio);
  if (out.audio) return toBytes(out.audio);
  return null;
}

async function speak(env, lang, text, voice) {
  let lastError = "";
  for (const step of plan(env, lang, voice)) {
    const input = Object.assign({}, step.input);
    if (step.kind === "aura") input.text = text; else input.prompt = text;
    try {
      const bytes = await toBytes(await env.AI.run(step.model, input));
      if (bytes && bytes.length > 200) return { bytes, model: step.model };
      lastError = "no audio from " + step.model;
    } catch (err) {
      lastError = String((err && err.message) || err);
      if (/neuron|daily free allocation|4006|3036/i.test(lastError)) throw Object.assign(new Error(lastError), { code: "daily_limit" });
    }
  }
  throw Object.assign(new Error(lastError || "no voice"), { code: "server_error" });
}

async function cacheKey(model, lang, text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v2|" + model + "|" + lang + "|" + text));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://earmark-tts.cache/" + hex);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("test")) {
    if (env.ACCESS_CODE && url.searchParams.get("code") !== env.ACCESS_CODE) return json(401, { error: "Add &code=YOUR_CLASS_CODE to the address." });
    if (!env.AI) return json(200, { ok: false, error: "No AI binding. Check wrangler.toml has [ai] binding = \"AI\"." });
    const tries = [];
    for (const [lang, voice] of [["en", "female"], ["es", "female"], ["en", "male"]]) {
      if (!langsFor(env, voice).includes(lang)) { tries.push({ lang, voice, ok: false, error: "not turned on" }); continue; }
      try {
        const r = await speak(env, lang, lang === "en" ? "Hello! This is Earmark's reading voice." : "¡Hola! Esta es la voz de Earmark.", voice);
        tries.push({ lang, voice, ok: true, model: r.model, bytes: r.bytes.length });
      } catch (e) {
        tries.push({ lang, voice, ok: false, error: String(e.message || e).slice(0, 300) });
      }
    }
    return json(200, { choice: choice(env), male: maleChoice(env) || "device voice", tries });
  }
  const on = !!env.AI && env.TTS !== "off";
  return json(200, { available: on, model: choice(env), langs: on ? langsFor(env) : [], female: on ? langsFor(env, "female") : [], male: on ? langsFor(env, "male") : [] });
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.AI || env.TTS === "off") return json(503, { code: "not_configured", message: "The reading voice isn't turned on." });
  if (env.ACCESS_CODE && request.headers.get("x-earmark-code") !== env.ACCESS_CODE) {
    return json(401, { code: "not_granted", message: "A class code is needed." });
  }
  if (tooMany(request)) return json(429, { code: "rate_limited", message: "Slow down a little — try again in a minute." });
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const text = String(body.text || "").replace(/\s+/g, " ").trim();
  const lang = String(body.lang || "en").toLowerCase().split("-")[0];
  const voice = body.voice === "male" ? "male" : "female";
  if (!text || text.length > MAX_CHARS) return json(400, { code: "bad_request", message: "Send between 1 and " + MAX_CHARS + " characters." });
  if (!langsFor(env, voice).includes(lang)) return json(400, { code: "unsupported_lang", message: "No reading voice for that language yet." });

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = await cacheKey(voice === "male" ? "male:" + maleChoice(env) + ":" + (env.TTS_MALE_VOICE || "") : choice(env) + ":" + (env.TTS_VOICE || ""), lang, text);
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit;
  }
  try {
    const { bytes } = await speak(env, lang, text, voice);
    const res = new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=2592000" } });
    if (cache) {
      const put = cache.put(key, res.clone()).catch(() => {});
      if (waitUntil) waitUntil(put);
    }
    return res;
  } catch (e) {
    return e.code === "daily_limit"
      ? json(429, { code: "daily_limit", message: "Today's free voice allowance is used up. It resets tomorrow." })
      : json(502, { code: "server_error", message: "The reading voice isn't available right now." });
  }
}

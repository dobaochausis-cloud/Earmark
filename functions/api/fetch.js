/* Earmark — turn a web page link into readable text.
 *
 * POST /api/fetch   { url }
 *   → 200 { title, text, url }
 *   → 4xx/5xx { code, message }   codes: bad_url, fetch_failed, not_text,
 *                                        too_big, no_text, not_granted, rate_limited
 *
 * The page is fetched once, on the student's request, and only its readable
 * text (headings, paragraphs, lists) is kept: no scripts, menus or ads.
 */

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 300000;
const FETCH_TIMEOUT_MS = 15000;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Only public http(s) pages: never this server itself or private networks.
function checkUrl(raw, allowLocal) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!allowLocal) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null;
    if (host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return null;
    if (!host.includes(".") && !host.includes(":")) return null;
  }
  return u;
}

const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 10;
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", deg: "°", times: "×", divide: "÷",
  eacute: "é", egrave: "è", aacute: "á", agrave: "à", oacute: "ó", uacute: "ú", iacute: "í", ntilde: "ñ", ccedil: "ç",
  auml: "ä", ouml: "ö", uuml: "ü", szlig: "ß", middot: "·", bull: "•", minus: "−", plusmn: "±", frac12: "½", pi: "π" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function stripBlocks(html, tags) {
  for (const tag of tags) html = html.replace(new RegExp("<" + tag + "\\b[\\s\\S]*?</" + tag + "\\s*>", "gi"), " ");
  return html;
}

function htmlToText(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, " ");
  html = stripBlocks(html, ["script", "style", "noscript", "svg", "template", "iframe", "canvas", "select", "button"]);
  // Prefer the main content when the page marks it.
  const main = html.match(/<(article|main)\b[\s\S]*<\/\1\s*>/i);
  let body = main ? main[0] : (html.match(/<body\b[\s\S]*<\/body\s*>/i) || [html])[0];
  body = stripBlocks(body, ["nav", "header", "footer", "aside", "form"]);
  body = body
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/(h[1-6])\s*>/gi, "\n")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|blockquote|pre|tr|table|ul|ol|dl|dt|dd|figure|figcaption|caption)\b[^>]*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  const lines = decodeEntities(body).split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim());
  const out = [];
  for (const l of lines) {
    if (!l || l === "•") { if (out.length && out[out.length - 1] !== "") out.push(""); continue; }
    if (out.length && out[out.length - 1] === l) continue;   // repeated line (menus, captions)
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pageTitle(html, fallback) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const t = og ? og[1] : ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  return decodeEntities(t).replace(/\s+/g, " ").trim().slice(0, 140) || fallback;
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PAGE_BYTES) { try { await reader.cancel(); } catch (e) {} return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const charset = ((res.headers.get("content-type") || "").match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
  try { return new TextDecoder(charset).decode(all); } catch (e) { return new TextDecoder("utf-8").decode(all); }
}

export async function onRequestPost({ request, env }) {
  if (env.ACCESS_CODE && request.headers.get("x-earmark-code") !== env.ACCESS_CODE) {
    return json(401, { code: "not_granted", message: "A class code is needed." });
  }
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (tooMany(ip)) return json(429, { code: "rate_limited", message: "Slow down a little — try again in a minute." });

  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const url = checkUrl(body.url, env.ALLOW_LOCAL_FETCH === "1");
  if (!url) return json(400, { code: "bad_url", message: "That doesn't look like a web page address." });

  let res;
  try {
    let current = url;
    // Follow redirects by hand so every hop gets the same safety check.
    for (let hop = 0; ; hop++) {
      res = await fetch(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "Mozilla/5.0 (compatible; EarmarkReader/1.0; study app)", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location") && hop < 5) {
        current = checkUrl(new URL(res.headers.get("location"), current).toString(), env.ALLOW_LOCAL_FETCH === "1");
        if (!current) return json(400, { code: "bad_url", message: "That page redirects somewhere Earmark can't open." });
        continue;
      }
      break;
    }
  } catch (e) {
    return json(502, { code: "fetch_failed", message: "Couldn't open that page." });
  }
  if (!res.ok) return json(502, { code: "fetch_failed", message: "The page answered with an error (" + res.status + ")." });

  const type = (res.headers.get("content-type") || "").toLowerCase();
  const isHtml = type.includes("html") || type.includes("xml");
  if (!isHtml && !type.startsWith("text/")) {
    return json(415, { code: "not_text", message: "That link isn't a web page (it looks like a " + (type.split(";")[0] || "file") + ")." });
  }
  const raw = await readCapped(res);
  if (raw === null) return json(413, { code: "too_big", message: "That page is too big to read." });

  const text = (isHtml ? htmlToText(raw) : raw.trim()).slice(0, MAX_TEXT_CHARS);
  if (text.replace(/\s+/g, " ").length < 200) {
    return json(422, { code: "no_text", message: "That page has no readable text." });
  }
  return json(200, { title: isHtml ? pageTitle(raw, url.hostname) : url.hostname, text, url: url.toString() });
}

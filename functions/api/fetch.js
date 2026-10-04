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

// Per student browser (x-earmark-device), with a higher cap for a whole
// school sharing one internet address.
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
  return count("ip:" + ip) > 150 || count("dev:" + ip + ":" + device) > 10;
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

/* The page as reading blocks, in order:
     { k: "h1".."h4" | "p" | "li" | "quote" | "pre" | "cap", t: "text" }
     { k: "img", src: "https://…", alt: "…" }
   The book text is made from the same blocks, so the "View page" reader can
   light up each word as it is read aloud. */
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "main", "blockquote", "pre", "li", "ul", "ol", "dl", "dt", "dd",
  "figure", "figcaption", "caption", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "header", "br", "hr", "td", "th"]);
const MAX_IMAGES = 40;

function attr(tag, name) {
  const m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : "";
}
function imageFrom(tag, base) {
  let src = attr(tag, "data-src") || attr(tag, "data-original") || attr(tag, "src");
  if (!src || /^data:/i.test(src)) src = (attr(tag, "srcset") || attr(tag, "data-srcset")).split(",")[0].trim().split(/\s+/)[0];
  if (!src || /^data:/i.test(src)) return null;
  const w = parseInt(attr(tag, "width"), 10), h = parseInt(attr(tag, "height"), 10);
  if ((w && w < 48) || (h && h < 48)) return null;             // icons, spacers, tracking pixels
  if (/sprite|pixel|spacer|logo|icon|avatar|badge/i.test(src)) return null;
  let u;
  try { u = new URL(src, base); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return { k: "img", src: u.toString(), alt: attr(tag, "alt").replace(/\s+/g, " ").trim().slice(0, 200) };
}

function htmlToBlocks(html, base) {
  html = html.replace(/<!--[\s\S]*?-->/g, " ");
  html = stripBlocks(html, ["script", "style", "noscript", "svg", "template", "iframe", "canvas", "select", "button"]);
  // Prefer the main content when the page marks it.
  const main = html.match(/<(article|main)\b[\s\S]*<\/\1\s*>/i);
  let body = main ? main[0] : (html.match(/<body\b[\s\S]*<\/body\s*>/i) || [html])[0];
  body = stripBlocks(body, ["nav", "footer", "aside", "form", "time"]);
  // A <header> that holds the article's headline is kept (the headline is
  // part of the text); other headers (site logo, menus) are dropped.
  body = body.replace(/<header\b[^>]*>([\s\S]*?)<\/header\s*>/gi, (all, inner) => (/<h1\b/i.test(inner) ? inner : " "));
  // Bylines, dates, share buttons and similar page details are not the text.
  body = dropMarked(body);

  const blocks = [];
  const stack = [];         // open block tags, innermost last
  let buf = "", images = 0;
  const kind = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const t = stack[i];
      if (/^h[1-6]$/.test(t)) return "h" + Math.min(4, Number(t[1]));
      if (t === "li" || t === "dt" || t === "dd") return "li";
      if (t === "blockquote") return "quote";
      if (t === "pre") return "pre";
      if (t === "figcaption" || t === "caption") return "cap";
    }
    return "p";
  };
  const flush = () => {
    const k = kind();
    const text = decodeEntities(buf).replace(k === "pre" ? /[ \t\u00a0]+/g : /[\s\u00a0]+/g, " ").trim();
    buf = "";
    if (!text) return;
    const last = blocks[blocks.length - 1];
    if (last && last.t === text) return;                       // repeated line (menus, captions)
    blocks.push({ k, t: text.slice(0, 20000) });
  };
  const re = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>|[^<]+/gi;
  let m;
  while ((m = re.exec(body))) {
    if (!m[2]) { buf += m[0]; continue; }
    const tag = m[2].toLowerCase(), closing = m[1] === "/";
    if (tag === "img" && !closing) {
      const img = images < MAX_IMAGES ? imageFrom(m[0], base) : null;
      if (img) { flush(); blocks.push(img); images++; }
      continue;
    }
    if (!BLOCK_TAGS.has(tag)) { if (tag === "td" || tag === "th") buf += " "; continue; }
    flush();
    if (tag === "br" || tag === "hr") continue;
    if (closing) { const at = stack.lastIndexOf(tag); if (at >= 0) stack.length = at; }
    else stack.push(tag);
  }
  flush();
  // Drop pictures that only sit next to nothing (galleries at the very end).
  while (blocks.length && blocks[blocks.length - 1].k === "img") blocks.pop();
  return tidyBlocks(blocks);
}

// Elements whose class / id / test id / itemprop says they are page details
// (bylines, dates, share bars, tags…) are removed with everything inside.
const META_ATTR = /\b(?:class|id|data-testid|data-component|itemprop|rel|role)\s*=\s*["'][^"']*\b(byline|author|contributor|dateline|datetime|timestamp|published|date-?time|article-?meta|metadata|share|social|related|newsletter|tags?-?list|topic-?list|breadcrumb|advert|promo|cookie|subscribe)\b/i;
const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "source", "wbr"]);
function dropMarked(html) {
  let out = "", i = 0, skip = null, depth = 0;
  const re = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[2].toLowerCase(), closing = m[1] === "/";
    if (skip) {
      if (tag === skip && !VOID_TAGS.has(tag)) depth += closing ? -1 : (m[0].endsWith("/>") ? 0 : 1);
      if (depth === 0) { skip = null; i = re.lastIndex; }
      continue;
    }
    if (!closing && !VOID_TAGS.has(tag) && !m[0].endsWith("/>") && META_ATTR.test(m[0])) {
      out += html.slice(i, m.index) + " ";
      skip = tag; depth = 1;
      continue;
    }
  }
  return skip ? out : out + html.slice(i);
}

// Lines that are page furniture, not the story.
const DATE_LINE = /^(?:(?:published|updated|posted|last updated)\b.*|\d{1,2}(?:st|nd|rd|th)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d+ (?:minutes?|hours?|days?|weeks?) ago)$/i;
function tidyBlocks(blocks) {
  const out = [];
  let seenTitle = false, storyStarted = false;
  for (const b of blocks) {
    if (b.k === "img") { out.push(b); continue; }
    let t = b.t;
    // Picture credits ("Image source, Getty Images"); captions keep their words.
    if (/^(?:image|picture|photo|media) (?:source|credit)s?\s*[,:]/i.test(t)) continue;
    t = t.replace(/^(?:image|picture|media) caption\s*[,:]\s*/i, "");
    if (!t) continue;
    if (DATE_LINE.test(t.replace(/[|·•]/g, " ").replace(/\s+/g, " ").trim())) continue;
    if (/^[|·•\-–—]+$/.test(t)) continue;
    if (b.k === "h1") seenTitle = true;
    // Between the headline and the first real paragraph: short lines are the
    // byline, the date and the section label ("By …", "2 October 2026", "News").
    if (seenTitle && !storyStarted && b.k !== "h1") {
      const real = (b.k === "p" || b.k === "quote") && (t.length >= 80 || /[.!?…]["'”’)]?$/.test(t));
      if (!real && !/^h[2-4]$/.test(b.k)) {
        if (/^by\s/i.test(t) || t.length < 60) continue;
      }
      if (real) storyStarted = true;
    }
    if (/^by\s.{3,150}$/i.test(t) && !/[.!?]$/.test(t) && !storyStarted) continue;
    out.push(t === b.t ? b : Object.assign({}, b, { t }));
  }
  return out;
}

// The book text: headings and paragraphs on their own lines, list items as "• …".
function blocksToText(blocks) {
  const out = [];
  let prev = "";
  for (const b of blocks) {
    if (b.k === "img") continue;
    const line = b.k === "li" ? "• " + b.t : b.t;
    if (out.length) out.push(b.k === "li" && prev === "li" ? "\n" : "\n\n");
    out.push(line);
    prev = b.k;
  }
  return out.join("").trim();
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
  if (tooMany(request)) return json(429, { code: "rate_limited", message: "Slow down a little — try again in a minute." });

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
  // 401/403/429/451: the site refuses apps (bot protection, rate limits, logins).
  if ([401, 403, 429, 451].includes(res.status)) return json(502, { code: "blocked", message: "That website doesn't allow apps to read it (" + res.status + ")." });
  if (!res.ok) return json(502, { code: "fetch_failed", message: "The page answered with an error (" + res.status + ")." });

  const type = (res.headers.get("content-type") || "").toLowerCase();
  const isHtml = type.includes("html") || type.includes("xml");
  if (!isHtml && !type.startsWith("text/")) {
    return json(415, { code: "not_text", message: "That link isn't a web page (it looks like a " + (type.split(";")[0] || "file") + ")." });
  }
  const raw = await readCapped(res);
  if (raw === null) return json(413, { code: "too_big", message: "That page is too big to read." });

  const blocks = isHtml ? htmlToBlocks(raw, res.url || url.toString()) : null;
  const text = (isHtml ? blocksToText(blocks) : raw.trim()).slice(0, MAX_TEXT_CHARS);
  if (text.replace(/\s+/g, " ").length < 200) {
    return json(422, { code: "no_text", message: "That page has no readable text." });
  }
  const reply = { title: isHtml ? pageTitle(raw, url.hostname) : url.hostname, text, url: url.toString() };
  if (blocks && text.length < MAX_TEXT_CHARS) reply.blocks = blocks;   // cut-off text wouldn't match its blocks
  return json(200, reply);
}

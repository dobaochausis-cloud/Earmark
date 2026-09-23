/* Earmark — website edition.
 *
 * On claude.ai the app gets three abilities from Claude:
 *   db      – saves the library (book list, flashcards, quiz and game scores)
 *   assets  – saves each book's text and original PDF
 *   sample  – asks Claude questions
 *
 * This file gives the app the same three abilities on a normal website:
 *   db + assets live in this browser (IndexedDB), so every student's library
 *   is private to their own device, and nothing is stored on the server.
 *   sample calls this website's own /api/sample, which talks to Claude.
 *
 * It must load before the app's script.
 */
(function () {
  "use strict";

  /* ---------------- browser storage (IndexedDB) ---------------- */
  const DB_NAME = "earmark";
  const DB_VERSION = 1;
  let dbPromise = null;

  function openStore() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const idb = req.result;
          if (!idb.objectStoreNames.contains("docs")) idb.createObjectStore("docs");    // key: "collection/id"
          if (!idb.objectStoreNames.contains("files")) idb.createObjectStore("files");  // key: asset id
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const idb = await openStore();
    return new Promise((resolve, reject) => {
      const t = idb.transaction(store, mode);
      const os = t.objectStore(store);
      let result;
      Promise.resolve(fn(os)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("aborted"));
    });
  }
  const reqValue = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  function snapshotDoc(id, value) {
    return { id, exists: value !== undefined, data: () => clone(value) };
  }

  function docRef(path) {
    const id = path.split("/").pop();
    return {
      id,
      async get() {
        const v = await tx("docs", "readonly", (os) => reqValue(os.get(path)));
        return snapshotDoc(id, v);
      },
      async set(value) { await tx("docs", "readwrite", (os) => { os.put(clone(value), path); }); },
      async update(patch) {
        await tx("docs", "readwrite", async (os) => {
          const cur = (await reqValue(os.get(path))) || {};
          os.put(Object.assign(cur, clone(patch)), path);
        });
      },
      async delete() { await tx("docs", "readwrite", (os) => { os.delete(path); }); },
    };
  }

  function collectionRef(name, order, max) {
    return {
      doc: (id) => docRef(name + "/" + id),
      orderBy: (field, dir) => collectionRef(name, { field, desc: dir === "desc" }, max),
      limit: (n) => collectionRef(name, order, n),
      async add(value) {
        const id = newId();
        await docRef(name + "/" + id).set(value);
        return { id };
      },
      async get() {
        const prefix = name + "/";
        const range = IDBKeyRange.bound(prefix, prefix + "￿");
        const rows = await tx("docs", "readonly", async (os) => {
          const [keys, values] = await Promise.all([reqValue(os.getAllKeys(range)), reqValue(os.getAll(range))]);
          return keys.map((k, i) => ({ id: String(k).slice(prefix.length), value: values[i] }))
            .filter((r) => !r.id.includes("/"));
        });
        if (order) {
          rows.sort((a, b) => {
            const x = a.value ? a.value[order.field] : undefined, y = b.value ? b.value[order.field] : undefined;
            const c = x < y ? -1 : x > y ? 1 : 0;
            return order.desc ? -c : c;
          });
        }
        const picked = max ? rows.slice(0, max) : rows;
        return { docs: picked.map((r) => snapshotDoc(r.id, r.value)), size: picked.length, empty: !picked.length };
      },
    };
  }

  const dbApi = {
    collection: (name) => collectionRef(name),
    doc: (path) => docRef(path),
  };

  const assetsApi = {
    async upload(blob, opts) {
      const id = newId();
      const type = (opts && opts.type) || blob.type || "application/octet-stream";
      const stored = blob instanceof Blob ? blob : new Blob([blob], { type });
      try {
        await tx("files", "readwrite", (os) => { os.put(stored, id); });
      } catch (e) {
        const err = new Error("Not enough storage space in this browser.");
        err.code = e && e.name === "QuotaExceededError" ? "quota_exceeded" : "upload_failed";
        throw err;
      }
      return { id, url: "", sizeBytes: stored.size, contentType: type };
    },
    async delete(id) { await tx("files", "readwrite", (os) => { os.delete(id); }); },
    async list() {
      const keys = await tx("files", "readonly", (os) => reqValue(os.getAllKeys()));
      return { assets: keys.map((id) => ({ id })), usage: null };
    },
  };

  // The app loads a saved book's text / PDF through this.
  window.__earmarkAssetFetch = async (id) => {
    const blob = await tx("files", "readonly", (os) => reqValue(os.get(id)));
    if (!blob) return new Response("", { status: 404 });
    return new Response(blob, { status: 200 });
  };

  // Ask the browser not to clear this site's storage when space runs low.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------------- asking Claude (through /api/sample) ---------------- */
  const MAX_PROMPT_BYTES = 65536;   // must match the server's limit
  const CODE_KEY = "earmark_access_code";

  function fail(code, message, text) {
    const e = new Error(message || code);
    e.code = code;
    if (text) e.text = text;
    return e;
  }

  function readCode() { try { return localStorage.getItem(CODE_KEY) || ""; } catch (e) { return ""; } }
  function saveCode(v) { try { localStorage.setItem(CODE_KEY, v); } catch (e) { /* private window */ } }

  async function callServer(input, opts, asJson) {
    opts = opts || {};
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const body = JSON.stringify({ messages, tier: opts.modelTier || "default", json: !!asJson });
    if (new Blob([body]).size > MAX_PROMPT_BYTES + 4096) throw fail("prompt_too_large", "That request is too large.");

    let res;
    for (let tries = 0; ; tries++) {
      try {
        res = await fetch("/api/sample", {
          method: "POST",
          headers: { "content-type": "application/json", "x-earmark-code": readCode() },
          body,
          signal: opts.signal,
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw fail("cancelled", "Cancelled.");
        throw fail("network", "Couldn't reach the server — check your internet connection.");
      }
      // The site owner can require a class code. Ask once, then remember it.
      if (res.status === 401 && tries < 2) {
        const entered = window.prompt(tries ? "That code didn't work. Enter the class code again:" : "Enter the class code your teacher or friend gave you:");
        if (!entered) throw fail("not_granted", "A class code is needed to use the AI.");
        saveCode(entered.trim());
        continue;
      }
      break;
    }
    if (!res.ok || !res.body) {
      let info = {};
      try { info = await res.json(); } catch (e) { /* not JSON */ }
      const code = info.code || (res.status === 413 ? "prompt_too_large" : res.status === 429 ? "rate_limited" : res.status === 401 ? "not_granted" : "server_error");
      throw fail(code, info.message || "The AI isn't available right now.");
    }

    // The server streams one JSON object per line: {"d": "..."} for new text,
    // then {"done": true, ...} or {"error": {...}}.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", text = "", finished = null;
    const handle = (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.d) {
        text += msg.d;
        if (opts.onText) { try { opts.onText({ text, delta: msg.d }); } catch (e) { /* page callback */ } }
      } else if (msg.done || msg.error) {
        finished = msg;
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
      handle(buf);
    } catch (e) {
      if (e && e.name === "AbortError") throw fail("cancelled", "Cancelled.", text);
      throw fail("network", "The connection dropped.", text);
    }
    if (!finished) throw fail("network", "The connection dropped.", text);
    if (finished.error) throw fail(finished.error.code || "server_error", finished.error.message, text);
    if (finished.stop === "refusal") throw fail("refused", "Claude couldn't answer that one.", text);
    return { text, truncated: finished.stop === "max_tokens" };
  }

  function parseJsonLoose(text) {
    let t = String(text || "").trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch (e) { /* try the outermost [...] or {...} */ }
    const starts = [t.indexOf("["), t.indexOf("{")].filter((i) => i >= 0);
    if (starts.length) {
      const start = Math.min(...starts);
      const end = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
      if (end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* fall through */ } }
    }
    throw fail("invalid_json", "Claude's reply wasn't in the expected format.", text);
  }

  const sampleApi = async function sample(input, opts) { return callServer(input, opts, false); };
  sampleApi.json = async function (input, opts) {
    const r = await callServer(input, opts, true);
    return parseJsonLoose(r.text);
  };
  sampleApi.limits = async () => ({ maxPromptBytes: MAX_PROMPT_BYTES, images: false });

  /* ---------------- the same entry point the app uses on claude.ai ---------------- */
  const namespaces = { db: dbApi, assets: assetsApi, sample: sampleApi };
  window.claude = {
    use: async (name) => {
      if (name === "db" || name === "assets") {
        try { await openStore(); } catch (e) { return null; }   // storage blocked (e.g. some private windows)
      }
      return namespaces[name] || null;
    },
  };
})();

/* Earmark Buddy — service worker.
 * 1. Lets phones install the site as an app.
 * 2. Receives files and links from the phone's Share menu ("share_target" in
 *    manifest.webmanifest): the shared file is kept for a moment, then the app
 *    opens and adds it as a book.
 * Everything else goes straight to the network as usual.
 */
const SHARE_CACHE = "earmark-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(receiveShare(event.request));
  }
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (file && typeof file === "object" && file.size) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put("/shared-file", new Response(file, {
        headers: { "content-type": file.type || "application/octet-stream", "x-name": encodeURIComponent(file.name || "Shared file") },
      }));
      return Response.redirect("/?shared=file", 303);
    }
    const text = [form.get("url"), form.get("text"), form.get("title")].filter(Boolean).join(" ");
    const link = (String(text).match(/https?:\/\/\S+/) || [])[0];
    if (link) return Response.redirect("/?shared=" + encodeURIComponent(link), 303);
  } catch (e) { /* fall through */ }
  return Response.redirect("/", 303);
}

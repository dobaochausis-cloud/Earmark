// Builds public/index.html from the app file (earmark.html, the same file
// that runs on claude.ai), adding a normal page head and platform.js.
import { readFileSync, writeFileSync } from "node:fs";

// The site's public address (used for search engines). Change it if you
// connect your own domain.
const SITE = process.env.SITE_URL || "https://earmark-4wf.pages.dev";
const app = readFileSync(new URL("./earmark.html", import.meta.url), "utf8");
const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Earmark Learning is a free study app: upload any book, PDF or web page, ask questions answered from the text, have it read aloud in a natural voice, translate it, and learn with flashcards, quizzes and games.">
<link rel="canonical" href="\${SITE}/">
<meta name="robots" content="index,follow">
<meta name="google-site-verification" content="fQiBduHC-Ci-yuCdESMy9poMLhiOSOp9_uSRGNDnLz0">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Earmark Learning">
<meta property="og:title" content="Earmark Learning — read, ask and listen to any book">
<meta property="og:description" content="Upload any book or PDF, ask questions, listen to it read aloud, and study with flashcards, quizzes and games.">
<meta property="og:url" content="\${SITE}/">
<meta name="twitter:card" content="summary_large_image">
<meta property="og:image" content="\${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#3274B0">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Earmark Learning","alternateName":["Earmark","Earmark Learning site"],"url":"${SITE}/"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebApplication","name":"Earmark Learning","alternateName":["Earmark","Earmark study app"],"url":"\${SITE}/","image":"\${SITE}/icon-512.png","applicationCategory":"EducationalApplication","operatingSystem":"Any (web browser)","description":"Upload any book, PDF or web page, ask questions answered from the text, listen to it read aloud, translate it, and study with flashcards, quizzes and games.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"}}</script>
<style>[hidden]:not([hidden=until-found i]){display:none!important}body{margin:0}</style>
<script src="platform.js"></script>
`;
// The app file starts with its <title>, fonts and styles, then the body markup.
const bodyStart = app.indexOf('<div class="scrim"');
if (bodyStart < 0) throw new Error("couldn't find where the page body starts");
const page = head + app.slice(0, bodyStart).replace(/<title>[^<]*<\/title>/, "<title>Earmark Learning — read, ask and listen to any book</title>") + "</head>\n<body>\n" + app.slice(bodyStart) + "\n</body>\n</html>\n";
writeFileSync(new URL("./public/index.html", import.meta.url), page);
// Lets phones add Earmark to the home screen with its logo.
writeFileSync(new URL("./public/manifest.webmanifest", import.meta.url), JSON.stringify({
  name: "Earmark Learning", short_name: "Earmark", start_url: "/", display: "standalone",
  background_color: "#ffffff", theme_color: "#3274B0",
  icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
}, null, 2) + "\n");
// Help search engines find the site.
writeFileSync(new URL("./public/robots.txt", import.meta.url), "User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: " + SITE + "/sitemap.xml\n");
writeFileSync(new URL("./public/sitemap.xml", import.meta.url),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + SITE + '/</loc><lastmod>' + new Date().toISOString().slice(0, 10) + '</lastmod></url>\n</urlset>\n');
console.log("public/index.html written");

// Builds public/index.html from the app file (earmark.html, the same file
// that runs on claude.ai), adding a normal page head and platform.js.
import { readFileSync, writeFileSync } from "node:fs";

const app = readFileSync(new URL("./earmark.html", import.meta.url), "utf8");
const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Earmark: upload any book, ask questions answered from the text, and have it read aloud.">
<style>[hidden]:not([hidden=until-found i]){display:none!important}body{margin:0}</style>
<script src="platform.js"></script>
`;
// The app file starts with its <title>, fonts and styles, then the body markup.
const bodyStart = app.indexOf('<div class="scrim"');
if (bodyStart < 0) throw new Error("couldn't find where the page body starts");
const page = head + app.slice(0, bodyStart) + "</head>\n<body>\n" + app.slice(bodyStart) + "\n</body>\n</html>\n";
writeFileSync(new URL("./public/index.html", import.meta.url), page);
console.log("public/index.html written");

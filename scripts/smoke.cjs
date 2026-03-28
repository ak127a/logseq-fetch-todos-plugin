const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();

const htmlPath = path.join(root, "index.html");
const jsPath = path.join(root, "index.js");

if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) {
  throw new Error("Smoke check requires built index.html and index.js files.");
}

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");

if (!html.includes("<script src=\"index.js\"></script>")) {
  throw new Error("index.html does not reference index.js.");
}

if (!js.includes("logseq.ready")) {
  throw new Error("index.js does not contain plugin bootstrap call.");
}

console.log("Smoke checks passed.");

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const requiredFiles = ["index.html", "index.js", "package.json"];

for (const file of requiredFiles) {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required packaging file: ${file}`);
  }
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

if (!pkg.name || typeof pkg.name !== "string") {
  throw new Error("package.json must define a string 'name'.");
}

if (!pkg.version || typeof pkg.version !== "string") {
  throw new Error("package.json must define a string 'version'.");
}

if (!pkg.logseq || typeof pkg.logseq.id !== "string") {
  throw new Error("package.json must define logseq.id for plugin packaging.");
}

console.log("Package validation passed.");

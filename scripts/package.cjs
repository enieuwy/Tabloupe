#!/usr/bin/env node
// Local packaging only: no credentials, signing, version bump, or publication.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = [
  "background.js", "calendar.js", "calendar-runtime.js", "calendar-options.js", "native-runtime.js",
  "options.html", "options.js", "options.css", "popup.html", "popup.js", "popup.css",
  "onboarding.html", "onboarding.js", "onboarding.css", "tabsearch.html", "tabsearch.js", "icons", "vendor", "LICENSE",
];
async function main() {
  const target = process.argv[2] || "firefox";
  if (target !== "firefox") throw new Error("Expected firefox.");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  const destination = path.join(root, "dist", "firefox");
  // Recreate only generated output so removed source files cannot survive packaging.
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const file of files) await fs.cp(path.join(root, file), path.join(destination, file), { recursive: true });
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const archive = path.join(root, "dist", `tabloupe-firefox-${manifest.version}.zip`);
  await fs.rm(archive, { force: true });
  execFileSync("zip", ["-q", "-r", archive, "."], { cwd: destination });
  console.log(`firefox: ${destination}\narchive: ${archive}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

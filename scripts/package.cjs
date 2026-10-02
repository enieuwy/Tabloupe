#!/usr/bin/env node
// Local packaging only: no credentials, signing, version bump, or publication.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = [
  "background.js", "browser-compat.js", "calendar.js", "calendar-runtime.js", "calendar-options.js", "native-runtime.js",
  "service-worker.js", "options.html", "options.js", "options.css", "popup.html", "popup.js", "popup.css",
  "onboarding.html", "onboarding.js", "onboarding.css", "tabsearch.html", "tabsearch.js", "icons", "vendor", "LICENSE",
];
async function main() {
  const target = process.argv[2] || "both";
  if (!["both", "firefox", "chromium"].includes(target)) throw new Error("Expected firefox, chromium, or both.");
  const firefox = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  for (const browser of target === "both" ? ["firefox", "chromium"] : [target]) {
    const destination = path.join(root, "dist", browser);
    await fs.mkdir(destination, { recursive: true });
    for (const file of files) await fs.cp(path.join(root, file), path.join(destination, file), { recursive: true });
    const manifest = browser === "firefox" ? firefox : JSON.parse(await fs.readFile(path.join(root, "manifest.mv3.json"), "utf8"));
    manifest.version = firefox.version;
    await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const archive = path.join(root, "dist", `tabloupe-${browser}-${manifest.version}.zip`);
    // Delete only the generated archive so removed files cannot survive zip updates.
    await fs.rm(archive, { force: true });
    execFileSync("zip", ["-q", "-r", archive, "."], { cwd: destination });
    console.log(`${browser}: ${destination}\narchive: ${archive}`);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

// Prepare an isolated browser fixture. Production JavaScript remains byte-identical.
// Required fixture permissions avoid granting permissions in any live browser profile.
const fs = require("node:fs/promises");
const path = require("node:path");
(async () => {
  const target = process.argv[2] || "chromium";
  if (!["chromium", "firefox"].includes(target)) throw new Error("Choose chromium or firefox.");
  const root = path.resolve(__dirname, "..");
  const destination = path.join(__dirname, `fixture-${target}`);
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(path.join(root, "dist", target), destination, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
  const permissions = ["bookmarks", "sessions", "contextMenus"];
  manifest.permissions = [...new Set([...manifest.permissions, ...permissions])];
  manifest.optional_permissions = manifest.optional_permissions.filter((permission) => !permissions.includes(permission));
  if (target === "firefox") manifest.permissions.push("http://127.0.0.1/*");
  else manifest.host_permissions.push("http://127.0.0.1/*");
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Fixture ${destination}; only the manifest grants fixture-only permissions at install.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

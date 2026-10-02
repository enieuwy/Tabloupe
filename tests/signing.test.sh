#!/bin/bash
set -euo pipefail

# Offline smoke: run copied scripts with a stub signer and a synthetic profile.
# No real credentials, Firefox data, dependency installs, or AMO calls are used.
python3 - "$(cd "$(dirname "$0")/.." && pwd)" <<'PY'
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SOURCE = Path(sys.argv.pop())


class SigningSmoke(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tabloupe-signing-smoke-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        for name in ("build.sh", "deploy.sh"):
            shutil.copy2(SOURCE / name, self.repo / name)
        self.manifest = self.repo / "manifest.json"
        self.original = '{"version":"1.0.0"}\n'
        self.manifest.write_text(self.original)
        (self.repo / ".env").write_text(
            "WEB_EXT_API_KEY=offline-test\nWEB_EXT_API_SECRET=offline-test\n"
        )
        self.artifacts = self.repo / "web-ext-artifacts"
        self.artifacts.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.stub("node", "#!/bin/bash\nexit 0\n")
        self.stub("npx", '''#!/bin/bash
set -euo pipefail
case "$*" in
  "--no-install web-ext --version"|"--no-install web-ext lint") exit 0 ;;
  "--no-install web-ext sign --channel=listed"|"--no-install web-ext sign --channel=unlisted") ;;
  *) echo "Unexpected npx call: $*" >&2; exit 90 ;;
esac
case "${SMOKE_SIGN_MODE:-matching}" in
  rejected) exit 1 ;;
  pending) exit 0 ;;
  matching|wrong)
    python3 - <<'SIGN'
import json
import os
import zipfile
from pathlib import Path
version = json.loads(Path("manifest.json").read_text())["version"]
if os.environ.get("SMOKE_SIGN_MODE") == "wrong":
    version = "0.1.0"
with zipfile.ZipFile(f"web-ext-artifacts/stub-{version}.xpi", "w") as archive:
    archive.writestr("manifest.json", json.dumps({"version": version}))
SIGN
    ;;
  *) exit 91 ;;
esac
''')
        self.home = self.root / "home"
        firefox = self.home / "Library/Application Support/Firefox"
        profile = firefox / "Profiles/offline.default"
        (profile / "sessionstore-backups").mkdir(parents=True)
        (firefox / "profiles.ini").write_text(
            "[Profile0]\nName=offline\nIsRelative=1\n"
            "Path=Profiles/offline.default\nDefault=1\n"
        )
        venv_python = self.home / ".local/state/tabloupe/lz4-venv/bin/python3"
        venv_python.parent.mkdir(parents=True)
        venv_python.write_text("#!/bin/bash\nexit 0\n")
        venv_python.chmod(0o755)
        self.backups = self.home / ".local/state/tabloupe/session-backups"
        self.env = dict(os.environ, HOME=str(self.home),
                        PATH=f"{self.bin}:{os.environ['PATH']}")

    def stub(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_script(self, script, *args, sign_mode="matching"):
        env = dict(self.env, SMOKE_SIGN_MODE=sign_mode)
        return subprocess.run(["bash", str(self.repo / script), *args],
                              cwd=self.repo, env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=30)

    def version(self):
        return json.loads(self.manifest.read_text())["version"]

    def xpi(self, name, version, mtime):
        path = self.artifacts / name
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"version": version}))
        os.utime(path, (mtime, mtime))
        return path

    def test_pending_submission_reserves_each_version_and_blocks_stale_deploy(self):
        self.xpi("older.xpi", "1.0.0", 100)
        for version in ("1.0.1", "1.0.2"):
            result = self.run_script("build.sh", "listed", sign_mode="pending")
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertEqual(self.version(), version)
            self.assertIn(f"Submission accepted for version {version}; signing is pending.", result.stdout)
            self.assertNotIn("Done! Install", result.stdout)
            self.assertFalse((self.repo / ".build.lock").exists())
        result = self.run_script("deploy.sh", "--skip-build", "--dry-run")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("No .xpi with embedded version 1.0.2", result.stdout)
        self.assertNotIn("Deploy summary", result.stdout)
        self.assertFalse(self.backups.exists(), "Rejected artifact must not snapshot Firefox")

    def test_rejected_submission_restores_manifest(self):
        result = self.run_script("build.sh", sign_mode="rejected")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.manifest.read_text(), self.original)
        self.assertFalse((self.repo / ".build.lock").exists())

    def test_unlisted_wrong_artifact_fails_without_reusing_accepted_version(self):
        result = self.run_script("build.sh", sign_mode="wrong")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.1")
        self.assertIn("no matching .xpi", result.stdout)
        self.assertNotIn("Done! Install", result.stdout)

    def test_retention_keeps_matching_artifact_despite_newer_old_versions(self):
        for index in range(6):
            self.xpi(f"old-{index}.xpi", "1.0.0", 4102444800 + index)
        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stdout)
        matching = self.artifacts / "stub-1.0.1.xpi"
        with zipfile.ZipFile(matching) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["version"], "1.0.1")

    def test_matching_signed_artifact_and_deploy_share_version(self):
        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("Install version 1.0.1 from web-ext-artifacts/stub-1.0.1.xpi", result.stdout)
        result = self.run_script("deploy.sh", "--skip-build", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("Version: 1.0.1", result.stdout)
        self.assertIn("stub-1.0.1.xpi", result.stdout)
        self.assertTrue(self.backups.exists())

    def test_deploy_selects_embedded_match_instead_of_newer_wrong_or_corrupt_artifacts(self):
        matching = self.xpi("matching.xpi", "1.0.0", 100)
        self.xpi("newer-wrong.xpi", "9.9.9", 200)
        corrupt = self.artifacts / "newest-corrupt.xpi"
        corrupt.write_text("not a ZIP archive")
        os.utime(corrupt, (300, 300))
        result = self.run_script("deploy.sh", "--skip-build")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn(str(matching), result.stdout)
        self.assertNotIn("newer-wrong.xpi", result.stdout)
        self.assertNotIn("newest-corrupt.xpi", result.stdout)
        self.assertIn("Version: 1.0.0", result.stdout)
        self.assertIn("Install Add-on From File", result.stdout)

    def test_unlisted_pending_deploy_stops_before_snapshot(self):
        self.xpi("older.xpi", "1.0.0", 100)
        result = self.run_script("deploy.sh", "--dry-run", sign_mode="pending")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.1")
        self.assertFalse(self.backups.exists())
        self.assertNotIn("Deploy summary", result.stdout)


unittest.main(verbosity=2)
PY

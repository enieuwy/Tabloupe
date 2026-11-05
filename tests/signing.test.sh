#!/bin/bash
set -euo pipefail

# Offline smoke: run copied scripts with a stub signer and a synthetic profile.
# No real credentials, Firefox data, dependency installs, or AMO calls are used.
python3 - "$(cd "$(dirname "$0")/.." && pwd)" <<'PY'
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
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
        # `node scripts/package.cjs firefox` is the local unsigned packaging path
        # a dry run uses; the stub produces the archive deploy.sh looks for.
        self.stub("node", '''#!/bin/bash
set -euo pipefail
if [[ "$*" == "scripts/package.cjs firefox" ]]; then
  python3 - <<'PKG'
import json
import zipfile
from pathlib import Path
version = json.loads(Path("manifest.json").read_text())["version"]
Path("dist").mkdir(exist_ok=True)
with zipfile.ZipFile(f"dist/tabloupe-firefox-{version}.zip", "w") as archive:
    archive.writestr("manifest.json", json.dumps({"version": version}))
PKG
fi
exit 0
''')
        # Stands in for python3 only to simulate a SIGKILL landing in the middle
        # of the bump -> sign transaction, or a build frozen just before it
        # publishes its lock; every other call runs real python3.
        self.stub("python3", f'''#!/bin/bash
if [[ "$*" == "-" && -n "${{SMOKE_KILL_AFTER_BUMP:-}}" ]]; then
  # Let the real bump land, then take out the whole build process group the way
  # SIGKILL/OOM would: no EXIT trap, no lock release, no state advance.
  {sys.executable} "$@" >/dev/null
  kill -KILL 0
  exit 0
fi
if [[ "${{1:-}}" == "-" && "${{3:-}}" == ".build.lock" && -n "${{SMOKE_PAUSE_PUBLISH:-}}" ]]; then
  # Freeze the build the way Ctrl-Z, SIGSTOP, or a starved scheduler can, and
  # name the process the test must resume.
  printf '%s\\n' "$$" >"$SMOKE_PAUSE_PUBLISH"
  kill -STOP $$
fi
exec {sys.executable} "$@"
''')
        self.stub("npx", '''#!/bin/bash
set -euo pipefail
case "$*" in
  "--no-install web-ext --version"|"--no-install web-ext lint") exit 0 ;;
  "--no-install web-ext sign --channel=listed"|"--no-install web-ext sign --channel=unlisted") ;;
  *) echo "Unexpected npx call: $*" >&2; exit 90 ;;
esac
case "${SMOKE_SIGN_MODE:-matching}" in
  forbidden) echo "Signer must not run in this mode" >&2; exit 92 ;;
  killed) kill -KILL 0; exit 0 ;;
  slow) sleep 10; exit 0 ;;
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

    def run_command(self, argv, sign_mode="matching", **extra_env):
        env = dict(self.env, SMOKE_SIGN_MODE=sign_mode, **extra_env)
        # Own process group: the stubs simulate SIGKILL with `kill -KILL 0`, and
        # that must reach the script under test, not this test runner.
        return subprocess.run(argv, cwd=self.repo, env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=60, start_new_session=True)

    def run_script(self, script, *args, sign_mode="matching", **extra_env):
        return self.run_command(["bash", str(self.repo / script), *args],
                                sign_mode, **extra_env)

    def spawn_script(self, script, *args, sign_mode="matching", **extra_env):
        env = dict(self.env, SMOKE_SIGN_MODE=sign_mode, **extra_env)
        process = subprocess.Popen(["bash", str(self.repo / script), *args],
                                   cwd=self.repo, env=env, text=True,
                                   stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT,
                                   start_new_session=True)
        self.addCleanup(self.terminate, process)
        return process

    def terminate(self, process):
        if process.poll() is None:
            os.killpg(os.getpgid(process.pid), 9)
        process.wait(timeout=30)
        if process.stdout is not None:
            process.stdout.close()

    def wait_for(self, predicate, what, timeout=20.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail(f"Timed out waiting for {what}")

    def lock_state(self):
        state = self.repo / ".build.lock" / "state"
        return state.read_text().strip() if state.exists() else ""

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
        result = self.run_script("deploy.sh", sign_mode="pending")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.1")
        self.assertFalse(self.backups.exists())
        self.assertNotIn("Next steps", result.stdout)

    def test_dry_run_packages_locally_without_bumping_or_submitting(self):
        # sign_mode="forbidden" makes the stub signer fail loudly, so reaching
        # AMO at all would fail this test rather than pass it quietly.
        result = self.run_script("deploy.sh", "--dry-run", sign_mode="forbidden")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.0", "a dry run must not consume a version")
        self.assertTrue((self.repo / "dist/tabloupe-firefox-1.0.0.zip").is_file(), result.stdout)
        self.assertEqual(list(self.artifacts.iterdir()), [], "a dry run must not sign an XPI")
        self.assertNotIn("Install Add-on From File", result.stdout)
        self.assertTrue(self.backups.exists(), "a dry run still snapshots the session")

    def test_killed_build_before_submission_rolls_the_manifest_back(self):
        killed = self.run_script("build.sh", SMOKE_KILL_AFTER_BUMP="1")
        self.assertNotEqual(killed.returncode, 0, killed.stdout)
        # SIGKILL skips the EXIT trap: the lock and the bumped manifest survive.
        self.assertTrue((self.repo / ".build.lock").is_dir())
        self.assertEqual(self.version(), "1.0.1")
        self.assertEqual(self.lock_state(), "bumping")

        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stdout)
        # Recovered to the pre-bump version, then bumped once from there.
        self.assertEqual(self.version(), "1.0.1")
        self.assertIn("Install version 1.0.1 from web-ext-artifacts/stub-1.0.1.xpi", result.stdout)
        self.assertFalse((self.repo / ".build.lock").exists())

    def test_killed_build_during_submission_keeps_the_submitted_version(self):
        killed = self.run_script("build.sh", sign_mode="killed")
        self.assertNotEqual(killed.returncode, 0, killed.stdout)
        self.assertTrue((self.repo / ".build.lock").is_dir())
        self.assertEqual(self.version(), "1.0.1")
        self.assertEqual(self.lock_state(), "signing")

        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stdout)
        # 1.0.1 may already be reserved at AMO, so it is never handed out twice.
        self.assertEqual(self.version(), "1.0.2")
        self.assertIn("Install version 1.0.2 from web-ext-artifacts/stub-1.0.2.xpi", result.stdout)
        self.assertFalse((self.repo / ".build.lock").exists())

    def test_live_build_still_blocks_a_second_build(self):
        running = self.spawn_script("build.sh", sign_mode="slow")
        self.wait_for(lambda: self.lock_state() == "signing", "the first build to start signing")

        result = self.run_script("build.sh")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        # The refused build leaves the running build's lock and record alone.
        self.assertEqual((self.repo / ".build.lock/pid").read_text().strip(), str(running.pid))
        self.assertEqual(self.lock_state(), "signing")
        self.assertEqual(self.version(), "1.0.1", "the blocked build must not bump again")

        self.terminate(running)

    def test_a_torn_manifest_snapshot_is_not_restored(self):
        killed = self.run_script("build.sh", SMOKE_KILL_AFTER_BUMP="1")
        self.assertNotEqual(killed.returncode, 0, killed.stdout)
        (self.repo / ".build.lock/manifest.json.orig").write_text('{"versi')

        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.2")
        self.assertFalse((self.repo / ".build.lock").exists())

    def stale_lock(self, *, pid=None, state=None):
        lock = self.repo / ".build.lock"
        lock.mkdir()
        (lock / "manifest.json.orig").write_text(self.original)
        if pid is not None:
            (lock / "pid").write_text(f"{pid}\n")
        if state is not None:
            (lock / "state").write_text(f"{state}\n")
        self.manifest.write_text('{"version":"1.0.1"}\n')
        return lock

    def stopped(self, pid_file):
        pid = pid_file.read_text().strip() if pid_file.exists() else ""
        if not pid:
            return False
        state = subprocess.run(["ps", "-p", pid, "-o", "stat="], text=True,
                               stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL).stdout.strip()
        return state.startswith("T")

    def test_a_lock_without_an_owner_is_never_recovered(self):
        # Only a build.sh that predates PID records leaves an ownerless lock, and
        # no age proves its build is gone: it may be paused or starved.
        lock = self.repo / ".build.lock"
        for age in (0, 3600):
            with self.subTest(age=age):
                lock.mkdir()
                stamp = time.time() - age
                os.utime(lock, (stamp, stamp))
                result = self.run_script("build.sh")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertTrue(lock.is_dir())
                self.assertEqual(self.manifest.read_text(), self.original)
                self.assertEqual(list(self.artifacts.iterdir()), [])
                # The remedy the refusal names, once no build is running.
                lock.rmdir()
        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.1")

    def test_a_build_paused_while_claiming_never_shares_the_lock(self):
        paused_pid = self.root / "paused-claim.pid"
        paused = self.spawn_script("build.sh", SMOKE_PAUSE_PUBLISH=str(paused_pid))
        self.wait_for(lambda: self.stopped(paused_pid), "the first build to freeze mid-claim")
        self.assertFalse((self.repo / ".build.lock").exists())

        running = self.spawn_script("build.sh", sign_mode="slow")
        self.wait_for(lambda: self.lock_state() == "signing", "the second build to start signing")
        os.kill(int(paused_pid.read_text()), signal.SIGCONT)
        paused.wait(timeout=30)

        self.assertNotEqual(paused.returncode, 0, paused.stdout.read())
        self.assertEqual((self.repo / ".build.lock/pid").read_text().strip(), str(running.pid))
        self.assertEqual(self.lock_state(), "signing")
        self.assertEqual(self.version(), "1.0.1", "the resumed build must not bump again")
        self.assertEqual(list(self.repo.glob(".build.lock.*")), [],
                         "the resumed build must drop its claim staging")

        self.terminate(running)

    def test_a_recycled_owner_pid_does_not_keep_the_lock(self):
        # The dead build's PID now belongs to a live process that is not a build.
        self.stale_lock(pid=os.getpid(), state="bumping")
        stray = self.repo / "manifest.json.4242.part"
        stray.write_text('{"versi')
        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.1")
        self.assertFalse(stray.exists(), "a staging leftover must not reach the signed package")
        self.assertFalse((self.repo / ".build.lock").exists())

    def test_a_lock_naming_the_new_builds_own_pid_is_recovered(self):
        # The new build reuses the dead build's PID, as a container's fresh PID
        # namespace does on every run.
        self.stale_lock(state="bumping")
        result = self.run_command(
            ["bash", "-c", 'printf "%s\\n" "$$" >.build.lock/pid && exec bash ./build.sh'])
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.version(), "1.0.1")
        self.assertFalse((self.repo / ".build.lock").exists())


unittest.main(verbosity=2)
PY

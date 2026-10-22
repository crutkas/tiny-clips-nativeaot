import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


LAUNCHER = Path(__file__).resolve().parents[2] / "scripts" / "run-macos.sh"
MOCKS = """
probe_count=0
pgrep() {
    [ "$*" = "-u $(id -u) -x TinyClips" ] || return 99
    probe_count=$((probe_count + 1))
    if [ "$probe_count" -eq 1 ]; then
        return "$FIRST_PROBE"
    fi
    return "$SECOND_PROBE"
}
xcodebuild() {
    echo BUILD
    return "$BUILD_STATUS"
}
open() {
    echo OPEN
    return "$OPEN_STATUS"
}
"""


class RunMacOSTests(unittest.TestCase):
    def run_launcher(self, first=1, second=1, build=0, launch=0):
        shell = shutil.which("bash")
        self.assertIsNotNone(shell, "A POSIX shell is required for launcher tests.")
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "scripts" / "run-macos.sh"
            script.parent.mkdir()
            script.write_text(MOCKS + LAUNCHER.read_text(), encoding="utf-8")
            environment = dict(
                os.environ,
                FIRST_PROBE=str(first),
                SECOND_PROBE=str(second),
                BUILD_STATUS=str(build),
                OPEN_STATUS=str(launch),
            )
            return subprocess.run(
                [shell, script.as_posix()],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

    def test_builds_and_opens_when_stopped(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["BUILD", "OPEN"])

    def test_running_app_blocks_build(self):
        result = self.run_launcher(first=0)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("save your work", result.stderr)

    def test_app_started_during_build_blocks_launch(self):
        result = self.run_launcher(second=0)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines(), ["BUILD"])
        self.assertIn("already running", result.stderr)

    def test_probe_errors_are_not_treated_as_stopped(self):
        for first, second, output in ((2, 1, ""), (1, 3, "BUILD\n")):
            with self.subTest(first=first, second=second):
                result = self.run_launcher(first=first, second=second)
                self.assertEqual(result.returncode, max(first, second))
                self.assertEqual(result.stdout, output)
                self.assertIn("Could not check", result.stderr)

    def test_build_failure_blocks_launch(self):
        result = self.run_launcher(build=5)
        self.assertEqual(result.returncode, 5)
        self.assertEqual(result.stdout.splitlines(), ["BUILD"])

    def test_launch_failure_is_propagated(self):
        result = self.run_launcher(launch=6)
        self.assertEqual(result.returncode, 6)
        self.assertEqual(result.stdout.splitlines(), ["BUILD", "OPEN"])


if __name__ == "__main__":
    unittest.main()

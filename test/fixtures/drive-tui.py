"""Offline end-to-end check of Goal mode in the real pi TUI (development aid).

Drives pi in a pty with the scripted offline provider (test/fixtures/offline-provider.ts
following test/fixtures/tui-script.json) and renders the screen with pyte:

  /goal execute prompt.md -> progress note + a long bash -> Esc -> "paused (interrupted)"
  -> "continue" -> goal_resume, goal_progress, goal_wait on a check command
  -> the check starts succeeding -> the goal wakes -> goal_complete with deviations.

Usage: python3 test/fixtures/drive-tui.py [output-dir]   (needs `pip install pyte`)
Screens land in <output-dir>/screens, provider requests in <output-dir>/record,
and the session in <output-dir>/agent/sessions. Uses a fresh agent directory, so
none of the user's installed packages load.
"""
import os, pty, select, time, sys, shutil, pathlib, tempfile
import pyte

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="pi-goal-tui-"))
FIXTURES = pathlib.Path(__file__).resolve().parent
REPO = str(FIXTURES.parent.parent)
AGENT, WORK, RECORD, SCREENS = ROOT/"agent", ROOT/"work", ROOT/"record", ROOT/"screens"
for d in (AGENT, WORK, RECORD, SCREENS):
    shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
(AGENT/"settings.json").write_text('{"lastChangelogVersion":"0.87.1","theme":"dark"}\n')
(WORK/"prompt.md").write_text("# Widget\n\nBuild the widget, wait until build.flag exists, then finish.\n")
COLS, ROWS = 140, 45
screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
env = dict(os.environ, PI_CODING_AGENT_DIR=str(AGENT), OFFLINE_RECORD_DIR=str(RECORD),
           OFFLINE_SCRIPT=str(FIXTURES/"tui-script.json"), TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.execvpe("pi", ["pi", "-e", f"{REPO}/src/index.ts", "-e", f"{REPO}/test/fixtures/offline-provider.ts", "--model", "offline/echo"], env)
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

def pump(seconds=0.2):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return
            stream.feed(data)

def text(): return "\n".join(line.rstrip() for line in screen.display)

def wait_for(needle, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.2)
        if needle in text(): return True
    raise SystemExit(f"TIMEOUT waiting for {needle!r}\n----\n{text()}")

step_no = 0
def snap(name):
    global step_no
    step_no += 1
    (SCREENS/f"{step_no:02d}-{name}.txt").write_text(text() + "\n")
    print(f"--- {step_no:02d} {name}"); print(text()); sys.stdout.flush()

def type_line(s):
    for ch in s:
        os.write(fd, ch.encode()); pump(0.01)
    pump(0.3); os.write(fd, b"\r")

pump(3); snap("started")
type_line("/goal execute prompt.md")
wait_for("sleep 60", 30); pump(1.5); snap("bash-running")
os.write(fd, b"\x1b"); wait_for("paused (interrupted)", 20); pump(1); snap("after-esc")
type_line("continue")
wait_for("waiting", 30); pump(1); snap("waiting")
(WORK/"build.flag").write_text("done\n")
wait_for("Goal complete", 90); pump(2); snap("complete")
os.write(fd, b"\x03"); pump(0.5); os.write(fd, b"\x03"); pump(1)
try: os.kill(pid, 9)
except Exception: pass
print(f"DRIVER OK: {ROOT}")

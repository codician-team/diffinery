/**
 * The terminal's pseudo-terminal, as a small Python program (standard library only, so the image
 * needs no native Node module). It forks a login shell on a PTY, copies its stdin to the PTY and the
 * PTY to its stdout, and reads control lines (JSON) on fd 3: `{"cols": 120, "rows": 40}` resizes.
 * It exits with the shell.
 */
export const PTY_HELPER = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios

def winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid, fd = pty.fork()
if pid == 0:
    shell = os.environ.get("SHELL") or "/bin/bash"
    os.execvp(shell, [shell, "-l"])

winsize(fd, int(os.environ.get("DIFFINERY_PTY_ROWS", "24")), int(os.environ.get("DIFFINERY_PTY_COLS", "80")))
stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
pending = b""
watch = [fd, stdin, 3]
while True:
    try:
        ready, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        os.write(stdout, data)
    if stdin in ready:
        data = os.read(stdin, 65536)
        if not data:
            watch.remove(stdin)
        else:
            os.write(fd, data)
    if 3 in ready:
        data = os.read(3, 4096)
        if not data:
            watch.remove(3)
            continue
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                m = json.loads(line)
                rows, cols = int(m["rows"]), int(m["cols"])
                if 1 <= rows <= 1000 and 1 <= cols <= 1000:
                    winsize(fd, rows, cols)
            except Exception:
                pass
try:
    os.kill(pid, signal.SIGHUP)
except OSError:
    pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
`;

// Ports for the servers end-to-end tests start (`wrangler dev` and its inspector, the sandbox pool, ...).
//
// Asking the kernel for a free port (listen on 0, close, hand the number on) races: until the server
// binds it, the port is free again, and anything that binds port 0 meanwhile can be given the same
// number: workerd's own sockets in another `wrangler dev` or `wrangler d1 execute`, a docs server, an
// outgoing connection. Then wrangler dies with "bind(): Address already in use". So ports here come
// from below the kernel's ephemeral range, which port 0 binds and outgoing connections never use, and
// each is reserved with a lock file naming this process, so test files running side by side
// (--test-concurrency) never pick the same one. A process keeps its ports until it exits; a lock left
// by a process that's gone is taken over.
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCKS = join(tmpdir(), "diffinery-e2e-ports");
const [FIRST, LAST] = range();
const held = new Set();
let next = FIRST + Math.floor(Math.random() * (LAST - FIRST + 1));

process.on("exit", () => {
  for (const port of held) {
    try {
      unlinkSync(join(LOCKS, String(port)));
    } catch {}
  }
});

/** A port on 127.0.0.1 that's free now and that no other caller, in this process or another, will be given. */
export async function freePort() {
  mkdirSync(LOCKS, { recursive: true });
  for (let tried = 0; tried <= LAST - FIRST; tried++) {
    const port = next;
    next = next === LAST ? FIRST : next + 1;
    if (held.has(port) || !reserve(port)) continue;
    if (await bindable(port)) {
      held.add(port);
      return port;
    }
    // Something outside the tests is listening there; leave the port to it.
    unlinkSync(join(LOCKS, String(port)));
  }
  throw new Error(`no free port left in ${FIRST}-${LAST}`);
}

/** Ports from 20000 up to the kernel's ephemeral range (32768 to 60999 on Linux by default; macOS's starts at 49152). */
function range() {
  let [low, high] = [32768, 60999];
  try {
    [low, high] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
  } catch {}
  if (low >= 21000) return [20000, low - 1];
  // An ephemeral range starting this low leaves too few ports under it; use the ports above it.
  if (high <= 64000) return [high + 1, 65535];
  throw new Error(`the ephemeral port range (${low}-${high}) leaves no room for test servers`);
}

/** Takes the lock file for `port`. It's written whole under a name of its own, then linked into place, so it never exists half written. */
function reserve(port) {
  const file = join(LOCKS, String(port));
  const mine = `${file}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, file);
        return true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      if (!takeOver(file)) return false;
    }
    return false;
  } finally {
    unlinkSync(mine);
  }
}

/**
 * Moves a lock whose process is gone (killed before it could clean up) out of the way. It's renamed
 * before it's read again, so of two processes taking over the same lock only one moves it, and a live
 * lock moved by mistake goes back.
 */
function takeOver(file) {
  if (alive(pidIn(file))) return false;
  const moved = `${file}.stale-${process.pid}`;
  try {
    renameSync(file, moved);
  } catch {
    return false;
  }
  const dead = !alive(pidIn(moved));
  if (!dead) {
    try {
      linkSync(moved, file);
    } catch {}
  }
  unlinkSync(moved);
  return dead;
}

function pidIn(file) {
  try {
    return Number(readFileSync(file, "utf8"));
  } catch {
    return 0;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const bindable = (port) =>
  new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });

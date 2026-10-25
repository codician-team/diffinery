import { main } from "./main.js";

// The bundle targets Node.js 22; on an older one, say so instead of failing somewhere obscure.
if (Number(process.versions.node.split(".")[0]) < 22) {
  process.stderr.write(`error: diffinery needs Node.js 22 or later (this is ${process.version}). Reinstall with: curl -fsSL https://diffinery.com/install | bash\n`);
  process.exit(1);
}

// EPIPE when piping into `head` and similar should end quietly.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exitCode = 1;
  },
);

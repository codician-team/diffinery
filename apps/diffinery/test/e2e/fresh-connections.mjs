// Every fetch in an end-to-end test process gets a connection of its own (imported for that alone).
//
// wrangler dev closes a keep-alive connection that sits idle for a few seconds, and tests block the
// event loop for seconds at a time (execFileSync: `wrangler d1 execute`, git, tar). The close then
// waits unread, the next fetch reuses the dead connection and fails with "fetch failed" (other side
// closed, UND_ERR_SOCKET), and so does the test. A new localhost connection per request costs well under
// a millisecond; Node's fetch and WebSocket use this dispatcher.
//
// Node's fetch is its own bundled undici, which only works with a dispatcher from the same major
// version (undici 7's Agent under Node 22's fetch fails request bodies), so the undici dev dependency
// follows Node's: Node 22 bundles undici 6.
import { Agent, setGlobalDispatcher } from "undici";
import { createRequire } from "node:module";

const ours = createRequire(import.meta.url)("undici/package.json").version;
if (ours.split(".")[0] !== process.versions.undici.split(".")[0]) {
  throw new Error(`apps/diffinery's undici dev dependency (${ours}) must have the major version of the undici in Node ${process.version} (${process.versions.undici})`);
}
setGlobalDispatcher(new Agent({ pipelining: 0 }));

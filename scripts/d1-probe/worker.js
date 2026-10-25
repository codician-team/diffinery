// Probe for .github/workflows/d1-replication.yml: checks the D1 Sessions API on a
// throwaway database with read replication on, the way apps/diffinery uses it
// (src/lib/d1.ts): write in one session, then read in a new session started from
// the first one's bookmark, and expect to see the write every time.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/check") return new Response("not found", { status: 404 });
    const rounds = Number(url.searchParams.get("rounds") ?? 20);
    const out = { rounds, stale: 0, replicaReads: 0, primaryReads: 0, regions: {}, errors: [] };
    for (let i = 1; i <= rounds; i++) {
      try {
        const w = env.DB.withSession("first-primary");
        const value = `${Date.now()}-${i}-${crypto.randomUUID()}`;
        await w.prepare("INSERT INTO probe (k, v) VALUES ('latest', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(value).run();
        const bookmark = w.getBookmark();
        // A later request: new session from the bookmark (as a browser cookie would carry it).
        const r = env.DB.withSession(bookmark);
        const row = await r.prepare("SELECT v FROM probe WHERE k = 'latest'").first();
        const res = await r.prepare("SELECT v FROM probe WHERE k = 'latest'").run();
        const meta = res.meta ?? {};
        if (row?.v !== value) out.stale++;
        if (meta.served_by_primary === false) out.replicaReads++;
        else out.primaryReads++;
        const region = meta.served_by_region ?? "unknown";
        out.regions[region] = (out.regions[region] ?? 0) + 1;
        // An unconstrained session may read an older value, but must never fail.
        await env.DB.withSession("first-unconstrained").prepare("SELECT v FROM probe WHERE k = 'latest'").first();
      } catch (e) {
        out.errors.push(String(e));
      }
    }
    out.ok = out.stale === 0 && out.errors.length === 0;
    return Response.json(out, { status: out.ok ? 200 : 500 });
  },
};

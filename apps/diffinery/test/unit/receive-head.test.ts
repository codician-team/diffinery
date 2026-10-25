import { describe, expect, it } from "vitest";
import { FLUSH, concat, pkt, utf8 } from "@diffinery/git-core";
import { parseReceivePack, parseReceivePackHead } from "../../src/git/protocol.js";

const old = "0".repeat(40);
const oid = "a".repeat(40);
const body = (options: string[] | null) =>
  concat([
    pkt(`${old} ${oid} refs/heads/main\0report-status${options ? " push-options" : ""} atomic\n`),
    pkt(`${old} ${oid} refs/heads/next\n`),
    FLUSH,
    ...(options ? [...options.map((o) => pkt(`${o}\n`)), FLUSH] : []),
    utf8("PACK...."),
  ]);

describe("the start of a staged push", () => {
  it("gives the commands, push options and where the pack starts, as parseReceivePack does", () => {
    for (const options of [null, ["diffinery-import", "allow-secrets=a reason"]]) {
      const b = body(options);
      const head = parseReceivePackHead(b)!;
      const whole = parseReceivePack(b);
      expect(head.req.commands).toEqual(whole.commands);
      expect([...head.req.capabilities]).toEqual([...whole.capabilities]);
      expect(head.req.pushOptions).toEqual(whole.pushOptions);
      expect(b.subarray(head.packOffset)).toEqual(whole.pack);
    }
  });
  it("asks for more when the head is cut short, wherever it is cut", () => {
    const b = body(["diffinery-import"]);
    const full = parseReceivePackHead(b)!.packOffset;
    for (let n = 0; n < full; n++) expect(parseReceivePackHead(b.subarray(0, n))).toBeNull();
    expect(parseReceivePackHead(b.subarray(0, full))?.packOffset).toBe(full);
  });
});

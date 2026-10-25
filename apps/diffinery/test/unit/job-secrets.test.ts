import { describe, expect, it } from "vitest";
import { referencedSecrets, secretsFor } from "../../src/repo/job-secrets.js";

const job = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ "runs-on": "linux", steps, ...extra });

describe("secrets a job references", () => {
  it("finds names in expressions, with dot or index syntax, in any case", () => {
    const used = referencedSecrets(
      job([{ run: "deploy", env: { TOKEN: "${{ secrets.deploy_token }}" } }, { uses: "x/y@v1", with: { key: "${{ secrets['NPM_TOKEN'] }}" } }], { if: "secrets.FLAG != ''" }),
      { GLOBAL: '${{ secrets["Global"] }}' },
    );
    expect(used).toEqual(new Set(["DEPLOY_TOKEN", "NPM_TOKEN", "FLAG", "GLOBAL"]));
  });

  it("ignores the word outside expressions and as a property name", () => {
    expect(referencedSecrets(job([{ run: "echo no secrets here" }, { run: "${{ steps.secrets.outputs.x }}" }]))).toEqual(new Set());
  });

  it("gives everything when an expression reads secrets as a whole", () => {
    expect(referencedSecrets(job([{ run: "echo '${{ toJSON(secrets) }}'" }]))).toBe("all");
    expect(referencedSecrets(job([{ run: "${{ secrets[format('{0}_KEY', matrix.env)] }}" }]))).toBe("all");
  });

  it("narrows the secrets map", () => {
    expect(secretsFor({ A: "1", B: "2", Lower: "3" }, new Set(["A", "LOWER"]))).toEqual({ A: "1", Lower: "3" });
    expect(secretsFor({ A: "1" }, "all")).toEqual({ A: "1" });
  });
});

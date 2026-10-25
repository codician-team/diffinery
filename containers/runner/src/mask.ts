/**
 * Values shorter than this are not masked: masking e.g. a 1-character secret
 * would replace that character everywhere and make logs unreadable.
 */
export const MIN_MASK_LENGTH = 3;

/** Replaces registered secret values with `***` in log output. */
export class Masker {
  private values = new Set<string>();
  private sorted: string[] = [];

  add(value: string | undefined | null): void {
    if (value === undefined || value === null) return;
    const v = String(value);
    if (v.trim().length < MIN_MASK_LENGTH) return;
    const before = this.values.size;
    this.values.add(v);
    this.values.add(v.trim());
    // multi-line secrets: mask each line individually, since logs are line based
    if (/\r?\n/.test(v)) {
      for (const line of v.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length >= MIN_MASK_LENGTH) this.values.add(t);
      }
    }
    if (this.values.size !== before) {
      this.sorted = [...this.values].sort((a, b) => b.length - a.length);
    }
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  /** True when the text contains any masked value. */
  containsSecret(text: string): boolean {
    for (const v of this.sorted) if (text.includes(v)) return true;
    return false;
  }

  mask(text: string): string {
    if (this.sorted.length === 0 || text === "") return text;
    let out = text;
    for (const v of this.sorted) {
      if (out.includes(v)) out = out.split(v).join("***");
    }
    return out;
  }
}

/**
 * POSIX 5-field cron (minute hour day-of-month month day-of-week), evaluated
 * in UTC, as used by `on.schedule`. Supports `*`, lists, ranges, steps and
 * month/day names. As in POSIX cron, when both day-of-month and day-of-week
 * are restricted a date matches if either one matches.
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Day-of-month field was `*` (or `*` with a step). */
  domWildcard: boolean;
  /** Day-of-week field was `*` (or `*` with a step). */
  dowWildcard: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesBase: 1 },
  // 7 is accepted as Sunday and normalised to 0.
  { name: "day of week", min: 0, max: 7, names: DAYS, namesBase: 0 },
];

function parseValue(text: string, spec: FieldSpec, cron: string): number {
  const upper = text.toUpperCase();
  if (spec.names) {
    const idx = spec.names.indexOf(upper);
    if (idx >= 0) return idx + spec.namesBase!;
  }
  if (!/^\d+$/.test(text)) throw new CronError(`Invalid ${spec.name} value '${text}' in cron '${cron}'`);
  const n = Number(text);
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${spec.name} value ${n} out of range ${spec.min}-${spec.max} in cron '${cron}'`);
  }
  return n;
}

function parseField(field: string, spec: FieldSpec, cron: string): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>();
  let wildcard = false;
  for (const part of field.split(",")) {
    if (part === "") throw new CronError(`Empty list element in ${spec.name} field of cron '${cron}'`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`Invalid step in ${spec.name} field of cron '${cron}'`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronError(`Invalid step '${stepText}' in ${spec.name} field of cron '${cron}'`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.name === "day of week" ? 6 : spec.max;
      wildcard = true;
    } else {
      const bounds = range!.split("-");
      if (bounds.length > 2) throw new CronError(`Invalid range '${range}' in cron '${cron}'`);
      lo = parseValue(bounds[0]!, spec, cron);
      hi = bounds.length === 2 ? parseValue(bounds[1]!, spec, cron) : stepText !== undefined ? spec.max : lo;
      if (hi < lo) throw new CronError(`Invalid range '${range}' (end before start) in cron '${cron}'`);
    }
    for (let v = lo; v <= hi; v += step) values.add(spec.name === "day of week" && v === 7 ? 0 : v);
  }
  return { values, wildcard };
}

/** Parses a cron expression; throws CronError with a descriptive message when invalid. */
export function parseCron(cron: string): ParsedCron {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") {
    throw new CronError(`Cron '${cron}' must have exactly 5 fields (minute hour day-of-month month day-of-week)`);
  }
  const [mi, h, dom, mo, dow] = fields.map((f, i) => parseField(f, FIELDS[i]!, cron));
  return {
    minutes: mi!.values,
    hours: h!.values,
    daysOfMonth: dom!.values,
    months: mo!.values,
    daysOfWeek: dow!.values,
    domWildcard: dom!.wildcard,
    dowWildcard: dow!.wildcard,
  };
}

/** Returns an error message for an invalid cron, or undefined. */
export function validateCron(cron: string): string | undefined {
  try {
    parseCron(cron);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

function matchesParsed(c: ParsedCron, date: Date): boolean {
  if (!c.minutes.has(date.getUTCMinutes())) return false;
  if (!c.hours.has(date.getUTCHours())) return false;
  if (!c.months.has(date.getUTCMonth() + 1)) return false;
  const domOk = c.daysOfMonth.has(date.getUTCDate());
  const dowOk = c.daysOfWeek.has(date.getUTCDay());
  if (c.domWildcard || c.dowWildcard) return domOk && dowOk;
  return domOk || dowOk;
}

/** True if `date` (minute precision, UTC) matches the cron expression. */
export function cronMatches(cron: string | ParsedCron, date: Date): boolean {
  return matchesParsed(typeof cron === "string" ? parseCron(cron) : cron, date);
}

/**
 * The first minute strictly after `after` that matches the cron, or null if
 * none is found within ~5 years (e.g. `0 0 31 2 *`).
 */
export function nextCronMatch(cron: string | ParsedCron, after: Date): Date | null {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (t.getTime() <= limit) {
    if (!c.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const domOk = c.daysOfMonth.has(t.getUTCDate());
    const dowOk = c.daysOfWeek.has(t.getUTCDay());
    const dayOk = c.domWildcard || c.dowWildcard ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

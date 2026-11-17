import { kvGet, kvSet, type Db } from "../store/db.ts";

const KEY = "mute_until";

export function muteUntil(db: Db): number {
  const v = kvGet(db, KEY);
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function isMuted(db: Db, now = Date.now()): boolean {
  return muteUntil(db) > now;
}

export function setMuteUntil(db: Db, until: number): void {
  kvSet(db, KEY, String(Math.floor(until)));
}

export function clearMute(db: Db): void {
  kvSet(db, KEY, "0");
}

/** Next local midnight in `tz`, as epoch ms. */
export function nextMidnight(tz: string, now: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(now))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  let hour = Number(parts["hour"]);
  let day = Number(parts["day"]);
  let month = Number(parts["month"]);
  let year = Number(parts["year"]);
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  const asIfUtc = Date.UTC(year, month - 1, day, hour, Number(parts["minute"]), Number(parts["second"]));
  const offset = asIfUtc - now;
  const local = new Date(now + offset);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  return midnight - offset;
}

export function muteDeadline(which: string, now: number, tz: string): number {
  if (which === "1h") return now + 3_600_000;
  if (which === "8h") return now + 8 * 3_600_000;
  if (which === "week") return now + 7 * 86_400_000;
  if (which === "tomorrow") return nextMidnight(tz, now);
  throw new Error("bad mute span");
}

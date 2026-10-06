import { describe, expect, test } from "bun:test";
import type { StateSnapshot } from "@kanseishitsu/shared";
import { deviceLevel, deviceLine } from "./device";

const snap = (run: number, wait: number, err: number) => ({ counts: { run, wait, err } }) as StateSnapshot;

describe("deviceLevel", () => {
  test("いちばん重い状態を選ぶ", () => {
    expect(deviceLevel(snap(3, 1, 1))).toBe("err");
    expect(deviceLevel(snap(3, 1, 0))).toBe("wait");
    expect(deviceLevel(snap(3, 0, 0))).toBe("run");
    expect(deviceLevel(snap(0, 0, 0))).toBe("idle");
  });
});

describe("deviceLine", () => {
  const now = new Date("2026-10-06T08:00:00Z");
  const usage = (takenAt: string, five: number | null, fiveReset: string, seven: number | null) => ({
    hostId: "h",
    hostLabel: "h",
    takenAt,
    fiveHour: five === null ? null : { usedPct: five, resetsAt: fiveReset },
    sevenDay: seven === null ? null : { usedPct: seven, resetsAt: "2026-10-10T00:00:00Z" },
  });
  test("いちばん新しい値の残りを送る。リセット時刻を過ぎた値と、ない値は -", () => {
    const s = {
      counts: { run: 1, wait: 0, err: 0 },
      usage: [
        usage("2026-10-06T07:00:00Z", 50, "2026-10-06T09:00:00Z", 10),
        usage("2026-10-06T07:59:00Z", 27.4, "2026-10-06T09:00:00Z", 9),
      ],
    } as unknown as StateSnapshot;
    expect(deviceLine(s, now)).toBe("S run 73 91");
    const old = { counts: { run: 0, wait: 0, err: 1 }, usage: [usage("2026-10-06T07:00:00Z", 50, "2026-10-06T07:30:00Z", null)] };
    expect(deviceLine(old as unknown as StateSnapshot, now)).toBe("S err - -");
    expect(deviceLine({ counts: { run: 0, wait: 0, err: 0 }, usage: [] } as unknown as StateSnapshot, now)).toBe("S idle - -");
  });
});

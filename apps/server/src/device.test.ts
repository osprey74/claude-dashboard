import { describe, expect, test } from "bun:test";
import type { StateSnapshot } from "@kanseishitsu/shared";
import { deviceLevel } from "./device";

const snap = (run: number, wait: number, err: number) => ({ counts: { run, wait, err } }) as StateSnapshot;

describe("deviceLevel", () => {
  test("いちばん重い状態を選ぶ", () => {
    expect(deviceLevel(snap(3, 1, 1))).toBe("err");
    expect(deviceLevel(snap(3, 1, 0))).toBe("wait");
    expect(deviceLevel(snap(3, 0, 0))).toBe("run");
    expect(deviceLevel(snap(0, 0, 0))).toBe("idle");
  });
});

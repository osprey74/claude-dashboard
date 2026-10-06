import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER_NAME, LAUNCHER_SH, MAX_RUNNING } from "./launcher";
import { mergeSettings } from "./setup";

const BIN = "/Users/u/.kanseishitsu/bin/kanseishitsu-agent";
const LAUNCH = "/Users/u/.kanseishitsu/bin/kanseishitsu-launch";

describe("mergeSettings", () => {
  test("以前の実行ファイルの登録を起動役に置き換え、他人の登録は残す", () => {
    const other = { hooks: [{ type: "command", command: "/usr/local/bin/other" }] };
    const current = {
      hooks: {
        Stop: [other, { hooks: [{ type: "command", command: BIN, args: ["hook", "Stop"], async: true, timeout: 5 }] }],
      },
      statusLine: { type: "command", command: `${BIN} statusline`, padding: 0 },
    };
    const { next, changes } = mergeSettings(current, LAUNCH, [BIN]);
    expect(next.hooks!.Stop).toEqual([
      other,
      { hooks: [{ type: "command", command: LAUNCH, args: ["hook", "Stop"], async: true, timeout: 5 }] },
    ]);
    expect(next.hooks!.SubagentStart![0]!.hooks![0]!.command).toBe(LAUNCH);
    expect(next.statusLine!.command).toBe(`${LAUNCH} statusline`);
    expect(changes.some((c) => c.includes("hooks.Stop の登録を"))).toBe(true);
    // 2回目は変更なし
    expect(mergeSettings(next, LAUNCH, [BIN]).changes).toEqual([]);
  });

  test("登録済みの PreToolUse に、危険操作のガードを別の登録として足す", () => {
    const hook = { hooks: [{ type: "command", command: LAUNCH, args: ["hook", "PreToolUse"], async: true, timeout: 5 }] };
    const { next, changes } = mergeSettings({ hooks: { PreToolUse: [hook] } }, LAUNCH, [BIN]);
    expect(next.hooks!.PreToolUse).toEqual([
      hook,
      { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: LAUNCH, args: ["guard"], timeout: 5 }] },
    ]);
    expect(changes).toContain("hooks.PreToolUse に追加（危険操作のガード）（既存 1 件はそのまま）");
  });

  test("独自の statusLine は置き換えない", () => {
    const current = { statusLine: { type: "command", command: "~/my-status.sh" } };
    const { next, warnings } = mergeSettings(current, LAUNCH, [BIN]);
    expect(next.statusLine!.command).toBe("~/my-status.sh");
    expect(warnings.length).toBe(1);
  });
});

describe.skipIf(process.platform === "win32")("起動役", () => {
  /** 起動役と偽のエージェントを一時ディレクトリに置く */
  function setupDir(agentBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kanseishitsu-launch-"));
    writeFileSync(join(dir, LAUNCHER_NAME), LAUNCHER_SH, { mode: 0o755 });
    writeFileSync(join(dir, "kanseishitsu-agent"), `#!/bin/sh\n${agentBody}\n`, { mode: 0o755 });
    chmodSync(join(dir, "kanseishitsu-agent"), 0o755);
    return dir;
  }

  async function run(dir: string, args: string[], stdin: string) {
    const t0 = performance.now();
    const p = Bun.spawn([join(dir, LAUNCHER_NAME), ...args], { stdin: new Blob([stdin]), stdout: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return { out, ms: performance.now() - t0, code: p.exitCode };
  }

  test("hook：エージェントが止まっても待たずに終わり、標準入力はエージェントに渡る", async () => {
    const dir = setupDir(`cat > "$(dirname "$0")/got.txt"; sleep 3`);
    try {
      const r = await run(dir, ["hook", "Stop"], '{"a":1}');
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(1000);
      // 切り離したエージェントが書き終わるのを待つ（負荷が高いと遅れるため、最大3秒）
      for (let i = 0; i < 60 && !existsSync(join(dir, "got.txt")); i++) await Bun.sleep(50);
      await Bun.sleep(50);
      expect(readFileSync(join(dir, "got.txt"), "utf8")).toBe('{"a":1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hook：止まったエージェントが上限まで溜まっていたら起動しない", async () => {
    const dir = setupDir(`cat >> "$(dirname "$0")/got.txt"; sleep 3`);
    try {
      for (let i = 0; i < MAX_RUNNING; i++) await run(dir, ["hook", "Stop"], "x");
      await Bun.sleep(300);
      await run(dir, ["hook", "Stop"], "y");
      await Bun.sleep(300);
      expect(readFileSync(join(dir, "got.txt"), "utf8")).toBe("x".repeat(MAX_RUNNING));
    } finally {
      await Bun.$`pkill -f ${dir}`.nothrow().quiet();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("guard：判定の結果を返す", async () => {
    const dir = setupDir(`cat >/dev/null; echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'; sleep 3`);
    try {
      const r = await run(dir, ["guard"], "{}");
      expect(r.out).toBe('{"hookSpecificOutput":{"permissionDecision":"ask"}}\n');
      expect(r.ms).toBeLessThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("guard：当たらずに終われば何も返さない。止まったら約3秒で打ち切って通す", async () => {
    const quick = setupDir(`cat >/dev/null`);
    const stuck = setupDir(`sleep 10`);
    try {
      const a = await run(quick, ["guard"], "{}");
      expect(a.out).toBe("");
      expect(a.ms).toBeLessThan(1000);
      const b = await run(stuck, ["guard"], "{}");
      expect(b.out).toBe("");
      expect(b.ms).toBeGreaterThan(2500);
      expect(b.ms).toBeLessThan(4500);
    } finally {
      await Bun.$`pkill -f ${stuck}`.nothrow().quiet();
      rmSync(quick, { recursive: true, force: true });
      rmSync(stuck, { recursive: true, force: true });
    }
  });

  test("statusline：エージェントの表示を返す", async () => {
    const dir = setupDir(`read line; echo "[Opus] ctx 5%"; sleep 3`);
    try {
      const r = await run(dir, ["statusline"], "{}\n");
      expect(r.out).toBe("[Opus] ctx 5%\n");
      expect(r.ms).toBeLessThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("statusline：エージェントが応答しなければ約1秒で代わりの表示を返す", async () => {
    const dir = setupDir(`sleep 5`);
    try {
      const r = await run(dir, ["statusline"], "{}\n");
      expect(r.out).toBe("[管制室] エージェント応答なし\n");
      expect(r.ms).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

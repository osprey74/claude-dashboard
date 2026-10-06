// フェーズ5：物理表示灯（M5Stack Atom Matrix、USB シリアル）へ、いちばん重い状態と利用枠の残りを送る。
// ネットワークには何も公開しない。送るのは「S <状態> <5時間枠の残り%> <週間枠の残り%>」の1行だけ（不明な残りは -）。
// つなぎ先は設定（device.serialPath）、なければ /dev/cu.usbserial-* が1つだけあるときに自動で使う。
// Atom は 45 秒間何も届かないと「途切れた」表示にするので、変化がなくても 10 秒ごとに送り直す

import { closeSync, constants, openSync, readdirSync, writeSync } from "node:fs";
import type { StateSnapshot } from "@kanseishitsu/shared";

export type DeviceLevel = "err" | "wait" | "run" | "idle";

export function deviceLevel(s: StateSnapshot): DeviceLevel {
  if (s.counts.err > 0) return "err";
  if (s.counts.wait > 0) return "wait";
  if (s.counts.run > 0) return "run";
  return "idle";
}

/** 表示灯に送る1行。利用枠はいちばん新しい値（24時間以内で、リセット時刻を過ぎていないもの）の残り */
export function deviceLine(s: StateSnapshot, now = new Date()): string {
  const fresh = s.usage
    .filter((u) => now.getTime() - Date.parse(u.takenAt) < 24 * 3600_000)
    .sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt))[0];
  const remain = (w: { usedPct: number; resetsAt: string | null } | null | undefined) =>
    !w || (w.resetsAt && Date.parse(w.resetsAt) < now.getTime())
      ? "-"
      : String(Math.round(Math.max(0, Math.min(100, 100 - w.usedPct))));
  return `S ${deviceLevel(s)} ${remain(fresh?.fiveHour)} ${remain(fresh?.sevenDay)}`;
}

function findPort(configured: string | undefined): string | null {
  if (configured) return configured;
  try {
    const ports = readdirSync("/dev").filter((f) => /^cu\.usbserial-/.test(f));
    return ports.length === 1 ? `/dev/${ports[0]}` : null;
  } catch {
    return null;
  }
}

export class DeviceLink {
  private fd: number | null = null;
  private path: string | null = null;
  private line = "S idle - -";
  private lastSent = 0;

  constructor(private readonly serialPath?: string) {}

  /** 内容が変わったとき、または 10 秒たったときに送る */
  update(line: string, force = false): void {
    const changed = line !== this.line;
    this.line = line;
    if (!changed && !force && Date.now() - this.lastSent < 10_000) return;
    this.send();
  }

  private open(): boolean {
    if (this.fd !== null) return true;
    const path = findPort(this.serialPath);
    if (!path) return false;
    try {
      // O_NONBLOCK：キャリア待ちで止まらないように。開いたまま設定しないと、閉じたときに設定が戻る
      this.fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
      Bun.spawnSync(["/bin/stty", "-f", path, "115200", "raw", "-echo", "-hupcl", "clocal"]);
      this.path = path;
      console.log(`[device] 表示灯に接続: ${path}`);
      return true;
    } catch (e) {
      this.close();
      console.warn(`[device] 開けません: ${path} (${(e as Error).message})`);
      return false;
    }
  }

  private send(): void {
    if (!this.open()) return;
    try {
      writeSync(this.fd!, `${this.line}\n`);
      this.lastSent = Date.now();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") return; // 送信待ちが詰まっているだけ。次の機会に送る
      console.warn(`[device] 送信失敗のため切断: ${this.path} (${code ?? (e as Error).message})`);
      this.close();
    }
  }

  private close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // 抜かれたあとなど
      }
    }
    this.fd = null;
    this.path = null;
  }
}

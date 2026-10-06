// フェーズ5：物理表示灯（M5Stack Atom Matrix、USB シリアル）へ、いちばん重い状態を送る。
// ネットワークには何も公開しない。送るのは状態の種類（err / wait / run / idle）だけ。
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
  private level: DeviceLevel = "idle";
  private lastSent = 0;

  constructor(private readonly serialPath?: string) {}

  /** 状態が変わったとき、または 10 秒たったときに送る */
  update(level: DeviceLevel, force = false): void {
    const changed = level !== this.level;
    this.level = level;
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
      writeSync(this.fd!, `S ${this.level}\n`);
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

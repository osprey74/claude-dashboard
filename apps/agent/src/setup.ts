// agent setup：設定ファイルの作成と、Claude Code の設定（~/.claude/settings.json）への登録
// settings.json は --apply を付けたときだけ、差分を表示して確認を取ってから追記する（既存の設定は上書きしない）

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { AGENT_DIR, CONFIG_PATH, loadConfig, type AgentConfig } from "./common";

/** 登録するフックイベント。phase1.md の8種に、状態判定の精度を上げる3種（※）を加える */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure", // ※ ツール失敗も稼働中の印として扱う
  "PermissionRequest", // ※ 許可ダイアログ表示時に入力待ちにする
  "Notification",
  "Stop",
  "StopFailure", // ※ API エラーで朱にする
  "SubagentStart", // ※ フェーズ2：サブエージェントとプレイヤーの対応付け
  "SubagentStop",
  "SessionEnd",
] as const;

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const isWin = platform() === "win32";
const BIN_DIR = join(AGENT_DIR, "bin");
const BIN_PATH = join(BIN_DIR, isWin ? "kanseishitsu-agent.exe" : "kanseishitsu-agent");

/** 設定ファイルに書くパス。Windows でも Git Bash で壊れないよう / 区切りにする */
const slashPath = (p: string) => p.replace(/\\/g, "/");

function ask(question: string, def?: string): string {
  const v = prompt(def ? `${question} [${def}]:` : `${question}:`);
  return (v ?? "").trim() || def || "";
}

/** コンパイル済みの実行ファイルとして動いているか（bun run で動かしている場合は false） */
function isCompiled(): boolean {
  return !/^bun(\.exe)?$/i.test(basename(process.execPath));
}

type HookHandler = { type: string; command?: string; args?: string[]; [k: string]: unknown };
type MatcherGroup = { matcher?: string; hooks?: HookHandler[] };
type Settings = {
  hooks?: Record<string, MatcherGroup[]>;
  statusLine?: { type?: string; command?: string; [k: string]: unknown };
  [k: string]: unknown;
};

export function desiredEntries(binPath: string) {
  const cmd = slashPath(binPath);
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const ev of HOOK_EVENTS) {
    // args を指定するとシェルを通さずに直接起動される（Windows のパス問題を避けられる）
    hooks[ev] = [{ hooks: [{ type: "command", command: cmd, args: ["hook", ev], async: true, timeout: 5 }] }];
  }
  // statusLine は args を持たないためシェル経由で起動される。空白を含むパスだけ引用符で囲む
  const statusCommand = (/\s/.test(cmd) ? `"${cmd}"` : cmd) + " statusline";
  return { hooks, statusLine: { type: "command", command: statusCommand, padding: 0 }, cmd };
}

/** 既存の設定に追記した結果と、変更点の説明を返す */
export function mergeSettings(current: Settings, binPath: string): { next: Settings; changes: string[]; warnings: string[] } {
  const want = desiredEntries(binPath);
  const next: Settings = structuredClone(current);
  const changes: string[] = [];
  const warnings: string[] = [];
  next.hooks ??= {};
  for (const [ev, groups] of Object.entries(want.hooks)) {
    const existing = next.hooks[ev] ?? [];
    const already = existing.some((g) => g.hooks?.some((h) => slashPath(h.command ?? "") === want.cmd));
    if (already) continue;
    next.hooks[ev] = [...existing, ...groups];
    changes.push(`hooks.${ev} に追加（既存 ${existing.length} 件はそのまま）`);
  }
  const sl = next.statusLine;
  if (!sl) {
    next.statusLine = want.statusLine;
    changes.push(`statusLine を設定: ${want.statusLine.command}`);
  } else if (!slashPath(sl.command ?? "").includes(want.cmd)) {
    warnings.push(
      `statusLine は既に設定されているため変更しません（現在: ${sl.command}）。` +
        `利用枠・モデルの送信には、現在のスクリプトから「${want.statusLine.command}」を呼ぶか、置き換えてください。`,
    );
  }
  return { next, changes, warnings };
}

export async function setup(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply");
  const prev = loadConfig();

  console.log("Claude 管制室 エージェントの設定\n");
  const cfg: AgentConfig = {
    serverUrl: ask("サーバーの URL（例 https://home-mac-mini.xxxx.ts.net:8443）", prev?.serverUrl),
    token: ask("この PC 用のトークン（Mac Mini の cli.ts add-host で発行）", prev?.token),
    hostLabel: ask("この PC の表示名（例 office-win）", prev?.hostLabel),
  };
  if (!cfg.serverUrl || !cfg.token) {
    console.error("URL とトークンは必須です");
    process.exit(1);
  }
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  if (!isWin) chmodSync(CONFIG_PATH, 0o600);
  console.log(`\n設定ファイルを保存しました: ${CONFIG_PATH}`);

  // 接続確認
  try {
    const res = await fetch(cfg.serverUrl.replace(/\/+$/, "") + "/healthz", { signal: AbortSignal.timeout(5000) });
    console.log(res.ok ? "サーバーへの接続: OK" : `サーバーへの接続: HTTP ${res.status}`);
  } catch (e) {
    console.log(`サーバーへの接続: 失敗（${e instanceof Error ? e.message : e}）`);
  }

  // 実行ファイルを決まった場所に置く（設定ファイルに書くパスを固定するため）
  let binPath = process.execPath;
  if (isCompiled()) {
    mkdirSync(BIN_DIR, { recursive: true });
    if (slashPath(process.execPath) !== slashPath(BIN_PATH)) {
      copyFileSync(process.execPath, BIN_PATH);
      if (!isWin) chmodSync(BIN_PATH, 0o755);
      console.log(`実行ファイルを配置しました: ${BIN_PATH}`);
    }
    binPath = BIN_PATH;
  } else {
    console.log("（開発モード：bun で実行中のため、実行ファイルの配置は行いません）");
  }

  const current: Settings = existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  const { next, changes, warnings } = mergeSettings(current, binPath);

  console.log(`\n${SETTINGS_PATH} への変更内容:`);
  if (changes.length === 0) console.log("  （変更なし：登録済みです）");
  for (const c of changes) console.log(`  + ${c}`);
  for (const w of warnings) console.log(`  ! ${w}`);

  if (!apply) {
    console.log("\n登録する内容（手動で追記する場合）:");
    const want = desiredEntries(binPath);
    console.log(JSON.stringify({ hooks: want.hooks, statusLine: want.statusLine }, null, 2));
    console.log("\n自動で追記するには、内容を確認のうえ `setup --apply` を実行してください。");
    return;
  }
  if (changes.length === 0) return;
  const ok = ask("\nこの内容で settings.json に追記しますか？ (y/N)", "N");
  if (!/^y(es)?$/i.test(ok)) {
    console.log("中止しました。settings.json は変更していません。");
    return;
  }
  if (existsSync(SETTINGS_PATH)) {
    const backup = `${SETTINGS_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(SETTINGS_PATH, backup);
    console.log(`バックアップ: ${backup}`);
  } else {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log("追記しました。新しく起動した Claude Code のセッションから送信が始まります。");
}

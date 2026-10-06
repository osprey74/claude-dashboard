// 管理用コマンド（Mac Mini 上で実行）
//   bun apps/server/src/cli.ts add-host <ラベル>     PC 用トークンを発行（平文はこのとき一度だけ表示）
//   bun apps/server/src/cli.ts list-hosts            登録済み PC の一覧
//   bun apps/server/src/cli.ts revoke-host <ラベル>  トークンを無効化
//   bun apps/server/src/cli.ts set-password          画面ログインのパスワードを設定

import { issueHostToken } from "./auth";
import { DB_PATH, loadConfig, saveConfig } from "./config";
import { openDb } from "./db";

const [cmd, arg] = process.argv.slice(2);

// for await で読むと抜けた時点で stdin が閉じられ、2回目の入力が読めなくなるため、data イベントで1行ずつ読む
function readHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  const tty = stdin.isTTY;
  if (tty) stdin.setRawMode(true);
  stdin.resume();
  let buf = "";
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.pause();
          if (tty) {
            stdin.setRawMode(false);
            process.stdout.write("\n");
          }
          resolve(buf);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

switch (cmd) {
  case "add-host": {
    if (!arg) throw new Error("ラベルを指定してください（例：office-win）");
    const db = openDb(DB_PATH);
    const { hostId, token } = issueHostToken(db, arg);
    console.log(`host_id: ${hostId}\nlabel:   ${arg}\ntoken:   ${token}\n`);
    console.log("このトークンは再表示できません。PC 側の agent setup で入力してください。");
    break;
  }
  case "list-hosts": {
    const db = openDb(DB_PATH);
    console.table(
      db
        .query("SELECT label, hostname, os, agent_version, last_seen_at, revoked_at, host_id FROM hosts ORDER BY created_at")
        .all(),
    );
    break;
  }
  case "revoke-host": {
    if (!arg) throw new Error("ラベルを指定してください");
    const db = openDb(DB_PATH);
    const r = db
      .query("UPDATE hosts SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), arg);
    console.log(`${r.changes} 件を無効化しました`);
    break;
  }
  case "set-password": {
    const pw = await readHidden("新しいパスワード（12文字以上）: ");
    if (pw.length < 12) {
      console.error("12文字以上にしてください");
      process.exit(1);
    }
    if (process.stdin.isTTY) {
      const again = await readHidden("もう一度: ");
      if (again !== pw) {
        console.error("一致しません");
        process.exit(1);
      }
    }
    const cfg = loadConfig();
    cfg.passwordHash = await Bun.password.hash(pw);
    saveConfig(cfg);
    console.log("設定しました。サーバーを再起動すると反映されます。");
    break;
  }
  default:
    console.log("usage: cli.ts add-host <label> | list-hosts | revoke-host <label> | set-password");
}
process.exit(0);

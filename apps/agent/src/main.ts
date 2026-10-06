// Claude 管制室 PC 側エージェント
//   kanseishitsu-agent hook <イベント名>   hooks から呼ばれる
//   kanseishitsu-agent statusline          statusLine から呼ばれる
//   kanseishitsu-agent setup [--apply]     設定と Claude Code への登録

import { redactDeep, type HookIngest, type StatuslineIngest } from "@kanseishitsu/shared";
import { hostInfo, loadConfig, log, post, readStdinJson, truncateDeep } from "./common";
import { setup } from "./setup";
import { statuslinePayload, statusText } from "./statusline";
import { modelFromTranscript } from "./transcript";

async function runHook(event: string): Promise<void> {
  const payload = await readStdinJson();
  const cfg = loadConfig();
  if (!cfg) return;
  // hooks の入力に model がない場合は、会話記録から直近のモデルを補う
  if (!payload.model && typeof payload.transcript_path === "string" && event !== "SessionEnd") {
    const m = modelFromTranscript(payload.transcript_path);
    if (m) payload.model_from_transcript = m;
  }
  // サブエージェントのモデルは、サブエージェント自身の会話記録から読む
  if (event === "SubagentStop" && typeof payload.agent_transcript_path === "string" && payload.agent_type) {
    const m = modelFromTranscript(payload.agent_transcript_path, undefined, true);
    if (m) payload.subagent_model_from_transcript = m;
  }
  const body: HookIngest = {
    event: event || String(payload.hook_event_name ?? "unknown"),
    host: hostInfo(cfg),
    payload: redactDeep(truncateDeep(payload)),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/hook", body);
}

async function runStatusline(): Promise<void> {
  const payload = await readStdinJson();
  // 表示を先に出す。新しい更新が来ると実行中のスクリプトは中断されるため、送信は後回しにする
  try {
    process.stdout.write(statusText(payload) + "\n");
  } catch {
    // 表示に失敗しても送信は続ける
  }
  const cfg = loadConfig();
  if (!cfg) return;
  const body: StatuslineIngest = {
    host: hostInfo(cfg),
    payload: statuslinePayload(payload),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/statusline", body);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "hook") await runHook(arg ?? "");
  else if (cmd === "statusline") await runStatusline();
  else if (cmd === "setup") await setup(process.argv.slice(3));
  else console.log("usage: kanseishitsu-agent hook <event> | statusline | setup [--apply]");
} catch (e) {
  // hooks・statusLine から呼ばれたときは決して失敗させない
  log(`${cmd} error: ${e instanceof Error ? e.stack : String(e)}`);
  if (cmd === "setup") {
    console.error(e);
    process.exit(1);
  }
}
process.exit(0);

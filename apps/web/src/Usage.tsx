// 利用枠の行（5時間枠・週間枠）

import type { RateWindow, UsageView } from "@kanseishitsu/shared";
import { ago } from "./format";

const pad = (n: number) => String(n).padStart(2, "0");
const resetText = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const untilText = (iso: string | null, now: Date) => {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60000));
  return `あと ${Math.floor(min / 60)}:${pad(min % 60)}`;
};

/**
 * 利用枠はアカウント単位の値。同じアカウントの PC からは同じ値が届くため、値が同じものはまとめ、
 * 24 時間以内に届いた値だけを出す（別のアカウントの PC があれば行が分かれる）
 */
function distinct(usage: UsageView[], now: Date): UsageView[] {
  const out: UsageView[] = [];
  for (const u of usage) {
    if (now.getTime() - Date.parse(u.takenAt) > 24 * 3600_000) continue;
    const same = out.find(
      (o) =>
        o.fiveHour?.resetsAt === u.fiveHour?.resetsAt &&
        o.sevenDay?.resetsAt === u.sevenDay?.resetsAt &&
        Math.abs((o.fiveHour?.usedPct ?? 0) - (u.fiveHour?.usedPct ?? 0)) <= 2,
    );
    if (!same) out.push(u);
  }
  return out;
}

export function UsageRow({ usage, now }: { usage: UsageView[]; now: Date }) {
  const rows = distinct(usage, now);
  if (rows.length === 0) {
    return (
      <section className="usage panel" aria-label="利用枠">
        <p className="detail-none">
          利用枠の値はまだ届いていません（ターミナルの Claude Code の statusLine から届きます）
        </p>
      </section>
    );
  }
  return (
    <section className="usage panel" aria-label="利用枠">
      {rows.map((u) => (
        <div key={u.hostId} className="usage-account">
          <Window label="5時間枠" w={u.fiveHour} now={now} short />
          <Window label="週間枠" w={u.sevenDay} now={now} />
          <div className="usage-src">
            {u.hostLabel} から取得 ・ {ago(u.takenAt, now)}
          </div>
        </div>
      ))}
    </section>
  );
}

function Window({ label, w, now, short }: { label: string; w: RateWindow | null; now: Date; short?: boolean }) {
  // リセット時刻を過ぎた値は古いので出さない
  const expired = w?.resetsAt && Date.parse(w.resetsAt) < now.getTime();
  const used = w && !expired ? Math.max(0, Math.min(100, w.usedPct)) : null;
  return (
    <div className="window">
      <span className="window-label">{label}</span>
      <span className="window-track" role="img" aria-label={used === null ? `${label} 不明` : `${label} 使用率 ${Math.round(used)}%`}>
        <span className="window-bar" style={{ width: `${used ?? 0}%` }} />
      </span>
      <span className="window-remain">
        残り <span className="mono window-pct">{used === null ? "—" : `${Math.round(100 - used)}%`}</span>
      </span>
      <span className="window-reset">
        {short && w?.resetsAt && !expired ? (
          <>
            <span className="only-mobile">{untilText(w.resetsAt, now)}</span>
            <span className="only-desktop">
              次のリセット <span className="mono">{resetText(w.resetsAt)}</span>
            </span>
          </>
        ) : (
          <>
            次のリセット <span className="mono">{expired ? "—" : resetText(w?.resetsAt ?? null)}</span>
          </>
        )}
      </span>
    </div>
  );
}

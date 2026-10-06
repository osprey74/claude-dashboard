// セッションの詳細パネル

import { useEffect, useState } from "react";
import type { SessionDetail, SessionView } from "@kanseishitsu/shared";
import { CtxGauge, ModelChip, PLAYER_STATE, PlayerMark, playerLabel } from "./parts";
import { Indicator } from "./Icons";
import { STATUS_LABEL, ago } from "./format";

/** 一覧のセッション（WebSocket で更新される）が変わったら詳細を取り直す */
function useDetail(session: SessionView | null): SessionDetail | null | "missing" {
  const [detail, setDetail] = useState<SessionDetail | null | "missing">(null);
  const key = session ? `${session.sessionId}|${session.lastEventAt}|${session.players.length}` : "";
  useEffect(() => {
    if (!session) {
      setDetail(null);
      return;
    }
    let alive = true;
    fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}`, { credentials: "same-origin" })
      .then(async (r) => {
        if (r.status === 401) location.href = "/login";
        if (!alive) return;
        setDetail(r.ok ? await r.json() : "missing");
      })
      .catch(() => alive && setDetail("missing"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return detail;
}

export function DetailPanel({
  session,
  now,
  warnPct,
  onClose,
}: {
  session: SessionView | null;
  now: Date;
  warnPct: number;
  onClose?: () => void;
}) {
  const detail = useDetail(session);

  if (!session) {
    return (
      <aside className="detail panel detail-empty" aria-label="セッション詳細">
        <p>タイルを選ぶと、ここにセッションの詳細を表示します。</p>
      </aside>
    );
  }
  // 一覧の値（即時に更新される）を優先し、詳細 API の値で補う
  const d = detail && detail !== "missing" && detail.session.sessionId === session.sessionId ? detail : null;
  const s = session;
  return (
    <aside className="detail panel" aria-label="セッション詳細">
      {onClose && (
        <button type="button" className="detail-back" onClick={onClose}>
          ← 一覧に戻る
        </button>
      )}
      <div className="detail-head">
        <div className="detail-host mono">{d ? `${d.hostLabel}${d.hostSub ? " ・ " + d.hostSub : ""}` : " "}</div>
        <div className="detail-title">
          <h2 className="mono">{s.project}</h2>
          <ModelChip model={s.model} />
        </div>
        <div className="detail-status">
          <Indicator status={s.status} />
          <span>
            {STATUS_LABEL[s.status]} ・ {s.statusText}
          </span>
          <span className="detail-ago mono">{ago(s.lastEventAt, now)}</span>
        </div>
        <CtxGauge pct={s.ctxPct} warnPct={warnPct} large />
        {s.cwd && <div className="detail-cwd mono">{s.cwd}</div>}
      </div>

      {s.players.length > 0 && (
        <section className="detail-section">
          <h3>指揮中のプレイヤー（{s.players.length}）</h3>
          {s.players.map((p) => (
            <div key={p.playerId} className="player-row">
              <span className="player-main">
                <PlayerMark p={p} />
                <span>{playerLabel(p)}</span>
                {p.task && <span className="player-task">{p.task}</span>}
              </span>
              <span className="player-state">
                <span className={`dot dot-${p.status}`} />
                {PLAYER_STATE[p.status]}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="detail-section">
        <h3>直近のプロンプト</h3>
        {d?.prompt ? (
          <div className="prompt-box">{d.prompt.text}</div>
        ) : (
          <p className="detail-none">{d ? "まだプロンプトを受信していません" : "読み込み中…"}</p>
        )}
      </section>

      {d?.todos && d.todos.length > 0 && (
        <section className="detail-section">
          <h3>進捗</h3>
          {d.todos.map((t, i) => (
            <div key={i} className={`step step-${t.status}`}>
              <StepIcon status={t.status} />
              <span>{t.label}</span>
            </div>
          ))}
        </section>
      )}

      <section className="detail-section">
        <h3>作業結果</h3>
        {d?.result ? (
          <div className="result">{d.result.text}</div>
        ) : (
          <p className="detail-none">{s.status === "run" ? "作業中です" : "—"}</p>
        )}
      </section>

      <footer className="detail-foot">
        指示の送信は今後のフェーズで対応します。応答や許可が必要なときは{" "}
        <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
          Remote Control
        </a>{" "}
        を使ってください。
      </footer>
    </aside>
  );
}

function StepIcon({ status }: { status: "done" | "active" | "todo" }) {
  if (status === "done")
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--run)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="完了">
        <path d="M5 12l5 5 9-10" />
      </svg>
    );
  if (status === "active")
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" aria-label="実行中">
        <path d="M12 3a9 9 0 1 1-9 9" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A5870" strokeWidth="2" aria-label="未着手">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

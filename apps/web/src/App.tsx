import { useState } from "react";
import { modelFamily, type HostView, type SessionView, type StateSnapshot } from "@kanseishitsu/shared";
import { Indicator, LogoIcon, PcIcon } from "./Icons";
import { STATUS_LABEL, ago, formatDateTime } from "./format";
import { useLiveState, useNow, type Conn } from "./useLiveState";

export function App() {
  const { state, conn, updatedAt } = useLiveState();
  const now = useNow();
  // フェーズ1では選択状態の表示のみ。フェーズ2で詳細パネルを開く
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="page">
      <div className="container">
        <Header state={state} conn={conn} updatedAt={updatedAt} />
        <section className="hosts-section" aria-label="PCとセッション">
          <div className="section-head">
            <h2>PC とセッション</h2>
          </div>
          {!state ? (
            <p className="empty">読み込み中…</p>
          ) : state.hosts.length === 0 ? (
            <p className="empty panel">
              監視中の PC はまだありません。Mac Mini で <code>cli.ts add-host</code> を実行してトークンを発行し、PC 側で
              <code>agent setup</code> を行ってください。
            </p>
          ) : (
            <div className="host-grid">
              {state.hosts.map((h) => (
                <HostCard key={h.hostId} host={h} now={now} selected={selected} onSelect={setSelected} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Header({ state, conn, updatedAt }: { state: StateSnapshot | null; conn: Conn; updatedAt: Date | null }) {
  const c = state?.counts ?? { run: 0, wait: 0, err: 0 };
  return (
    <header className="header panel">
      <div className="brand">
        <LogoIcon />
        <div>
          <h1>Claude 管制室</h1>
          <div className="brand-sub">
            {state ? `${state.hosts.length}台のPCを監視中` : "接続中"} ・ 最終更新{" "}
            <span className="mono">{updatedAt ? formatDateTime(updatedAt) : "—"}</span>
            {conn !== "open" && (
              <span className="conn-warn" role="status">
                {" "}
                ・ {conn === "retrying" ? "再接続中" : "接続中"}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="counts">
        <Count status="run" label="稼働中" n={c.run} />
        <Count status="wait" label="入力待ち" n={c.wait} />
        <Count status="err" label="異常" n={c.err} />
      </div>
    </header>
  );
}

function Count({ status, label, n }: { status: "run" | "wait" | "err"; label: string; n: number }) {
  return (
    <div className="count">
      <Indicator status={status} />
      <span className="count-label">{label}</span>
      <span className="count-n mono">{n}</span>
    </div>
  );
}

function HostCard({
  host,
  now,
  selected,
  onSelect,
}: {
  host: HostView;
  now: Date;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const sub = [host.os, host.hostname !== host.label ? host.hostname : null].filter(Boolean).join(" ・ ");
  return (
    <div className="host panel">
      <div className="host-head">
        <div className="host-id">
          <PcIcon />
          <div>
            <div className="host-name mono">{host.label}</div>
            <div className="host-sub">{sub || "未受信"}</div>
          </div>
        </div>
        <span className="host-beat">最終イベント {ago(host.lastSeenAt, now)}</span>
      </div>
      {host.sessions.length === 0 ? (
        <p className="host-empty">稼働中のセッションはありません</p>
      ) : (
        host.sessions.map((s) => (
          <SessionTile key={s.sessionId} s={s} now={now} selected={selected === s.sessionId} onSelect={onSelect} />
        ))
      )}
    </div>
  );
}

function SessionTile({
  s,
  now,
  selected,
  onSelect,
}: {
  s: SessionView;
  now: Date;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`tile${selected ? " selected" : ""}`}
      aria-pressed={selected}
      aria-label={`${s.project} ${STATUS_LABEL[s.status]} ${s.statusText}`}
      onClick={() => onSelect(s.sessionId)}
      title={s.cwd ?? undefined}
    >
      <span className="tile-row">
        <span className="tile-title">
          <Indicator status={s.status} />
          <span className="tile-project mono">{s.project}</span>
        </span>
        {s.model && <span className={`model model-${modelFamily(s.model)}`}>{s.model}</span>}
      </span>
      <span className="tile-row">
        <span className="tile-status">
          <span className={`status-word status-${s.status}`}>{STATUS_LABEL[s.status]}</span> ・ {s.statusText}
        </span>
        <span className="tile-ago">{ago(s.lastEventAt, now)}</span>
      </span>
    </button>
  );
}

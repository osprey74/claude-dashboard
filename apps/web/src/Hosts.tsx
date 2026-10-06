// PC カードとセッションタイル

import type { HostView, SessionView } from "@kanseishitsu/shared";
import { ConductorIcon, CtxGauge, ModelChip, PlayerChip } from "./parts";
import { Indicator, PcIcon } from "./Icons";
import { STATUS_LABEL, ago } from "./format";

interface Props {
  hosts: HostView[];
  now: Date;
  warnPct: number;
  selected: string | null;
  onSelect: (id: string) => void;
}

export function HostGrid({ hosts, now, warnPct, selected, onSelect }: Props) {
  const ordered = [...hosts.filter((h) => h.lastSeenAt), ...hosts.filter((h) => !h.lastSeenAt)];
  return (
    <div className="host-grid">
      {ordered.map((h) => (
        <HostCard key={h.hostId} host={h} now={now} warnPct={warnPct} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function HostCard({ host, now, warnPct, selected, onSelect }: { host: HostView } & Omit<Props, "hosts">) {
  const sub = [host.os, host.hostname !== host.label ? host.hostname : null].filter(Boolean).join(" ・ ");
  // トークンを発行しただけで、まだ一度もデータが届いていない PC
  if (!host.lastSeenAt) {
    return (
      <div className="host panel host-pending">
        <div className="host-head">
          <div className="host-id">
            <PcIcon />
            <div>
              <div className="host-name mono">{host.label}</div>
              <div className="host-sub">トークン発行済み ・ エージェント未設定</div>
            </div>
          </div>
          <span className="pending-badge">未接続</span>
        </div>
      </div>
    );
  }
  return (
    <div className="host panel">
      <div className="host-head">
        <div className="host-id">
          <PcIcon />
          <div>
            <div className="host-name mono" title={host.agentVersion ? `エージェント v${host.agentVersion}` : undefined}>
              {host.label}
            </div>
            <div className="host-sub">
              {sub || "未受信"}
              {!host.agentVersion && <span className="old-agent"> ・ エージェントが旧版です</span>}
            </div>
          </div>
        </div>
        <span className="host-beat">最終イベント {ago(host.lastSeenAt, now)}</span>
      </div>
      {host.sessions.length === 0 ? (
        <p className="host-empty">稼働中のセッションはありません</p>
      ) : (
        host.sessions.map((s) => (
          <SessionTile
            key={s.sessionId}
            s={s}
            now={now}
            warnPct={warnPct}
            selected={selected === s.sessionId}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

function SessionTile({
  s,
  now,
  warnPct,
  selected,
  onSelect,
}: {
  s: SessionView;
  now: Date;
  warnPct: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const running = s.players.filter((p) => p.status === "run").length;
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
        <ModelChip model={s.model} />
      </span>
      <span className="tile-row">
        <span className="tile-status">
          <span className={`status-word status-${s.status}`}>{STATUS_LABEL[s.status]}</span> ・ {s.statusText}
        </span>
        {s.players.length > 0 ? (
          <span className="conductor" title={`稼働中 ${running} / ${s.players.length}`}>
            <ConductorIcon />
            指揮 ×{s.players.length}
          </span>
        ) : (
          <span className="tile-ago">{ago(s.lastEventAt, now)}</span>
        )}
      </span>
      <CtxGauge pct={s.ctxPct} warnPct={warnPct} />
      {s.players.length > 0 && (
        <span className="players">
          {s.players.map((p) => (
            <PlayerChip key={p.playerId} p={p} />
          ))}
        </span>
      )}
    </button>
  );
}

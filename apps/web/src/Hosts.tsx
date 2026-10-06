// PC カードとセッションタイル

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { HostView, SessionStatus, SessionView } from "@kanseishitsu/shared";
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

/** たたんだ PC の一覧は、見ている人のブラウザにだけ覚えておく */
const COLLAPSED_KEY = "kanseishitsu.collapsedHosts";

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function HostGrid({ hosts, now, warnPct, selected, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (hostId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(hostId)) next.add(hostId);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 保存できなくても、この画面の間はたたんだままにする
      }
      return next;
    });
  const ordered = [...hosts.filter((h) => h.lastSeenAt), ...hosts.filter((h) => !h.lastSeenAt)];
  return (
    <div className="host-grid">
      {ordered.map((h) => (
        <HostCard
          key={h.hostId}
          host={h}
          now={now}
          warnPct={warnPct}
          selected={selected}
          onSelect={onSelect}
          collapsed={collapsed.has(h.hostId)}
          onToggle={() => toggle(h.hostId)}
        />
      ))}
    </div>
  );
}

const SUMMARY_ORDER: SessionStatus[] = ["err", "wait", "run", "ended"];

/** たたんだときに出す、状態ごとのセッション数 */
function SessionSummary({ sessions }: { sessions: SessionView[] }) {
  if (sessions.length === 0) return <p className="host-empty">稼働中のセッションはありません</p>;
  return (
    <p className="host-summary">
      <span>セッション {sessions.length}</span>
      {SUMMARY_ORDER.map((st) => {
        const n = sessions.filter((s) => s.status === st).length;
        return n === 0 ? null : (
          <span key={st} className="host-summary-item">
            <Indicator status={st} size={12} />
            {STATUS_LABEL[st]} {n}
          </span>
        );
      })}
    </p>
  );
}

function HostCard({
  host,
  now,
  warnPct,
  selected,
  onSelect,
  collapsed,
  onToggle,
}: { host: HostView; collapsed: boolean; onToggle: () => void } & Omit<Props, "hosts">) {
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
  // ダブルクリックでたたむ。キーボードでは Enter・Space で切り替える
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };
  // ダブルクリックで PC 名が選択状態になるのを防ぐ
  const onMouseDown = (e: MouseEvent) => {
    if (e.detail > 1) e.preventDefault();
  };
  return (
    <div className={`host panel${collapsed ? " host-collapsed" : ""}`}>
      <div className="host-head">
        <div
          className="host-id host-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          title={collapsed ? "ダブルクリックでひらく" : "ダブルクリックでたたむ"}
          onDoubleClick={onToggle}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
        >
          <svg className="host-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
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
      {collapsed ? (
        <SessionSummary sessions={host.sessions} />
      ) : host.sessions.length === 0 ? (
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

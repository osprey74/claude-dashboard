// 履歴（すべて・プロンプト・完了・異常）

import { useEffect, useState } from "react";
import type { HistoryFilter, HistoryItem } from "@kanseishitsu/shared";
import { Indicator } from "./Icons";
import { formatClock } from "./format";

const FILTERS: [HistoryFilter, string][] = [
  ["all", "すべて"],
  ["prompt", "プロンプト"],
  ["done", "完了"],
  ["err", "異常"],
];

const PAGE = 30;

export function History({ version, onSelect }: { version: string; onSelect: (sessionId: string) => void }) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [more, setMore] = useState(false);

  // 状態が更新されるたびに先頭ページを取り直す
  useEffect(() => {
    let alive = true;
    fetch(`/api/history?filter=${filter}&limit=${PAGE}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: HistoryItem[]) => {
        if (!alive) return;
        setItems((prev) => {
          // 「もっと見る」で読んだ分は残す
          if (!prev || prev.length <= PAGE) return list;
          const ids = new Set(list.map((i) => i.id));
          return [...list, ...prev.filter((i) => !ids.has(i.id) && i.id < (list[list.length - 1]?.id ?? 0))];
        });
        setMore(list.length === PAGE);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filter, version]);

  const loadMore = async () => {
    const last = items?.[items.length - 1];
    if (!last) return;
    const r = await fetch(`/api/history?filter=${filter}&limit=${PAGE}&before=${last.id}`, { credentials: "same-origin" });
    if (!r.ok) return;
    const list: HistoryItem[] = await r.json();
    setItems((prev) => [...(prev ?? []), ...list]);
    setMore(list.length === PAGE);
  };

  return (
    <section className="history panel" aria-label="履歴">
      <div className="history-head">
        <h2>履歴</h2>
        <div className="pills" role="tablist">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`pill${filter === f ? " active" : ""}`}
              onClick={() => {
                setItems(null);
                setFilter(f);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!items ? (
        <p className="detail-none">読み込み中…</p>
      ) : items.length === 0 ? (
        <p className="detail-none">該当する履歴はありません</p>
      ) : (
        <div className="history-list">
          {items.map((h) => (
            <button
              key={h.id}
              type="button"
              className="history-row"
              onClick={() => h.sessionId && onSelect(h.sessionId)}
              title={new Date(h.at).toLocaleString()}
            >
              <span className="mono h-time">{formatClock(new Date(h.at))}</span>
              <span className="mono h-host">{h.hostLabel}</span>
              <span className="mono h-project">{h.project}</span>
              <span className="h-text">{h.text}</span>
              <span className="h-mark">
                <HistoryMark kind={h.kind} />
              </span>
            </button>
          ))}
        </div>
      )}
      {more && (
        <button type="button" className="more" onClick={loadMore}>
          もっと見る
        </button>
      )}
    </section>
  );
}

function HistoryMark({ kind }: { kind: HistoryItem["kind"] }) {
  if (kind === "prompt" || kind === "player") return <Indicator status="run" size={12} />;
  if (kind === "done" || kind === "wait") return <Indicator status="wait" size={12} />;
  if (kind === "err") return <Indicator status="err" size={12} />;
  return <Indicator status="ended" size={12} />;
}

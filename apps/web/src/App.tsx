import { useEffect, useState } from "react";
import type { SessionView, StateSnapshot } from "@kanseishitsu/shared";
import { AlertList } from "./Alerts";
import { DetailPanel } from "./Detail";
import { History } from "./History";
import { HostGrid } from "./Hosts";
import { Indicator, LogoIcon } from "./Icons";
import { PushToggle } from "./Push";
import { UsageRow } from "./Usage";
import { formatDateTime } from "./format";
import { useLiveState, useNow, type Conn } from "./useLiveState";

type Tab = "sessions" | "usage" | "history";

/** 画面の状態は URL のハッシュに持つ（スマホの「戻る」で詳細を閉じられるようにする） */
function useRoute() {
  const parse = () => {
    const h = location.hash.slice(1);
    const m = h.match(/^s=(.+)$/);
    return {
      tab: (h === "usage" || h === "history" ? h : "sessions") as Tab,
      selected: m ? decodeURIComponent(m[1]!) : null,
    };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (hash: string) => {
    if (location.hash.slice(1) !== hash) location.hash = hash;
  };
  return {
    ...route,
    select: (id: string) => go(`s=${encodeURIComponent(id)}`),
    setTab: (t: Tab) => go(t === "sessions" ? "" : t),
    close: () => (history.length > 1 ? history.back() : go("")),
  };
}

function useIsMobile(): boolean {
  const q = "(max-width: 720px)";
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

function findSession(state: StateSnapshot | null, id: string | null): SessionView | null {
  if (!state || !id) return null;
  for (const h of state.hosts) for (const s of h.sessions) if (s.sessionId === id) return s;
  return null;
}

export function App() {
  const { state, conn, updatedAt } = useLiveState();
  const now = useNow();
  const route = useRoute();
  const mobile = useIsMobile();
  const warnPct = state?.ui?.ctxWarnPct ?? 70;
  const selectedSession = findSession(state, route.selected);
  const version = state?.generatedAt ?? "";
  const alerts = (
    <AlertList
      alerts={state?.alerts ?? []}
      now={now}
      idleMin={state?.ui?.idleAlertMin ?? 10}
      canOpen={(id) => findSession(state, id) !== null}
      onSelect={(id) => {
        route.select(id);
        // すでに選んでいるセッションでも分かるよう、詳細パネルまでスクロールして一瞬光らせる
        setTimeout(() => {
          const el = document.querySelector<HTMLElement>(".detail:not(.detail-empty)");
          if (!el) return;
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.remove("flash");
          void el.offsetWidth;
          el.classList.add("flash");
        }, 50);
      }}
    />
  );

  const hosts = !state ? (
    <p className="empty">読み込み中…</p>
  ) : state.hosts.length === 0 ? (
    <p className="empty panel">
      監視中の PC はまだありません。Mac Mini で <code>cli.ts add-host</code> を実行してトークンを発行し、PC 側で
      <code>agent setup</code> を行ってください。
    </p>
  ) : (
    <HostGrid hosts={state.hosts} now={now} warnPct={warnPct} selected={route.selected} onSelect={route.select} />
  );

  if (mobile) {
    return (
      <div className="page page-mobile">
        <div className="container">
          <Header state={state} conn={conn} updatedAt={updatedAt} mobile />
          {route.tab === "usage" ? (
            <UsageRow usage={state?.usage ?? []} now={now} />
          ) : route.tab === "history" ? (
            <History version={version} onSelect={route.select} />
          ) : (
            <>
              {alerts}
              {hosts}
            </>
          )}
          <Footer />
        </div>
        {route.selected && (
          <div className="sheet" role="dialog" aria-modal="true" aria-label="セッション詳細">
            {selectedSession ? (
              <DetailPanel session={selectedSession} now={now} warnPct={warnPct} onClose={route.close} />
            ) : (
              <aside className="detail panel">
                <button type="button" className="detail-back" onClick={route.close}>
                  ← 一覧に戻る
                </button>
                <p className="detail-none">このセッションは終了したか、一覧から外れています。</p>
              </aside>
            )}
          </div>
        )}
        <BottomNav tab={route.tab} onTab={route.setTab} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="container">
        <Header state={state} conn={conn} updatedAt={updatedAt} />
        <UsageRow usage={state?.usage ?? []} now={now} />
        {alerts}
        <div className="main-row">
          <div className="main-col">
            <section className="hosts-section" aria-label="PCとセッション">
              <div className="section-head">
                <h2>PC とセッション</h2>
                <span className="section-hint">タイルを選ぶと右側に詳細を表示します</span>
              </div>
              {hosts}
            </section>
            <History version={version} onSelect={route.select} />
          </div>
          <DetailPanel session={selectedSession} now={now} warnPct={warnPct} />
        </div>
        <Footer />
      </div>
    </div>
  );
}

function Header({
  state,
  conn,
  updatedAt,
  mobile,
}: {
  state: StateSnapshot | null;
  conn: Conn;
  updatedAt: Date | null;
  mobile?: boolean;
}) {
  const c = state?.counts ?? { run: 0, wait: 0, err: 0 };
  return (
    <header className="header panel">
      <div className="brand">
        {!mobile && <LogoIcon />}
        <div>
          <h1>Claude 管制室</h1>
          <div className="brand-sub">
            {state ? `${state.hosts.filter((h) => h.lastSeenAt).length}台のPCを監視中` : "接続中"} ・ 最終更新{" "}
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

function Footer() {
  return (
    <footer className="footer">
      PC 側エージェント：
      <a href="/downloads/kanseishitsu-agent-windows-x64.exe">Windows（x64）</a> ・
      <a href="/downloads/kanseishitsu-agent-macos-arm64">macOS（arm64）</a>
      <PushToggle />
      <form method="post" action="/logout" className="logout">
        <button type="submit">ログアウト</button>
      </form>
    </footer>
  );
}

const NAV: [Tab, string, string][] = [
  ["sessions", "セッション", "M4 5h16v10H4zM8 19h8M12 15v4"],
  ["usage", "利用枠", "M4 19V9M10 19V5M16 19v-7M22 19H2"],
  ["history", "履歴", "M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z"],
];

function BottomNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="bottom-nav" aria-label="メイン">
      {NAV.map(([t, label, d]) => (
        <button key={t} type="button" className={tab === t ? "active" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => onTab(t)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={d} />
          </svg>
          {label}
        </button>
      ))}
    </nav>
  );
}

// この端末での通知（Web Push）の購読。iPhone はホーム画面に追加したアプリから開いたときだけ使える

import { useEffect, useState } from "react";

type PushState = "loading" | "unsupported" | "needs-install" | "denied" | "off" | "on";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export function PushToggle() {
  const [state, setState] = useState<PushState>("loading");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setState(isIos() && !isStandalone() ? "needs-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") return setState("denied");
      setState((await currentSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(`失敗しました：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const subscribe = () =>
    run(async () => {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = (await (await fetch("/api/push/key", { credentials: "same-origin" })).json()) as { publicKey: string };
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
      const r = await post("/api/push/subscribe", { subscription: sub.toJSON() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState("on");
      setMsg("この端末で通知を受け取ります。");
    });

  const unsubscribe = () =>
    run(async () => {
      const sub = await currentSubscription();
      if (sub) {
        await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setState("off");
      setMsg("通知を止めました。");
    });

  const test = () =>
    run(async () => {
      const sub = await currentSubscription();
      if (!sub) return setState("off");
      const r = await post("/api/push/test", { endpoint: sub.endpoint });
      const j = (await r.json()) as { ok?: boolean };
      setMsg(j.ok ? "テスト通知を送りました。" : "送れませんでした。もう一度「通知を受け取る」を押してください。");
      if (!j.ok) setState("off");
    });

  if (state === "loading" || state === "unsupported") return null;
  return (
    <div className="push">
      {state === "needs-install" && (
        <span className="push-note">通知を受け取るには、共有メニューの「ホーム画面に追加」から開いてください。</span>
      )}
      {state === "denied" && <span className="push-note">通知が拒否されています。端末の設定で許可してください。</span>}
      {state === "off" && (
        <button type="button" className="push-btn" disabled={busy} onClick={subscribe}>
          この端末で通知を受け取る
        </button>
      )}
      {state === "on" && (
        <>
          <span className="push-on">通知：オン</span>
          <button type="button" className="push-btn" disabled={busy} onClick={test}>
            テスト送信
          </button>
          <button type="button" className="push-btn" disabled={busy} onClick={unsubscribe}>
            止める
          </button>
        </>
      )}
      {msg && (
        <span className="push-note" role="status">
          {msg}
        </span>
      )}
    </div>
  );
}

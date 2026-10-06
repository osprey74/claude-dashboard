// Claude 管制室 サーバー（受信 API・WebSocket 配信・画面の静的配信）

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookIngest, StatuslineIngest, WsMessage } from "@kanseishitsu/shared";
import {
  SESSION_COOKIE,
  hostFromBearer,
  loginLocked,
  makeSessionCookieValue,
  readCookie,
  recordLoginResult,
  verifySessionCookieValue,
  type HostRow,
} from "./auth";
import { DB_PATH, loadConfig } from "./config";
import { openDb } from "./db";
import { lastStatusline, processHook, processStatusline } from "./ingest";
import { loginPage } from "./login-page";
import { buildSnapshot, snapshotKey } from "./state";

const cfg = loadConfig();
const db = openDb(DB_PATH);
const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");

// ---- 配信 ----

let server: ReturnType<typeof Bun.serve> | null = null;
let lastKey = "";
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastIfChanged(): void {
  const state = buildSnapshot(db, cfg);
  const key = snapshotKey(state);
  if (key === lastKey) return;
  lastKey = key;
  const msg: WsMessage = { type: "snapshot", state };
  server?.publish("state", JSON.stringify(msg));
}

/** 受信が続いても 200ms にまとめて配信する */
function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastIfChanged();
  }, 200);
}

// 時間経過による状態変化（応答なし（推定）・一覧から外す）を拾う
setInterval(broadcastIfChanged, 15_000);
// 接続維持のための ping（中継やスマホのスリープ対策）
setInterval(() => {
  const msg: WsMessage = { type: "ping", at: new Date().toISOString() };
  server?.publish("state", JSON.stringify(msg));
}, 25_000);

// ---- HTTP ----

type Env = { Variables: { host: HostRow } };
const app = new Hono<Env>();

app.get("/healthz", (c) => c.json({ ok: true }));

// 受信系：PC ごとのトークンを検証し、200 を即座に返してから処理する
const ingest = new Hono<Env>();
ingest.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
ingest.use("*", async (c, next) => {
  const host = hostFromBearer(db, c.req.header("Authorization"));
  if (!host) {
    console.warn(`[ingest] 401 ${c.req.path} (Authorization ${c.req.header("Authorization") ? "不一致" : "なし"})`);
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("host", host);
  await next();
});
ingest.post("/hook", async (c) => {
  const body = await c.req.json<HookIngest>().catch(() => null);
  if (!body || typeof body.payload !== "object") return c.json({ error: "bad request" }, 400);
  const host = c.get("host");
  const now = new Date();
  setTimeout(() => {
    try {
      processHook(db, host, body, now);
      scheduleBroadcast();
    } catch (e) {
      console.error("[ingest/hook]", e);
    }
  }, 0);
  return c.json({ ok: true });
});
ingest.post("/statusline", async (c) => {
  const body = await c.req.json<StatuslineIngest>().catch(() => null);
  if (!body || typeof body.payload !== "object") return c.json({ error: "bad request" }, 400);
  const host = c.get("host");
  const now = new Date();
  setTimeout(() => {
    try {
      processStatusline(db, host, body, now);
      scheduleBroadcast();
    } catch (e) {
      console.error("[ingest/statusline]", e);
    }
  }, 0);
  return c.json({ ok: true });
});
app.route("/api/ingest", ingest);

// 画面ログイン
const cookieAttrs = (maxAgeSec: number) =>
  `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

app.get("/login", (c) => c.html(loginPage()));
app.post("/login", async (c) => {
  if (loginLocked()) return c.html(loginPage("試行回数が多すぎます。5分後に再度お試しください。"), 429);
  if (!cfg.passwordHash) return c.html(loginPage("パスワードが未設定です。サーバーで set-password を実行してください。"), 503);
  const form = await c.req.parseBody();
  const pw = typeof form.password === "string" ? form.password : "";
  const ok = pw.length > 0 && (await Bun.password.verify(pw, cfg.passwordHash));
  recordLoginResult(ok);
  if (!ok) return c.html(loginPage("パスワードが違います。"), 401);
  c.header("Set-Cookie", `${SESSION_COOKIE}=${makeSessionCookieValue(cfg)}; ${cookieAttrs(cfg.sessionDays * 86400)}`);
  return c.redirect("/", 303);
});
app.post("/logout", (c) => {
  c.header("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttrs(0)}`);
  return c.redirect("/login", 303);
});

// ここから下はログインが必要
const isLoggedIn = (cookieHeader: string | null | undefined) =>
  verifySessionCookieValue(cfg, readCookie(cookieHeader, SESSION_COOKIE));

app.use("*", async (c, next) => {
  if (isLoggedIn(c.req.header("Cookie"))) return next();
  if (c.req.path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
  return c.redirect("/login", 302);
});

app.get("/api/state", (c) => c.json(buildSnapshot(db, cfg)));

// フェーズ1ゲート確認用：最後に届いた statusLine の内容（rate_limits が届くかの確認）
app.get("/api/debug/statusline", (c) => c.json(Object.fromEntries(lastStatusline)));

// PC 側エージェントの配布（bun run build:agent の成果物）
const AGENT_BIN = join(import.meta.dir, "..", "..", "agent", "bin");
const AGENT_FILES = ["kanseishitsu-agent-windows-x64.exe", "kanseishitsu-agent-macos-arm64"];
app.get("/downloads/:file", (c) => {
  const name = c.req.param("file");
  const path = join(AGENT_BIN, name);
  if (!AGENT_FILES.includes(name) || !existsSync(path)) return c.notFound();
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
});

if (existsSync(WEB_DIST)) {
  app.use("/*", serveStatic({ root: WEB_DIST }));
  app.get("*", serveStatic({ path: join(WEB_DIST, "index.html") }));
} else {
  app.get("/", (c) => c.text("画面がビルドされていません。bun run build:web を実行してください。", 503));
}

// ---- 起動 ----

server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (!isLoggedIn(req.headers.get("Cookie"))) return new Response("unauthorized", { status: 401 });
      // 他サイトからの WebSocket 接続を拒否する
      const origin = req.headers.get("Origin");
      if (origin && new URL(origin).host !== req.headers.get("Host")) {
        return new Response("forbidden", { status: 403 });
      }
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req, { srv });
  },
  websocket: {
    open(ws) {
      ws.subscribe("state");
      const msg: WsMessage = { type: "snapshot", state: buildSnapshot(db, cfg) };
      ws.send(JSON.stringify(msg));
    },
    message() {
      // フェーズ1では画面からのメッセージは受け付けない
    },
    close(ws) {
      ws.unsubscribe("state");
    },
  },
});

console.log(`[kanseishitsu] listening on http://${cfg.host}:${cfg.port} (db: ${DB_PATH})`);

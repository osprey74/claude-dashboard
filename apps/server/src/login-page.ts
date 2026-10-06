// 画面ログイン用の最小限の HTML（React のビルドに依存させない）

export function loginPage(message?: string): string {
  const msg = message ? `<p class="msg" role="alert">${escapeHtml(message)}</p>` : "";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude 管制室 ログイン</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0B111C; color: #E8EDF4;
  font-family: 'BIZ UDPGothic', 'Hiragino Sans', 'Yu Gothic', sans-serif; padding: 16px; box-sizing: border-box; }
form { width: 100%; max-width: 360px; background: #131B2A; border: 1px solid #263247; border-radius: 14px; padding: 24px;
  display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; }
h1 { margin: 0; font-size: 20px; letter-spacing: 0.04em; }
label { font-size: 13px; color: #9DA9BB; }
input { font: inherit; font-size: 16px; color: #E8EDF4; background: #0F1624; border: 1px solid #263247; border-radius: 8px;
  padding: 10px 12px; min-height: 44px; box-sizing: border-box; width: 100%; }
input:focus { outline: 2px solid #5BC0D6; outline-offset: 1px; }
button { font: inherit; font-size: 14px; font-weight: 700; color: #0B111C; background: #5BC0D6; border: 0; border-radius: 10px;
  padding: 10px 22px; min-height: 44px; cursor: pointer; }
.msg { margin: 0; font-size: 13px; color: #FFB8A3; }
</style>
</head>
<body>
<form method="post" action="/login">
<h1>Claude 管制室</h1>
${msg}
<label for="pw">パスワード</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">ログイン</button>
</form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

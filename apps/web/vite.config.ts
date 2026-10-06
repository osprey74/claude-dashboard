import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開発時は API と WebSocket をローカルのサーバー（既定 8790）へ中継する
const target = `http://127.0.0.1:${process.env.KANSEI_PORT ?? 8790}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    proxy: {
      "/api": target,
      "/login": target,
      "/logout": target,
      "/ws": { target, ws: true },
    },
  },
});

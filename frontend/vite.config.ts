import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        // Game (default route) + the standalone stats dashboard.
        main: "index.html",
        stats: "stats.html",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:7070",
        ws: true,
        changeOrigin: true,
      },
      "/bot": {
        target: "http://127.0.0.1:7070",
        changeOrigin: true,
      },
      "/voice": {
        target: "http://127.0.0.1:7070",
        changeOrigin: true,
      },
      // Exact match (^...$) so it proxies the JSON API at /stats but NOT the
      // /stats.html page, which Vite serves itself.
      "^/stats$": {
        target: "http://127.0.0.1:7070",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: "index.html",
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
      "/matchmake": {
        target: "http://127.0.0.1:7070",
        changeOrigin: true,
      },
      "/voice": {
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

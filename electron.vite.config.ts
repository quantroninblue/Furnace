import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          research: resolve("src/preload/research.ts"),
          browser: resolve("src/preload/browser.ts"),
        },
      },
    },
  },
  renderer: {
    build: { rollupOptions: { input: { index: resolve("src/renderer/index.html"), browser: resolve("src/renderer/browser.html") } } },
    plugins: [
      react(),
      {
        name: "development-csp",
        apply: "serve",
        transformIndexHtml: (html) =>
          html.replace(
            "script-src 'self';",
            "script-src 'self' 'unsafe-inline';",
          ),
      },
    ],
  },
});

import { defineConfig } from "vite";
import { resolve } from "node:path";

// Two HTML entry points: the full panel (index.html) and the compact tray
// popup (mini.html). Both share the modules under src/.
export default defineConfig({
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        mini: resolve(__dirname, "mini.html")
      }
    }
  }
});

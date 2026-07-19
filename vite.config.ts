import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Dev server for the orb renderer. The daemon serves the built output in production. */
export default defineConfig({
    root: "src/web",
    server: { port: 7332, host: "127.0.0.1" },
    build: {
        outDir: "../../lib/web",
        emptyOutDir: true,
        // Two entries: the overlay and the preferences window. Without listing preferences.html
        // here it is simply not built, and the second Tauri window loads a 404.
        rollupOptions: {
            input: {
                index: resolve(__dirname, "src/web/index.html"),
                preferences: resolve(__dirname, "src/web/preferences.html"),
            },
        },
    },
});

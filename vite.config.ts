import { defineConfig } from "vite";

/** Dev server for the orb renderer. The daemon serves the built output in production. */
export default defineConfig({
    root: "src/web",
    server: { port: 7332, host: "127.0.0.1" },
    build: { outDir: "../../lib/web", emptyOutDir: true },
});

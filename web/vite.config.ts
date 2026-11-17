import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// Development only: serve a local copy of the card database and scripts
// (RKA_DATA_DIR/cdb and RKA_DATA_DIR/scripts) instead of fetching them from GitHub.
function localData(): Plugin {
  const root = process.env.RKA_DATA_DIR;
  return {
    name: "rka-local-data",
    configureServer(server) {
      if (!root) return;
      server.middlewares.use("/data", (req, res, next) => {
        const file = path.join(root, decodeURIComponent((req.url ?? "").split("?")[0]));
        // a folder answers with its file names, shaped like GitHub's contents API
        if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(fs.readdirSync(file).map((name) => ({ name }))));
          return;
        }
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// The version shown on the menu
const run = process.env.GITHUB_RUN_NUMBER;
const commit = (process.env.GITHUB_SHA ?? "").slice(0, 7);
// the release (package.json) and the commit it was built from; "dev" locally
const release = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;
const version = run ? `v${release}${commit ? ` · ${commit}` : ""}` : "dev";

export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), localData()],
  worker: { format: "es" },
  build: { target: "es2022" },
});

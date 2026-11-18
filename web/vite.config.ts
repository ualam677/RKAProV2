import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

// The version shown on the menu: major.minor from package.json (bumped by hand for a batch of features), and the last
// number counting every commit since that bump, so each update shows a higher number; then the commit it was built from
const run = process.env.GITHUB_RUN_NUMBER;
const commit = (process.env.GITHUB_SHA ?? "").slice(0, 7);
const release = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;
const since = (() => {
  try {
    const bumped = execSync(`git log -1 --format=%H -G'"version"' -- package.json`, { cwd: path.dirname(new URL(import.meta.url).pathname) }).toString().trim();
    return bumped ? Number(execSync(`git rev-list --count ${bumped}..HEAD`).toString().trim()) : 0;
  } catch {
    return 0;
  }
})();
const [major, minor] = release.split(".");
const version = run ? `v${major}.${minor}.${since}${commit ? ` · ${commit}` : ""}` : `dev ${major}.${minor}.${since}`;

export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), localData()],
  worker: { format: "es" },
  build: { target: "es2022" },
});

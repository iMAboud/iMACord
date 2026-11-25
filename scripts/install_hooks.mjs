#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const hooksDir = path.join(rootDir, ".git", "hooks");

if (!fs.existsSync(hooksDir)) {
    console.error("[Hooks] .git/hooks directory not found.");
    process.exit(1);
}

const prePushPath = path.join(hooksDir, "pre-push");
const hookContent = `#!/bin/sh
set -e

echo "[iMCord pre-push] Building & verifying bundles before push..."
(cd Vencord-main && node scripts/build/build.mjs --standalone)
node scripts/verify_build.mjs --skip-web
`;

fs.writeFileSync(prePushPath, hookContent, { encoding: "utf8", mode: 0o755 });
console.log(`[Hooks] Installed pre-push verification hook at ${prePushPath}`);

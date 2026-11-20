#!/usr/bin/env node
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const vencordDir = path.join(rootDir, "Vencord-main");
const DEFAULT_UPSTREAM_REPO = process.env.UPSTREAM_REPO || "https://github.com/Vendicated/Vencord.git";

// Protected iMACord custom and shimmed files that must never be overwritten blindly by upstream.
// Keep Vencord-authored plugins (e.g. fakeNitro, copyFileContents) unprotected so they auto-update.
const PROTECTED_FILES = new Set([
    "browser/VencordNativeStub.ts",
    "iMCord.ico",
    "scripts/build/build.mjs",
    "scripts/build/common.mjs",
    "scripts/pluginMetadata.json",
    "src/Vencord.ts",
    "src/VencordNative.ts",
    "src/api/Settings.ts",
    "src/api/UserPluginManager.ts",
    "src/api/index.ts",
    "src/components/BaseText.tsx",
    "src/components/Button.tsx",
    "src/components/FormSwitch.tsx",
    "src/components/Heading.tsx",
    "src/components/Icons.tsx",
    "src/components/settings/AddonCard.css",
    "src/components/settings/AddonCard.tsx",
    "src/components/settings/PluginSourceBadge.tsx",
    "src/components/settings/tabs/plugins/ContributorModal.tsx",
    "src/components/settings/tabs/plugins/CustomPluginModal.tsx",
    "src/components/settings/tabs/plugins/PluginCard.tsx",
    "src/components/settings/tabs/plugins/PluginModal.css",
    "src/components/settings/tabs/plugins/PluginModal.tsx",
    "src/components/settings/tabs/plugins/index.tsx",
    "src/components/settings/tabs/plugins/styles.css",
    "src/components/settings/tabs/sync/BackupAndRestoreTab.tsx",
    "src/components/settings/tabs/sync/CloudTab.tsx",
    "src/components/settings/tabs/themes/CspErrorCard.tsx",
    "src/components/settings/tabs/updater/Components.tsx",
    "src/components/settings/tabs/updater/index.tsx",
    "src/components/settings/tabs/vencord/NotificationSettings.tsx",
    "src/components/settings/tabs/vencord/index.tsx",
    "src/main/ipcMain.ts",
    "src/main/settings.ts",
    "src/main/updater/http.ts",
    "src/main/utils/constants.ts",
    "src/modules.d.ts",
    "src/plugins/_core/settings.tsx",
    "src/plugins/amongick/index.ts",
    "src/plugins/betterSettings/index.tsx",
    "src/plugins/iMAMenu/index.ts",
    "src/plugins/memberCount/MemberCount.tsx",
    "src/plugins/memberCount/index.tsx",
    "src/plugins/multiStreamPopout/index.tsx",
    "src/plugins/vencordToolbox/index.tsx",
    "src/plugins/vencordToolbox/menu.tsx",
    "src/shared/IpcEvents.ts",
    "src/webpack/common/components.ts",
    "src/webpack/common/utils.ts"
].map(p => p.toLowerCase()));

const TEXT_EXTS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".css", ".json", ".yml", ".yaml", ".md", ".html", ".svg", ".txt", ""
]);

function isProtected(rel) {
    return PROTECTED_FILES.has(rel.toLowerCase());
}

function contentEquals(a, b, rel) {
    if (a.equals(b)) return true;
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXTS.has(ext) && !rel.startsWith(".")) return false;
    return a.toString("utf8").replace(/\r\n/g, "\n") === b.toString("utf8").replace(/\r\n/g, "\n");
}

function walk(dir, root = dir, res = {}) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (entry.isDirectory()) walk(full, root, res);
        else res[rel] = fs.readFileSync(full);
    }
    return res;
}

function removeEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            removeEmptyDirs(full);
            if (fs.readdirSync(full).length === 0) {
                fs.rmdirSync(full);
            }
        }
    }
}

function applyConstantsOverlay(buf) {
    const src = buf.toString("utf8");
    if (/\biMAboud\s*:/.test(src)) return buf;

    const anchor = "export const Devs = /* #__PURE__*/ Object.freeze({";
    const idx = src.indexOf(anchor);
    if (idx === -1) {
        throw new Error("[iMCord AutoSync] Failed to locate Devs object in src/utils/constants.ts");
    }

    const nl = src.includes("\r\n") ? "\r\n" : "\n";
    const entry = `${nl}    iMAboud: {${nl}        name: "iMAboud",${nl}        id: 0n${nl}    },`;
    const patched = src.slice(0, idx + anchor.length) + entry + src.slice(idx + anchor.length);
    return Buffer.from(patched, "utf8");
}

function writeGithubOutput(values) {
    const outPath = process.env.GITHUB_OUTPUT;
    if (!outPath) return;
    const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`);
    fs.appendFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function syncFromDir(upstreamDir, { dryRun = false } = {}) {
    const upFiles = walk(upstreamDir);
    if (Object.keys(upFiles).length === 0) {
        throw new Error(`Upstream directory has no files to sync: ${upstreamDir}`);
    }
    const localFiles = walk(vencordDir);
    let overlaid = 0;

    if (upFiles["src/utils/constants.ts"]) {
        const transformed = applyConstantsOverlay(upFiles["src/utils/constants.ts"]);
        if (!transformed.equals(upFiles["src/utils/constants.ts"])) overlaid++;
        upFiles["src/utils/constants.ts"] = transformed;
    }

    let updated = 0;
    for (const [rel, buf] of Object.entries(upFiles)) {
        if (isProtected(rel)) continue;
        const dest = path.join(vencordDir, rel);
        const cur = localFiles[rel];
        if (!cur || !contentEquals(cur, buf, rel)) {
            if (!dryRun) {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, buf);
            }
            updated++;
        }
    }

    let removed = 0;
    for (const rel of Object.keys(localFiles)) {
        if (!upFiles[rel] && !isProtected(rel)) {
            if (!dryRun) fs.rmSync(path.join(vencordDir, rel), { force: true });
            removed++;
        }
    }
    if (!dryRun) removeEmptyDirs(vencordDir);

    return { updated, removed, overlaid };
}

function updatePluginMetadata(upstreamDir, upstreamTs, { dryRun = false } = {}) {
    const metadataPath = path.join(vencordDir, "scripts", "pluginMetadata.json");
    let metadata = { folders: {}, userPlugins: {} };
    try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch { }
    metadata.folders ??= {};
    metadata.userPlugins ??= {};

    const sortEntries = obj => Object.fromEntries(
        Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
    const originalNormalized = JSON.stringify({
        folders: sortEntries(metadata.folders),
        userPlugins: sortEntries(metadata.userPlugins)
    });

    const nowTs = Math.floor(Date.now() / 1000);
    const upPluginsDir = path.join(upstreamDir, "src", "plugins");
    const upFolderSet = new Set();

    if (fs.existsSync(upPluginsDir)) {
        for (const entry of fs.readdirSync(upPluginsDir, { withFileTypes: true })) {
            if (entry.name.startsWith("_") || entry.name === "index.ts") continue;
            const key = entry.name.toLowerCase();
            upFolderSet.add(key);
            const cur = metadata.folders[key];
            if (!cur || !cur.addedAt) {
                metadata.folders[key] = {
                    source: "vencord",
                    addedAt: upstreamTs || nowTs
                };
            } else if (cur.source !== "vencord") {
                metadata.folders[key] = { ...cur, source: "vencord" };
            }
        }
    }

    const localPluginsDir = path.join(vencordDir, "src", "plugins");
    const localFolderKeys = new Set();
    if (fs.existsSync(localPluginsDir)) {
        for (const entry of fs.readdirSync(localPluginsDir, { withFileTypes: true })) {
            if (entry.name.startsWith("_") || entry.name === "index.ts") continue;
            const key = entry.name.toLowerCase();
            localFolderKeys.add(key);
            if (!upFolderSet.has(key) && !metadata.folders[key]) {
                metadata.folders[key] = { source: "imcord", addedAt: nowTs };
            }
        }
    }

    // Remove obsolete upstream folders that no longer exist locally
    for (const [key, val] of Object.entries(metadata.folders)) {
        if (val?.source === "vencord" && !upFolderSet.has(key) && !localFolderKeys.has(key)) {
            delete metadata.folders[key];
        }
    }

    const userPluginsDir = path.join(rootDir, "userplugins");
    if (fs.existsSync(userPluginsDir)) {
        for (const file of fs.readdirSync(userPluginsDir)) {
            if (!file.endsWith(".js")) continue;
            const baseKey = file.replace(/\.js$/i, "").toLowerCase();
            if (!metadata.userPlugins[baseKey]) {
                metadata.userPlugins[baseKey] = { source: "imcord", addedAt: nowTs };
            }
            try {
                const code = fs.readFileSync(path.join(userPluginsDir, file), "utf8");
                const m = code.match(/name:\s*["'`]([^"'`]+)["'`]/);
                if (m) {
                    const nameKey = m[1].toLowerCase();
                    if (!metadata.userPlugins[nameKey]) {
                        metadata.userPlugins[nameKey] = {
                            source: "imcord",
                            addedAt: metadata.userPlugins[baseKey].addedAt
                        };
                    }
                }
            } catch { }
        }
    }

    const nextMetadata = {
        folders: sortEntries(metadata.folders),
        userPlugins: sortEntries(metadata.userPlugins)
    };
    const nextText = JSON.stringify(nextMetadata, null, 2) + "\n";
    let prevText = "";
    try {
        prevText = fs.readFileSync(metadataPath, "utf8").replace(/\r\n/g, "\n");
    } catch { }
    if (originalNormalized !== JSON.stringify(nextMetadata) || prevText !== nextText) {
        if (!dryRun) {
            fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
            fs.writeFileSync(metadataPath, nextText, "utf8");
        }
        return originalNormalized !== JSON.stringify(nextMetadata);
    }
    return false;
}

function main() {
    const args = process.argv.slice(2);
    const shouldFetch = args.includes("--fetch");
    const dryRun = args.includes("--dry-run");
    const pathArg = args.find(a => !a.startsWith("--"));

    let upstreamDir = pathArg;
    let tempCloneDir = null;
    let upstreamSha = "";
    let upstreamMsg = "";
    let upstreamTs = 0;

    try {
        if (shouldFetch) {
            tempCloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "imacord-upstream-"));
            console.log(`[iMCord AutoSync] Fetching upstream Vencord (${DEFAULT_UPSTREAM_REPO})...`);
            execFileSync("git", ["clone", "--depth", "1", "--single-branch", DEFAULT_UPSTREAM_REPO, tempCloneDir], {
                stdio: "inherit"
            });
            upstreamDir = tempCloneDir;
        }

        if (!upstreamDir || !fs.existsSync(upstreamDir)) {
            console.log("[iMCord AutoSync] Ready. Pass upstream path or --fetch to sync.");
            writeGithubOutput({ changed: "false", updated: 0, removed: 0 });
            return;
        }

        try {
            if (fs.existsSync(path.join(upstreamDir, ".git"))) {
                upstreamSha = execFileSync("git", ["-C", upstreamDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
                upstreamMsg = execFileSync("git", ["-C", upstreamDir, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();
                upstreamTs = Number(execFileSync("git", ["-C", upstreamDir, "log", "-1", "--pretty=%at"], { encoding: "utf8" }).trim()) || 0;
            }
        } catch {}

        const { updated, removed, overlaid } = syncFromDir(upstreamDir, { dryRun });
        const metaChanged = updatePluginMetadata(upstreamDir, upstreamTs, { dryRun });
        const changed = updated > 0 || removed > 0 || metaChanged;
        const shaSuffix = upstreamSha ? ` (${upstreamSha}: ${upstreamMsg})` : "";
        console.log(
            `[iMCord AutoSync]${dryRun ? " [DRY-RUN]" : ""} Synced ${updated} upstream Vencord files, removed ${removed} obsolete files, applied ${overlaid} overlay(s)${metaChanged ? ", updated plugin metadata" : ""}${shaSuffix}.`
        );

        writeGithubOutput({
            changed: String(changed),
            updated,
            removed,
            overlaid,
            upstream_sha: upstreamSha,
            upstream_msg: upstreamMsg
        });
    } finally {
        if (tempCloneDir) {
            fs.rmSync(tempCloneDir, { recursive: true, force: true });
        }
    }
}

main();

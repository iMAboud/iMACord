#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const vencordDir = path.join(rootDir, "Vencord-main");

// Protected iMACord custom and shimmed files that must never be overwritten blindly by upstream
const PROTECTED_FILES = new Set([
    "browser/VencordNativeStub.ts",
    "iMCord.ico",
    "package.json",
    "pnpm-workspace.yaml",
    "scripts/build/build.mjs",
    "scripts/build/common.mjs",
    "src/Vencord.ts",
    "src/VencordNative.ts",
    "src/api/Settings.ts",
    "src/api/UserPluginManager.ts",
    "src/api/index.ts",
    "src/components/BaseText.tsx",
    "src/components/Button.tsx",
    "src/components/FormSwitch.tsx",
    "src/components/Heading.tsx",
    "src/components/settings/AddonCard.css",
    "src/components/settings/AddonCard.tsx",
    "src/components/settings/tabs/plugins/ContributorModal.tsx",
    "src/components/settings/tabs/plugins/CustomPluginModal.tsx",
    "src/components/settings/tabs/plugins/PluginCard.tsx",
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
    "src/main/monacoWin.html",
    "src/main/settings.ts",
    "src/main/updater/http.ts",
    "src/main/utils/constants.ts",
    "src/plugins/_core/settings.tsx",
    "src/plugins/amongick/index.ts",
    "src/plugins/betterSettings/index.tsx",
    "src/plugins/copyFileContents/index.tsx",
    "src/plugins/fakeNitro/index.tsx",
    "src/plugins/iMAMenu/index.ts",
    "src/plugins/memberCount/MemberCount.tsx",
    "src/plugins/memberCount/index.tsx",
    "src/plugins/multiStreamPopout/index.tsx",
    "src/plugins/vencordToolbox/index.tsx",
    "src/plugins/vencordToolbox/menu.tsx",
    "src/shared/IpcEvents.ts",
    "src/utils/constants.ts",
    "src/webpack/common/components.ts",
    "src/webpack/common/utils.ts"
].map(p => p.toLowerCase()));

function isProtected(rel) {
    return PROTECTED_FILES.has(rel.toLowerCase());
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

const upstreamArg = process.argv[2];
if (upstreamArg && fs.existsSync(upstreamArg)) {
    const upFiles = walk(upstreamArg);
    const localFiles = walk(vencordDir);

    let updated = 0;
    for (const [rel, buf] of Object.entries(upFiles)) {
        if (isProtected(rel)) continue;
        const dest = path.join(vencordDir, rel);
        const cur = localFiles[rel];
        if (!cur || !cur.equals(buf)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, buf);
            updated++;
        }
    }

    let removed = 0;
    for (const rel of Object.keys(localFiles)) {
        if (!upFiles[rel] && !isProtected(rel)) {
            fs.rmSync(path.join(vencordDir, rel), { force: true });
            removed++;
        }
    }
    removeEmptyDirs(vencordDir);

    console.log(`[iMCord AutoSync] Synced ${updated} upstream Vencord files, removed ${removed} obsolete files.`);
} else {
    console.log("[iMCord AutoSync] Ready. Pass upstream path to sync.");
}

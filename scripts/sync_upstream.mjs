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
const DEFAULT_EQUICORD_REPO = process.env.EQUICORD_REPO || "https://github.com/Equicord/Equicord.git";

// Equicord-only APIs/components/utilities synced directly from Equicord/Equicord.
// Protected from Vencord upstream deletion and kept auto-updated from Equicord.
const EQUICORD_MANAGED_FILES = [
    "packages/discord-types/enums/quests.ts",
    "src/api/AudioPlayer.ts",
    "src/api/HeaderBar.tsx",
    "src/api/NicknameIcons.tsx",
    "src/api/ProfileCollections.tsx",
    "src/api/ProfileSections.tsx",
    "src/api/SurfaceClasses.ts",
    "src/api/UserArea.tsx",
    "src/api/UserSettingDefinitions.ts",
    "src/components/Badge.css",
    "src/components/Badge.tsx",
    "src/components/Icons.tsx",
    "src/components/Link.css",
    "src/components/Notice.css",
    "src/components/Notice.tsx",
    "src/components/ServerListItem.css",
    "src/components/ServerListItem.tsx",
    "src/plugins/_api/nicknameIcons.ts",
    "src/utils/csp.ts"
];

// Protected iMACord custom and shimmed files that must never be overwritten blindly by Vencord upstream.
// Keep Vencord-authored plugins (e.g. fakeNitro, copyFileContents) unprotected so they auto-update.
const PROTECTED_FILES = new Set([
    "browser/VencordNativeStub.ts",
    "iMCord.ico",
    "scripts/build/build.mjs",
    "scripts/build/buildWeb.mjs",
    "scripts/build/common.mjs",
    "scripts/pluginMetadata.json",
    "src/Vencord.ts",
    "src/VencordNative.ts",
    "src/api/ChatButtons.tsx",
    "src/api/PluginManager.ts",
    "src/api/ServerList.tsx",
    "src/api/Settings.ts",
    "src/api/UserPluginManager.ts",
    "src/api/index.ts",
    "src/components/BaseText.tsx",
    "src/components/Button.tsx",
    "src/components/FormSwitch.tsx",
    "src/components/Heading.tsx",
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
    "src/globals.d.ts",
    "src/main/ipcMain.ts",
    "src/main/settings.ts",
    "src/main/updater/http.ts",
    "src/main/utils/constants.ts",
    "src/modules.d.ts",
    "src/plugins/_api/chatButtons.ts",
    "src/plugins/_api/serverList.ts",
    "src/plugins/_core/settings.tsx",
    "src/plugins/_core/supportHelper.tsx",
    "src/plugins/amongick/index.ts",
    "src/plugins/betterSettings/index.tsx",
    "src/plugins/iMAMenu/index.ts",
    "src/plugins/memberCount/MemberCount.tsx",
    "src/plugins/memberCount/index.tsx",
    "src/plugins/multiStreamPopout/index.tsx",
    "src/plugins/vencordToolbox/index.tsx",
    "src/plugins/vencordToolbox/menu.tsx",
    "src/shared/IpcEvents.ts",
    "src/shared/vencordUserAgent.ts",
    "src/utils/clipboard.ts",
    "src/utils/dependencies.ts",
    "src/utils/misc.ts",
    "src/utils/native.ts",
    "src/utils/pluginTargets.ts",
    "src/utils/react.tsx",
    "src/utils/text.ts",
    "src/utils/types.ts",
    "src/webpack/common/components.ts",
    "src/webpack/common/stores.ts",
    "src/webpack/common/utils.ts",
    ...EQUICORD_MANAGED_FILES
].map(p => p.toLowerCase()));

const PROTECTED_PREFIXES = ["src/equicordplugins/"];

// Equicord meta/duplicate plugins excluded to avoid duplicating Vencord/iMCord features.
const EXCLUDED_EQUICORD_PLUGINS = new Set([
    "equicordhelper",
    "equicordtoolbox",
    "newpluginsmanager"
]);

const TEXT_EXTS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".css", ".json", ".yml", ".yaml", ".md", ".html", ".svg", ".txt", ""
]);

function isProtected(rel) {
    const low = rel.toLowerCase();
    if (PROTECTED_FILES.has(low)) return true;
    return PROTECTED_PREFIXES.some(prefix => low.startsWith(prefix));
}

function contentEquals(a, b, rel) {
    if (a.equals(b)) return true;
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXTS.has(ext) && !rel.startsWith(".")) return false;
    return a.toString("utf8").replace(/\r\n/g, "\n") === b.toString("utf8").replace(/\r\n/g, "\n");
}

function walk(dir, root = dir, res = {}) {
    if (!fs.existsSync(dir)) return res;
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

const PluginDefNameRx = /definePlugin\(\s*\{\s*(?:["'])?name(?:["'])?\s*:\s*(["'`])(.+?)\1/;
const PluginDefFallbackNameRx = /definePlugin\([\s\S]{0,600}?\bname\s*:\s*(["'`])(.+?)\1/;

function resolvePluginNameSync(baseDir, entryName) {
    const full = path.join(baseDir, entryName);
    if (!fs.existsSync(full)) return null;
    let content = "";
    const st = fs.statSync(full);
    if (st.isFile()) {
        content = fs.readFileSync(full, "utf8");
    } else {
        for (const f of ["index.ts", "index.tsx"]) {
            const candidate = path.join(full, f);
            if (fs.existsSync(candidate)) {
                content = fs.readFileSync(candidate, "utf8");
                break;
            }
        }
    }
    if (!content) return null;
    return PluginDefNameRx.exec(content)?.[2] ?? PluginDefFallbackNameRx.exec(content)?.[2] ?? null;
}

function applyConstantsOverlay(buf, equicordDir) {
    let src = buf.toString("utf8");
    const nl = src.includes("\r\n") ? "\r\n" : "\n";

    // 1. Ensure Devs.iMAboud exists
    if (!/\biMAboud\s*:/.test(src)) {
        const anchor = "export const Devs = /* #__PURE__*/ Object.freeze({";
        const idx = src.indexOf(anchor);
        if (idx === -1) {
            throw new Error("[iMCord AutoSync] Failed to locate Devs object in src/utils/constants.ts");
        }
        const entry = `${nl}    iMAboud: {${nl}        name: "iMAboud",${nl}        id: 0n${nl}    },`;
        src = src.slice(0, idx + anchor.length) + entry + src.slice(idx + anchor.length);
    }

    // 2. Merge Equicord constants & EquicordDevs when Equicord source is available
    const eqConstPath = equicordDir ? path.join(equicordDir, "src", "utils", "constants.ts") : null;
    if (eqConstPath && fs.existsSync(eqConstPath) && !/\bexport const EquicordDevs\b/.test(src)) {
        const eqSrc = fs.readFileSync(eqConstPath, "utf8").replace(/\r\n/g, "\n");

        const eqConstLines = [];
        const wantedConsts = [
            "GUILD_ID",
            "EQUICORD_TEAM",
            "EQUICORD_HELPERS",
            "VENCORD_CONTRIB_ROLE_ID",
            "EQUIBOT_USER_ID",
            "VC_SUPPORT_CHANNEL_ID",
            "VC_GUILD_ID",
            "VC_DONOR_ROLE_ID",
            "VC_CONTRIB_ROLE_ID",
            "VC_REGULAR_ROLE_ID",
            "VC_SUPPORT_CATEGORY_ID",
            "VC_KNOWN_ISSUES_CHANNEL_ID",
            "VESKTOP_SUPPORT_CHANNEL_ID",
            "VC_SUPPORT_CHANNEL_IDS",
            "GUILD_IDS",
            "SUPPORT_CHANNEL_IDS",
            "DONOR_ROLE_IDS",
            "CONTRIB_ROLE_IDS",
            "KNOWN_ISSUES_CHANNEL_IDS"
        ];
        for (const name of wantedConsts) {
            if (new RegExp(`\\bexport const ${name}\\b`).test(src)) continue;
            const m = eqSrc.match(new RegExp(`^export const ${name}\\s*=.*$`, "m"));
            if (m) eqConstLines.push(m[0]);
        }

        const eqDevsStart = eqSrc.indexOf("export const EquicordDevs =");
        const eqDevsEndAnchor = "} satisfies Record<string, Dev>);";
        const eqDevsEnd = eqDevsStart !== -1 ? eqSrc.indexOf(eqDevsEndAnchor, eqDevsStart) : -1;

        if (eqDevsStart !== -1 && eqDevsEnd !== -1) {
            const eqDevsBlock = eqSrc.slice(eqDevsStart, eqDevsEnd + eqDevsEndAnchor.length);
            const extraBlock = [
                "",
                "// Equicord compatibility constants & contributors (auto-synced from Equicord/Equicord)",
                ...eqConstLines,
                "",
                eqDevsBlock,
                "",
                "export const VencordDevsById = DevsById;",
                "export const EquicordDevsById = /* #__PURE__*/ (() =>",
                "    Object.freeze(Object.fromEntries(",
                "        Object.entries(EquicordDevs)",
                "            .filter(d => d[1].id !== 0n)",
                "            .map(([_, v]) => [v.id, v] as const)",
                "    ))",
                ")() as Record<string, Dev>;",
                ""
            ].join(nl);
            src = src.trimEnd() + nl + extraBlock;
        }
    }

    return Buffer.from(src, "utf8");
}

function applyTsconfigOverlay(buf) {
    const src = buf.toString("utf8");
    if (src.includes('"@equicordplugins/*"')) return buf;
    const nl = src.includes("\r\n") ? "\r\n" : "\n";
    const patched = src.replace(
        /("@webpack\/types"\s*:\s*\["\.\/src\/webpack\/types"\])/,
        `$1,${nl}            "@equicordplugins/*": ["./src/equicordplugins/*"]`
    );
    return Buffer.from(patched, "utf8");
}

function applyPackageJsonOverlay(buf, equicordDir) {
    const eqPkgPath = equicordDir ? path.join(equicordDir, "package.json") : null;
    if (!eqPkgPath || !fs.existsSync(eqPkgPath)) return buf;

    const vcPkg = JSON.parse(buf.toString("utf8"));
    const eqPkg = JSON.parse(fs.readFileSync(eqPkgPath, "utf8"));
    let changed = false;

    vcPkg.dependencies ??= {};
    for (const [dep, ver] of Object.entries(eqPkg.dependencies ?? {})) {
        if (!(dep in vcPkg.dependencies)) {
            vcPkg.dependencies[dep] = ver;
            changed = true;
        }
    }

    vcPkg.devDependencies ??= {};
    if (eqPkg.devDependencies?.md5 && !("md5" in vcPkg.devDependencies)) {
        vcPkg.devDependencies.md5 = eqPkg.devDependencies.md5;
        changed = true;
    }

    if (!changed) return buf;

    const sortObj = obj => Object.fromEntries(
        Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
    vcPkg.dependencies = sortObj(vcPkg.dependencies);
    vcPkg.devDependencies = sortObj(vcPkg.devDependencies);
    return Buffer.from(JSON.stringify(vcPkg, null, 4) + "\n", "utf8");
}

function applyWorkspaceYamlOverlay(buf, equicordDir) {
    const eqYamlPath = equicordDir ? path.join(equicordDir, "pnpm-workspace.yaml") : null;
    if (!eqYamlPath || !fs.existsSync(eqYamlPath)) return buf;

    let vcYaml = buf.toString("utf8").replace(/\r\n/g, "\n");
    const eqYaml = fs.readFileSync(eqYamlPath, "utf8").replace(/\r\n/g, "\n");

    const parseCatalog = text => {
        const m = text.match(/^catalog:\n((?:    .+\n?)+)/m);
        if (!m) return { block: "", entries: [] };
        const entries = [];
        for (const line of m[1].split("\n")) {
            const em = line.match(/^    ("?[^":]+"?)\s*:\s*(.+)$/);
            if (em) entries.push({ key: em[1].replace(/^"|"$/g, ""), line });
        }
        return { block: m[1], entries };
    };

    const vcCat = parseCatalog(vcYaml);
    const eqCat = parseCatalog(eqYaml);
    const vcKeys = new Set(vcCat.entries.map(e => e.key));
    const missingLines = eqCat.entries.filter(e => !vcKeys.has(e.key)).map(e => e.line);

    if (missingLines.length > 0 && vcCat.block) {
        const replacement = vcCat.block.trimEnd() + "\n" + missingLines.join("\n") + "\n";
        vcYaml = vcYaml.replace(vcCat.block, replacement);
    }

    for (const excl of ['"@song-spotlight/api"', '"@equicord/*"']) {
        if (vcYaml.includes("minimumReleaseAgeExclude:") && !vcYaml.includes(excl)) {
            vcYaml = vcYaml.replace(/minimumReleaseAgeExclude:\n/, `minimumReleaseAgeExclude:\n    - ${excl}\n`);
        }
    }

    return Buffer.from(vcYaml, "utf8");
}

function applyCspOverlay(buf, equicordDir) {
    const eqCspPath = equicordDir ? path.join(equicordDir, "src", "main", "csp", "index.ts") : null;
    if (!eqCspPath || !fs.existsSync(eqCspPath)) return buf;

    let vcSrc = buf.toString("utf8").replace(/\r\n/g, "\n");
    const eqSrc = fs.readFileSync(eqCspPath, "utf8").replace(/\r\n/g, "\n");

    const extractPolicies = text => {
        const start = text.indexOf("export const CspPolicies: PolicyMap = {");
        if (start === -1) return { entries: [], endIdx: -1 };
        const end = text.indexOf("\n};", start);
        if (end === -1) return { entries: [], endIdx: -1 };
        const body = text.slice(start, end);
        const entries = [];
        for (const line of body.split("\n")) {
            const m = line.match(/^\s*"([^"]+)"\s*:\s*([^,\n]+),?(.*)$/);
            if (m) entries.push({ host: m[1], line: `    "${m[1]}": ${m[2].trim()},${m[3] || ""}` });
        }
        return { entries, endIdx: end };
    };

    const vcPol = extractPolicies(vcSrc);
    const eqPol = extractPolicies(eqSrc);
    if (vcPol.endIdx === -1 || eqPol.entries.length === 0) return buf;

    const vcHosts = new Set(vcPol.entries.map(e => e.host));
    const missing = eqPol.entries.filter(e => !vcHosts.has(e.host));
    if (missing.length === 0) return buf;

    const needsImageMediaAndCss = missing.some(e => e.line.includes("ImageMediaAndCssSrc"));
    if (needsImageMediaAndCss && !vcSrc.includes("ImageMediaAndCssSrc")) {
        vcSrc = vcSrc.replace(
            /(export const ImageScriptsAndCssSrc = .*;\n)/,
            "$1export const ImageMediaAndCssSrc = [...ImageAndMediaSrc, ...CssSrc];\n"
        );
    }

    const updatedEnd = vcSrc.indexOf("\n};", vcSrc.indexOf("export const CspPolicies: PolicyMap = {"));
    const insertBlock = "\n    // Equicord plugin domains (auto-synced from Equicord/Equicord)\n" +
        missing.map(e => e.line).join("\n");
    vcSrc = vcSrc.slice(0, updatedEnd) + insertBlock + vcSrc.slice(updatedEnd);

    return Buffer.from(vcSrc, "utf8");
}

function applyEquicordPluginPatch(rel, buf) {
    if (rel.toLowerCase() === "src/equicordplugins/savefavoritegifs/index.tsx") {
        const src = buf.toString("utf8")
            .replace(
                'import equicordToolbox from "@equicordplugins/equicordToolbox";',
                'import vencordToolbox from "@plugins/vencordToolbox";'
            )
            .replace(/equicordToolbox\.name/g, "vencordToolbox.name");
        return Buffer.from(src, "utf8");
    }
    return buf;
}

function writeGithubOutput(values) {
    const outPath = process.env.GITHUB_OUTPUT;
    if (!outPath) return;
    const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`);
    fs.appendFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function applyExportOverlay(buf, patterns) {
    let src = buf.toString("utf8");
    for (const [rx, repl] of patterns) {
        src = src.replace(rx, repl);
    }
    return Buffer.from(src, "utf8");
}

function applyEnumsIndexOverlay(buf) {
    const src = buf.toString("utf8");
    if (src.includes("./quests")) return buf;
    const nl = src.includes("\r\n") ? "\r\n" : "\n";
    return Buffer.from(src.trimEnd() + nl + 'export * from "./quests";' + nl, "utf8");
}

function syncFromDir(upstreamDir, equicordDir, { dryRun = false } = {}) {
    const upFiles = walk(upstreamDir);
    if (Object.keys(upFiles).length === 0) {
        throw new Error(`Upstream directory has no files to sync: ${upstreamDir}`);
    }
    const localFiles = walk(vencordDir);
    let overlaid = 0;

    const overlays = [
        ["src/utils/constants.ts", b => applyConstantsOverlay(b, equicordDir)],
        ["tsconfig.json", b => applyTsconfigOverlay(b)],
        ["package.json", b => applyPackageJsonOverlay(b, equicordDir)],
        ["pnpm-workspace.yaml", b => applyWorkspaceYamlOverlay(b, equicordDir)],
        ["src/main/csp/index.ts", b => applyCspOverlay(b, equicordDir)],
        ["packages/discord-types/enums/index.ts", b => applyEnumsIndexOverlay(b)],
        ["src/plugins/reviewDB/components/ReviewModal.tsx", b => applyExportOverlay(b, [[/^const (Paginator|requirePaginator)\b/gm, "export const $1"]])],
        ["src/plugins/anonymiseFileNames/index.tsx", b => applyExportOverlay(b, [[/^const tarExtMatcher\b/m, "export const tarExtMatcher"]])],
        ["src/plugins/_api/badges/index.tsx", b => applyExportOverlay(b, [[/^function BadgeContextMenu\b/m, "export function BadgeContextMenu"]])]
    ];
    for (const [rel, fn] of overlays) {
        if (upFiles[rel]) {
            const transformed = fn(upFiles[rel]);
            if (!transformed.equals(upFiles[rel])) overlaid++;
            upFiles[rel] = transformed;
        }
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

function collectExistingPluginIdentifiers() {
    const folderSet = new Set();
    const nameSet = new Set();

    const vcPluginsDir = path.join(vencordDir, "src", "plugins");
    if (fs.existsSync(vcPluginsDir)) {
        for (const entry of fs.readdirSync(vcPluginsDir)) {
            if (entry.startsWith("_") || entry.startsWith(".") || entry === "index.ts") continue;
            folderSet.add(entry.toLowerCase());
            const pluginName = resolvePluginNameSync(vcPluginsDir, entry);
            if (pluginName) nameSet.add(pluginName.toLowerCase());
        }
    }

    const userPluginsDir = path.join(rootDir, "userplugins");
    if (fs.existsSync(userPluginsDir)) {
        for (const file of fs.readdirSync(userPluginsDir)) {
            if (!file.endsWith(".js")) continue;
            folderSet.add(file.replace(/\.js$/i, "").toLowerCase());
            const pluginName = resolvePluginNameSync(userPluginsDir, file);
            if (pluginName) nameSet.add(pluginName.toLowerCase());
        }
    }

    return { folderSet, nameSet };
}

function syncEquicordFromDir(equicordDir, { dryRun = false } = {}) {
    if (!equicordDir || !fs.existsSync(equicordDir)) {
        return { eqUpdated: 0, eqRemoved: 0, eqSkippedDups: 0, activeEquicordFolders: new Set() };
    }

    const { folderSet: existingFolders, nameSet: existingNames } = collectExistingPluginIdentifiers();
    const seenEqNames = new Set();
    const activeEquicordFolders = new Set();
    const desiredFiles = {};
    let eqSkippedDups = 0;

    // 1. Sync Equicord-managed shared API/component/util files
    for (const rel of EQUICORD_MANAGED_FILES) {
        const srcPath = path.join(equicordDir, rel);
        if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
            desiredFiles[rel] = fs.readFileSync(srcPath);
        }
    }

    // 2. Sync src/equicordplugins/_api and src/equicordplugins/_core
    const eqPluginsRoot = path.join(equicordDir, "src", "equicordplugins");
    for (const internalDir of ["_api", "_core"]) {
        const dirPath = path.join(eqPluginsRoot, internalDir);
        if (!fs.existsSync(dirPath)) continue;
        const walked = walk(dirPath, equicordDir);
        for (const [rel, buf] of Object.entries(walked)) {
            desiredFiles[rel] = buf;
        }
    }

    // 3. Sync unique non-duplicate Equicord plugins
    if (fs.existsSync(eqPluginsRoot)) {
        const entries = fs.readdirSync(eqPluginsRoot).sort((a, b) => a.localeCompare(b));
        for (const entry of entries) {
            if (entry.startsWith("_") || entry.startsWith(".") || entry === "index.ts") continue;
            const low = entry.toLowerCase();
            const baseNoExt = low.replace(/\.(tsx?|jsx?)$/, "");

            if (EXCLUDED_EQUICORD_PLUGINS.has(baseNoExt)) {
                eqSkippedDups++;
                continue;
            }
            if (low.endsWith(".dev") || low.endsWith(".equibop")) {
                continue;
            }
            if (existingFolders.has(low) || existingFolders.has(baseNoExt)) {
                eqSkippedDups++;
                continue;
            }

            const pluginName = resolvePluginNameSync(eqPluginsRoot, entry);
            if (pluginName) {
                const nameKey = pluginName.toLowerCase();
                if (existingNames.has(nameKey) || seenEqNames.has(nameKey)) {
                    eqSkippedDups++;
                    continue;
                }
                seenEqNames.add(nameKey);
            }

            activeEquicordFolders.add(low);
            const fullEntryPath = path.join(eqPluginsRoot, entry);
            if (fs.statSync(fullEntryPath).isDirectory()) {
                const walked = walk(fullEntryPath, equicordDir);
                for (const [rel, buf] of Object.entries(walked)) {
                    desiredFiles[rel] = applyEquicordPluginPatch(rel, buf);
                }
            } else {
                const rel = path.relative(equicordDir, fullEntryPath).replace(/\\/g, "/");
                desiredFiles[rel] = applyEquicordPluginPatch(rel, fs.readFileSync(fullEntryPath));
            }
        }
    }

    // Apply Equicord file updates
    let eqUpdated = 0;
    for (const [rel, buf] of Object.entries(desiredFiles)) {
        const dest = path.join(vencordDir, rel);
        const cur = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
        if (!cur || !contentEquals(cur, buf, rel)) {
            if (!dryRun) {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, buf);
            }
            eqUpdated++;
        }
    }

    // Remove obsolete files in Vencord-main/src/equicordplugins/
    let eqRemoved = 0;
    const localEqDir = path.join(vencordDir, "src", "equicordplugins");
    if (fs.existsSync(localEqDir)) {
        const localEqFiles = walk(localEqDir, vencordDir);
        for (const rel of Object.keys(localEqFiles)) {
            if (!desiredFiles[rel]) {
                if (!dryRun) fs.rmSync(path.join(vencordDir, rel), { force: true });
                eqRemoved++;
            }
        }
        if (!dryRun) removeEmptyDirs(localEqDir);
    }

    return { eqUpdated, eqRemoved, eqSkippedDups, activeEquicordFolders };
}

function updatePluginMetadata(upstreamDir, upstreamTs, equicordDir, equicordTs, activeEquicordFolders, { dryRun = false } = {}) {
    const metadataPath = path.join(vencordDir, "scripts", "pluginMetadata.json");
    let metadata = { folders: {}, equicordFolders: {}, userPlugins: {} };
    try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch { }
    metadata.folders ??= {};
    metadata.equicordFolders ??= {};
    metadata.userPlugins ??= {};

    const sortEntries = obj => Object.fromEntries(
        Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
    const originalNormalized = JSON.stringify({
        folders: sortEntries(metadata.folders),
        equicordFolders: sortEntries(metadata.equicordFolders),
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

    for (const [key, val] of Object.entries(metadata.folders)) {
        if (val?.source === "vencord" && !upFolderSet.has(key) && !localFolderKeys.has(key)) {
            delete metadata.folders[key];
        }
    }

    // Update Equicord plugin metadata (preserving historical creation timestamps)
    if (equicordDir && activeEquicordFolders) {
        for (const key of activeEquicordFolders) {
            const cur = metadata.equicordFolders[key];
            if (!cur || !cur.addedAt) {
                metadata.equicordFolders[key] = {
                    source: "equicord",
                    addedAt: equicordTs || nowTs
                };
            } else if (cur.source !== "equicord") {
                metadata.equicordFolders[key] = { ...cur, source: "equicord" };
            }
        }
        for (const key of Object.keys(metadata.equicordFolders)) {
            if (!activeEquicordFolders.has(key)) {
                delete metadata.equicordFolders[key];
            }
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
        equicordFolders: sortEntries(metadata.equicordFolders),
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

function readGitHeadInfo(dir) {
    let sha = "";
    let msg = "";
    let ts = 0;
    try {
        if (dir && fs.existsSync(path.join(dir, ".git"))) {
            sha = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
            msg = execFileSync("git", ["-C", dir, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();
            ts = Number(execFileSync("git", ["-C", dir, "log", "-1", "--pretty=%at"], { encoding: "utf8" }).trim()) || 0;
        }
    } catch { }
    return { sha, msg, ts };
}

function main() {
    const args = process.argv.slice(2);
    const shouldFetch = args.includes("--fetch");
    const dryRun = args.includes("--dry-run");
    const eqArg = args.find(a => a.startsWith("--equicord="))?.slice("--equicord=".length);
    const pathArg = args.find(a => !a.startsWith("--"));

    let upstreamDir = pathArg;
    let equicordDir = eqArg;
    let tempCloneDir = null;
    let tempEqCloneDir = null;

    try {
        if (shouldFetch) {
            if (!upstreamDir) {
                tempCloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "imacord-upstream-"));
                console.log(`[iMCord AutoSync] Fetching upstream Vencord (${DEFAULT_UPSTREAM_REPO})...`);
                execFileSync("git", ["clone", "--depth", "1", "--single-branch", DEFAULT_UPSTREAM_REPO, tempCloneDir], {
                    stdio: "inherit"
                });
                upstreamDir = tempCloneDir;
            }
            if (!equicordDir) {
                tempEqCloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "imacord-equicord-"));
                console.log(`[iMCord AutoSync] Fetching upstream Equicord (${DEFAULT_EQUICORD_REPO})...`);
                execFileSync("git", ["clone", "--depth", "1", "--single-branch", DEFAULT_EQUICORD_REPO, tempEqCloneDir], {
                    stdio: "inherit"
                });
                equicordDir = tempEqCloneDir;
            }
        }

        if (!upstreamDir || !fs.existsSync(upstreamDir)) {
            console.log("[iMCord AutoSync] Ready. Pass upstream path or --fetch to sync.");
            writeGithubOutput({ changed: "false", updated: 0, removed: 0 });
            return;
        }

        const vcHead = readGitHeadInfo(upstreamDir);
        const eqHead = readGitHeadInfo(equicordDir);

        const { updated, removed, overlaid } = syncFromDir(upstreamDir, equicordDir, { dryRun });
        const { eqUpdated, eqRemoved, eqSkippedDups, activeEquicordFolders } = syncEquicordFromDir(equicordDir, { dryRun });
        const metaChanged = updatePluginMetadata(
            upstreamDir,
            vcHead.ts,
            equicordDir,
            eqHead.ts,
            activeEquicordFolders,
            { dryRun }
        );

        const totalUpdated = updated + eqUpdated;
        const totalRemoved = removed + eqRemoved;
        const changed = totalUpdated > 0 || totalRemoved > 0 || metaChanged;

        const vcSuffix = vcHead.sha ? ` Vencord(${vcHead.sha}: ${vcHead.msg})` : "";
        const eqSuffix = eqHead.sha ? ` Equicord(${eqHead.sha}: ${eqHead.msg})` : "";
        console.log(
            `[iMCord AutoSync]${dryRun ? " [DRY-RUN]" : ""} Synced ${updated} Vencord + ${eqUpdated} Equicord files, removed ${removed} Vencord + ${eqRemoved} Equicord obsolete files, skipped ${eqSkippedDups} duplicate/meta Equicord plugins, applied ${overlaid} overlay(s)${metaChanged ? ", updated plugin metadata" : ""}.${vcSuffix}${eqSuffix}`
        );

        writeGithubOutput({
            changed: String(changed),
            updated: totalUpdated,
            removed: totalRemoved,
            overlaid,
            upstream_sha: vcHead.sha,
            upstream_msg: vcHead.msg,
            equicord_sha: eqHead.sha,
            equicord_msg: eqHead.msg
        });
    } finally {
        if (tempCloneDir) {
            fs.rmSync(tempCloneDir, { recursive: true, force: true });
        }
        if (tempEqCloneDir) {
            fs.rmSync(tempEqCloneDir, { recursive: true, force: true });
        }
    }
}

main();

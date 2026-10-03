import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function sha256(data) {
    return createHash("sha256").update(data).digest("hex").toLowerCase();
}

const rootDir = process.cwd();
const distDir = join(rootDir, "Vencord-main", "dist");
const userpluginsDir = join(rootDir, "userplugins");

// Fetch previous release manifest for diffing
let prevManifest = null;
const repo = process.env.GITHUB_REPOSITORY ?? "iMAboud/iMACord";
try {
    const res = await fetch(`https://github.com/${repo}/releases/latest/download/manifest.json`, {
        headers: { "User-Agent": "iMCord-Builder" }
    });
    if (res.ok) {
        prevManifest = await res.json();
    }
} catch {}

let localManifest = null;
const localManifestPath = join(userpluginsDir, "manifest.json");
if (existsSync(localManifestPath)) {
    try {
        localManifest = JSON.parse(readFileSync(localManifestPath, "utf8"));
    } catch {}
}
prevManifest ??= localManifest;

const tag = process.env.TAG_NAME;
const assetUrl = file => tag ? `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(file)}` : undefined;

const manifest = {
    version: tag ?? process.env.GITHUB_REF_NAME ?? "1.0.0",
    updatedAt: new Date().toISOString(),
    dist: {},
    plugins: {},
    removedPlugins: []
};

// All assets ship in every release: clients on any older version resolve files via releases/latest
const releaseFiles = [
    "iMCord.exe",
    "iMCordCLI.exe",
    "iMCord.ico"
];

// 1. Process Core Vencord dist files
const distFiles = ["renderer.js", "renderer.css", "patcher.js", "preload.js"];
for (const file of distFiles) {
    const fullPath = join(distDir, file);
    if (!existsSync(fullPath)) {
        console.error(`[ERROR] Missing core file: ${file}`);
        process.exit(1);
    }
    const buf = readFileSync(fullPath);
    const hash = sha256(buf);
    const url = assetUrl(file);
    manifest.dist[file] = {
        hash,
        size: buf.length,
        ...(url ? { url } : {})
    };
    releaseFiles.push(`Vencord-main/dist/${file}`);

    const prevHash = prevManifest?.dist?.[file]?.hash;
    console.log(`[${prevHash?.toLowerCase() === hash ? "Unchanged" : "Changed"}] Core file: ${file}`);
}

// 2. Process User Plugins
if (existsSync(userpluginsDir)) {
    const pluginFiles = readdirSync(userpluginsDir).filter(f => f.endsWith(".js"));
    for (const file of pluginFiles) {
        const fullPath = join(userpluginsDir, file);
        const buf = readFileSync(fullPath);
        const hash = sha256(buf);

        let author = "iMAboud";
        let commit = undefined;
        let message = undefined;
        try {
            const logOut = execSync(`git log -1 --format="%h|%an|%s" -- "${fullPath}"`, { encoding: "utf8" }).trim();
            if (logOut) {
                const parts = logOut.split("|");
                commit = parts[0];
                author = parts[1] || author;
                message = parts.slice(2).join("|");
            }
        } catch {}

        const url = assetUrl(file);
        manifest.plugins[file] = {
            hash,
            size: buf.length,
            author,
            ...(commit ? { commit } : {}),
            ...(message ? { message } : {}),
            ...(url ? { url } : {})
        };
        releaseFiles.push(`userplugins/${file}`);

        const prevHash = prevManifest?.plugins?.[file]?.hash;
        console.log(`[${prevHash?.toLowerCase() === hash ? "Unchanged" : "Changed"}] Plugin: ${file}`);
    }
}

// 3. Track removed plugins cumulatively so clients delete them
const removed = new Set([
    "DiscordDebloater.js",
    ...(prevManifest?.removedPlugins ?? []),
    ...(localManifest?.removedPlugins ?? []),
    ...Object.keys(prevManifest?.plugins ?? {})
]);
manifest.removedPlugins = [...removed].filter(f => !manifest.plugins[f]).sort();
for (const f of manifest.removedPlugins) console.log(`[Removed] Plugin: ${f}`);

// Manifest last so it is uploaded after the files it references
releaseFiles.push("userplugins/manifest.json");

const json = JSON.stringify(manifest, null, 2);
writeFileSync(join(userpluginsDir, "manifest.json"), json, "utf8");
if (existsSync(distDir)) {
    writeFileSync(join(distDir, "manifest.json"), json, "utf8");
}

console.log("\n[OK] Generated manifest.json successfully!");
console.log("[Release Assets to upload]:");
for (const f of releaseFiles) {
    console.log(`  - ${f}`);
}

writeFileSync(join(rootDir, "release_files.txt"), releaseFiles.join("\n"), "utf8");
if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `RELEASE_FILES<<EOF\n${releaseFiles.join("\n")}\nEOF\n`);
}

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function sha256(data) {
    if (Buffer.isBuffer(data)) {
        const str = data.toString("utf8");
        if (!str.includes("\0")) {
            return createHash("sha256").update(str.replace(/\r\n/g, "\n"), "utf8").digest("hex").toLowerCase();
        }
    } else if (typeof data === "string") {
        return createHash("sha256").update(data.replace(/\r\n/g, "\n"), "utf8").digest("hex").toLowerCase();
    }
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

if (!prevManifest) {
    const localManifestPath = join(userpluginsDir, "manifest.json");
    if (existsSync(localManifestPath)) {
        try {
            prevManifest = JSON.parse(readFileSync(localManifestPath, "utf8"));
        } catch {}
    }
}

const manifest = {
    version: process.env.GITHUB_REF_NAME ?? "1.0.0",
    updatedAt: new Date().toISOString(),
    dist: {},
    plugins: {}
};

const releaseFiles = [
    "iMCord.exe",
    "iMCordCLI.exe",
    "iMCord.ico",
    "userplugins/manifest.json"
];

// 1. Process Core Vencord dist files
const distFiles = ["renderer.js", "renderer.css", "patcher.js", "preload.js"];
for (const file of distFiles) {
    const fullPath = join(distDir, file);
    if (existsSync(fullPath)) {
        const buf = readFileSync(fullPath);
        const hash = sha256(buf);
        manifest.dist[file] = {
            hash,
            size: buf.length
        };

        const prevHash = prevManifest?.dist?.[file]?.hash;
        if (!prevHash || prevHash.toLowerCase() !== hash.toLowerCase()) {
            releaseFiles.push(`Vencord-main/dist/${file}`);
            console.log(`[Changed] Core file: ${file}`);
        } else {
            console.log(`[Unchanged] Core file: ${file}`);
        }
    }
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

        manifest.plugins[file] = {
            hash,
            size: buf.length,
            author,
            ...(commit ? { commit } : {}),
            ...(message ? { message } : {})
        };

        const prevHash = prevManifest?.plugins?.[file]?.hash;
        if (!prevHash || prevHash.toLowerCase() !== hash.toLowerCase()) {
            releaseFiles.push(`userplugins/${file}`);
            console.log(`[Changed] Plugin: ${file}`);
        } else {
            console.log(`[Unchanged] Plugin: ${file}`);
        }
    }
}

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

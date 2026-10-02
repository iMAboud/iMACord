import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

function sha256(data) {
    return createHash("sha256").update(data).digest("hex").toLowerCase();
}

const rootDir = process.cwd();
const distDir = join(rootDir, "Vencord-main", "dist");
const userpluginsDir = join(rootDir, "userplugins");

const manifest = {
    version: process.env.GITHUB_REF_NAME ?? "1.0.0",
    updatedAt: new Date().toISOString(),
    dist: {},
    plugins: {}
};

const distFiles = ["renderer.js", "renderer.css", "patcher.js", "preload.js"];
for (const file of distFiles) {
    const fullPath = join(distDir, file);
    if (existsSync(fullPath)) {
        const buf = readFileSync(fullPath);
        manifest.dist[file] = {
            hash: sha256(buf),
            size: buf.length
        };
    }
}

if (existsSync(userpluginsDir)) {
    const pluginFiles = readdirSync(userpluginsDir).filter(f => f.endsWith(".js"));
    for (const file of pluginFiles) {
        const fullPath = join(userpluginsDir, file);
        const buf = readFileSync(fullPath);
        manifest.plugins[file] = {
            hash: sha256(buf),
            size: buf.length,
            author: "iMAboud"
        };
    }
}

const json = JSON.stringify(manifest, null, 2);
writeFileSync(join(userpluginsDir, "manifest.json"), json, "utf8");
if (existsSync(distDir)) {
    writeFileSync(join(distDir, "manifest.json"), json, "utf8");
}

console.log("[OK] Generated manifest.json successfully!");

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";

const userpluginsDir = join(process.cwd(), "userplugins");
const manifestPath = join(userpluginsDir, "manifest.json");

const files = readdirSync(userpluginsDir).filter(f => f.endsWith(".js"));
const plugins = {};

for (const file of files) {
    const fullPath = join(userpluginsDir, file);
    const content = readFileSync(fullPath);
    const hash = createHash("sha256").update(content).digest("hex").toLowerCase();
    
    let commit = "base";
    let author = "iMAboud";
    let message = `Add ${file}`;

    try {
        const log = execSync(`git log -1 --format="%h|%an|%s" -- "userplugins/${file}"`, { encoding: "utf8" }).trim();
        if (log) {
            const parts = log.split("|");
            commit = parts[0] || commit;
            author = parts[1] || author;
            message = parts.slice(2).join("|") || message;
        }
    } catch {}

    plugins[file] = {
        hash,
        size: content.length,
        author,
        commit,
        message
    };
}

const manifest = {
    repo: "iMAboud/iMACord",
    updatedAt: new Date().toISOString(),
    plugins
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("Successfully generated userplugins/manifest.json with", Object.keys(plugins).length, "plugins");

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export const DIST_FILES = ["renderer.js", "renderer.css", "patcher.js", "preload.js"];

const TEXT_EXTENSIONS = new Set([".cs", ".js", ".css", ".json", ".mjs", ".txt", ".bat"]);

export function sha256Buffer(data) {
    return createHash("sha256").update(data).digest("hex").toLowerCase();
}

export function sha256File(filePath) {
    return sha256Buffer(readFileSync(filePath));
}

function readNormalized(filePath) {
    const buf = readFileSync(filePath);
    const dot = filePath.lastIndexOf(".");
    const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
    if (!TEXT_EXTENSIONS.has(ext)) return buf;
    return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function resolveIconPath(rootDir) {
    const rootIcon = join(rootDir, "iMCord.ico");
    if (existsSync(rootIcon)) return rootIcon;
    const srcIcon = join(rootDir, "installer_src", "iMCord.ico");
    if (existsSync(srcIcon)) return srcIcon;
    return null;
}

function hashInputs(rootDir, relPaths) {
    const hash = createHash("sha256");
    for (const rel of relPaths) {
        if (!rel) continue;
        const full = join(rootDir, rel);
        if (!existsSync(full)) continue;
        hash.update(rel.replace(/\\/g, "/"), "utf8");
        hash.update("\0", "utf8");
        hash.update(readNormalized(full));
        hash.update("\0", "utf8");
    }
    return hash.digest("hex").toLowerCase();
}

export function computeInstallerCodeHashes(rootDir) {
    const iconFull = resolveIconPath(rootDir);
    const iconRel = iconFull ? (iconFull === join(rootDir, "iMCord.ico") ? "iMCord.ico" : "installer_src/iMCord.ico") : null;

    return {
        guiCodeHash: hashInputs(rootDir, [
            "installer_src/InstallerCore.cs",
            "installer_src/UpdaterCore.cs",
            "installer_src/ProgramGui.cs",
            iconRel
        ]),
        cliCodeHash: hashInputs(rootDir, [
            "installer_src/InstallerCore.cs",
            "installer_src/UpdaterCore.cs",
            "installer_src/ProgramCli.cs",
            iconRel
        ])
    };
}

export function listPluginFiles(rootDir) {
    const dir = join(rootDir, "userplugins");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter(f => f.endsWith(".js") && !f.includes("/") && !f.includes("\\"))
        .sort((a, b) => a.localeCompare(b));
}

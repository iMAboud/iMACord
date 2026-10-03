/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { DIST_DIR, USER_PLUGINS_DIR } from "@main/utils/constants";
import { fetchBuffer, fetchJson } from "@main/utils/http";
import { IpcEvents } from "@shared/IpcEvents";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { createHash } from "crypto";
import { ipcMain } from "electron";
import { existsSync } from "fs";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { basename, join } from "path";

import { serializeErrors, VENCORD_FILES } from "./common";

const IMACORD_REPO = "iMAboud/iMACord";
const RAW_BASE = `https://raw.githubusercontent.com/${IMACORD_REPO}/main`;
const RELEASE_BASE = `https://github.com/${IMACORD_REPO}/releases/latest/download`;

// Core files must be written where they are actually loaded from (the dir containing patcher.js)
const CORE_DIR = __dirname;

const REQUEST_INIT: RequestInit = { headers: { "User-Agent": VENCORD_USER_AGENT } };

const BUILTIN_PLUGIN_HASHES: Record<string, string> = {
    "amongick.js": "58b2cd8bb1068e0e79cdb5315670f91abb4ece49197f1b3b466c5c1731607482",
    "iMAMenu.js": "2d30028f95bf0a02bb51866e9137837feaff0f501ec1bcef773484828d64bbea",
    "MultiStreamPopout.js": "fcc7de78b086ece3d3b8ac8b08796038788cd0cfb951c24c1b9caf9fd2c83aad"
};

// Always purged, even if a manifest omits removedPlugins
const ALWAYS_REMOVED_PLUGINS = ["DiscordDebloater.js"];

interface ManifestFileEntry {
    hash: string;
    size?: number;
    author?: string;
    commit?: string;
    message?: string;
    url?: string;
}

interface UpdaterManifest {
    version?: string;
    updatedAt?: string;
    dist?: Record<string, ManifestFileEntry>;
    plugins?: Record<string, ManifestFileEntry>;
    removedPlugins?: string[];
}

interface PendingUpdateItem {
    filename: string;
    destPath: string;
    url?: string;
    hash?: string;
    remove?: boolean;
}

interface GitChangeEntry {
    hash: string;
    author: string;
    message: string;
}

let PendingUpdates: PendingUpdateItem[] = [];
let CachedChanges: GitChangeEntry[] = [];

function sha256(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex").toLowerCase();
}

function isSafePluginName(filename: string) {
    return filename.endsWith(".js") && basename(filename) === filename;
}

async function localHash(path: string): Promise<string | null> {
    if (!existsSync(path)) return null;
    try {
        return sha256(await readFile(path));
    } catch {
        return "";
    }
}

async function calculateGitChanges(): Promise<GitChangeEntry[]> {
    const isOutdated = await fetchUpdates();
    return isOutdated ? CachedChanges : [];
}

async function fetchUpdates(): Promise<boolean> {
    const pending: PendingUpdateItem[] = [];
    const changes: GitChangeEntry[] = [];

    await mkdir(USER_PLUGINS_DIR, { recursive: true });

    let manifest: UpdaterManifest | null = null;
    try {
        manifest = await fetchJson<UpdaterManifest>(`${RELEASE_BASE}/manifest.json`, REQUEST_INIT);
    } catch {
        try {
            manifest = await fetchJson<UpdaterManifest>(`${RAW_BASE}/userplugins/manifest.json`, REQUEST_INIT);
        } catch (e) {
            console.warn("[iMCord Updater] Could not fetch manifest from release or raw fallback:", e);
            return false;
        }
    }

    if (!manifest) return false;

    for (const [filename, info] of Object.entries(manifest.dist ?? {})) {
        if (!VENCORD_FILES.includes(filename) || !info?.hash) continue;

        const hash = info.hash.toLowerCase();
        const destPath = join(CORE_DIR, filename);
        const coreNeedsUpdate = (await localHash(destPath)) !== hash;

        let distNeedsUpdate = false;
        if (DIST_DIR && DIST_DIR !== CORE_DIR && existsSync(DIST_DIR)) {
            distNeedsUpdate = (await localHash(join(DIST_DIR, filename))) !== hash;
        }

        if (!coreNeedsUpdate && !distNeedsUpdate) continue;

        const updateUrl = info.url ?? `${RELEASE_BASE}/${encodeURIComponent(filename)}`;

        if (coreNeedsUpdate) {
            pending.push({
                filename,
                destPath,
                hash,
                url: updateUrl
            });
        }
        if (distNeedsUpdate) {
            pending.push({
                filename: `${filename} (dist)`,
                destPath: join(DIST_DIR, filename),
                hash,
                url: updateUrl
            });
        }

        changes.push({
            hash: hash.slice(0, 7),
            author: "iMCord",
            message: `[Vencord Core] Updated ${filename}`
        });
    }

    const plugins = manifest.plugins ?? {};
    for (const [filename, info] of Object.entries(plugins)) {
        if (!isSafePluginName(filename) || !info?.hash) continue;

        const hash = info.hash.toLowerCase();
        const destPath = join(USER_PLUGINS_DIR, filename);
        const current = await localHash(destPath);
        if (current === hash) continue;
        if (current === null && BUILTIN_PLUGIN_HASHES[filename] === hash) continue;

        pending.push({
            filename,
            destPath,
            hash,
            url: info.url ?? `${RAW_BASE}/userplugins/${encodeURIComponent(filename)}`
        });
        changes.push({
            hash: info.commit ? info.commit.slice(0, 7) : hash.slice(0, 7),
            author: info.author ?? "iMAboud",
            message: info.message ? `[Plugin] ${filename}: ${info.message}` : `[Plugin] Updated ${filename}`
        });
    }

    const removed = new Set([...ALWAYS_REMOVED_PLUGINS, ...(manifest.removedPlugins ?? [])]);
    for (const filename of removed) {
        if (plugins[filename] || !isSafePluginName(filename)) continue;

        const destPath = join(USER_PLUGINS_DIR, filename);
        if (!existsSync(destPath)) continue;

        pending.push({ filename, destPath, remove: true });
        changes.push({
            hash: "removed",
            author: "iMCord",
            message: `[Plugin] Removed ${filename}`
        });
    }

    PendingUpdates = pending;
    CachedChanges = changes;

    return pending.length > 0;
}

async function writeAtomic(destPath: string, data: Buffer) {
    const tmpPath = `${destPath}.download`;
    await writeFile(tmpPath, data);
    try {
        await rename(tmpPath, destPath);
    } catch {
        await writeFile(destPath, data);
        await rm(tmpPath, { force: true });
    }
}

async function applyUpdates(): Promise<boolean> {
    const items = PendingUpdates;
    PendingUpdates = [];
    CachedChanges = [];

    const failed: string[] = [];

    for (const item of items) {
        try {
            if (item.remove) {
                await rm(item.destPath, { force: true });
                continue;
            }

            const contents = await fetchBuffer(item.url!, REQUEST_INIT);
            const actualHash = sha256(contents);
            if (actualHash !== item.hash) {
                throw new Error(`Hash mismatch (expected ${item.hash}, got ${actualHash})`);
            }

            await writeAtomic(item.destPath, contents);
        } catch (err) {
            console.error(`[iMCord Updater] Failed to apply update for ${item.filename}:`, err);
            failed.push(item.filename);
        }
    }

    if (failed.length) {
        throw new Error(`Failed to update: ${failed.join(", ")}. Please try again later.`);
    }

    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => `https://github.com/${IMACORD_REPO}`));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(fetchUpdates));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(applyUpdates));

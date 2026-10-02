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
import { app, ipcMain } from "electron";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import { serializeErrors, VENCORD_FILES } from "./common";

const IMACORD_REPO = "iMAboud/iMACord";
const RAW_BASE = `https://raw.githubusercontent.com/${IMACORD_REPO}/main`;
const RELEASE_BASE = `https://github.com/${IMACORD_REPO}/releases/latest/download`;
const API_BASE = `https://api.github.com/repos/${IMACORD_REPO}`;

const BUILTIN_PLUGIN_HASHES: Record<string, string> = {
    "amongick.js": "58b2cd8bb1068e0e79cdb5315670f91abb4ece49197f1b3b466c5c1731607482",
    "DiscordDebloater.js": "fa968f06bbe4acb7a83de03d673b8f2fc3aad128dcbadf0781242876958415ae",
    "iMAMenu.js": "2d30028f95bf0a02bb51866e9137837feaff0f501ec1bcef773484828d64bbea",
    "MultiStreamPopout.js": "fcc7de78b086ece3d3b8ac8b08796038788cd0cfb951c24c1b9caf9fd2c83aad"
};

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
}

interface PendingUpdateItem {
    filename: string;
    url: string;
    destPath: string;
    hash: string;
    isCore: boolean;
}

interface GitChangeEntry {
    hash: string;
    author: string;
    message: string;
}

interface GitHubReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface GitHubRelease {
    tag_name: string;
    name: string;
    body?: string;
    assets: GitHubReleaseAsset[];
}

interface GitHubContentItem {
    name: string;
    download_url?: string;
    sha: string;
}

let PendingUpdates: PendingUpdateItem[] = [];
let CachedChanges: GitChangeEntry[] = [];
let HasCoreUpdate = false;

function sha256(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex").toLowerCase();
}

async function githubGet<T>(endpoint: string): Promise<T> {
    return fetchJson<T>(API_BASE + endpoint, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": VENCORD_USER_AGENT
        }
    });
}

async function calculateGitChanges(): Promise<GitChangeEntry[]> {
    const isOutdated = await fetchUpdates();
    if (!isOutdated) return [];
    return CachedChanges;
}

async function fetchUpdates(): Promise<boolean> {
    PendingUpdates = [];
    CachedChanges = [];
    HasCoreUpdate = false;

    if (!existsSync(DIST_DIR)) {
        await mkdir(DIST_DIR, { recursive: true });
    }
    if (!existsSync(USER_PLUGINS_DIR)) {
        await mkdir(USER_PLUGINS_DIR, { recursive: true });
    }

    let manifest: UpdaterManifest | null = null;

    try {
        manifest = await fetchJson<UpdaterManifest>(`${RELEASE_BASE}/manifest.json`, {
            headers: { "User-Agent": VENCORD_USER_AGENT }
        });
    } catch {
        try {
            manifest = await fetchJson<UpdaterManifest>(`${RAW_BASE}/userplugins/manifest.json`, {
                headers: { "User-Agent": VENCORD_USER_AGENT }
            });
        } catch {
            // Manifest unavailable, fallback below
        }
    }

    if (manifest) {
        // 1. Check Core Vencord dist files
        if (manifest.dist) {
            for (const [filename, info] of Object.entries(manifest.dist)) {
                if (!VENCORD_FILES.some(f => filename.startsWith(f)) || !info?.hash) continue;

                const remoteHash = info.hash.toLowerCase();
                const localPath = join(DIST_DIR, filename);

                if (existsSync(localPath)) {
                    try {
                        const localBuf = await readFile(localPath);
                        if (sha256(localBuf) === remoteHash) continue;
                    } catch {
                        // Re-fetch on read failure
                    }
                }

                PendingUpdates.push({
                    filename,
                    url: info.url ?? `${RELEASE_BASE}/${encodeURIComponent(filename)}`,
                    destPath: localPath,
                    hash: remoteHash,
                    isCore: true
                });

                HasCoreUpdate = true;
                CachedChanges.push({
                    hash: remoteHash.slice(0, 7),
                    author: "iMCord",
                    message: `[Vencord Core] Updated ${filename}`
                });
            }
        }

        // 2. Check User Plugins
        if (manifest.plugins) {
            for (const [filename, info] of Object.entries(manifest.plugins)) {
                if (!filename.endsWith(".js") || !info?.hash) continue;

                const remoteHash = info.hash.toLowerCase();
                const localPath = join(USER_PLUGINS_DIR, filename);

                if (existsSync(localPath)) {
                    try {
                        const localBuf = await readFile(localPath);
                        if (sha256(localBuf) === remoteHash) continue;
                    } catch {
                        // Re-fetch on read failure
                    }
                } else {
                    const builtinHash = BUILTIN_PLUGIN_HASHES[filename];
                    if (builtinHash && builtinHash.toLowerCase() === remoteHash) {
                        continue;
                    }
                }

                PendingUpdates.push({
                    filename,
                    url: info.url ?? `${RAW_BASE}/userplugins/${encodeURIComponent(filename)}`,
                    destPath: localPath,
                    hash: remoteHash,
                    isCore: false
                });

                CachedChanges.push({
                    hash: info.commit ? info.commit.slice(0, 7) : remoteHash.slice(0, 7),
                    author: info.author ?? "iMAboud",
                    message: info.message ? `[Plugin] ${filename}: ${info.message}` : `[Plugin] Updated ${filename}`
                });
            }
        }
    } else {
        // Fallback: check GitHub release for core dist files, and contents/userplugins for plugins
        try {
            const release = await githubGet<GitHubRelease>("/releases/latest");
            if (release && Array.isArray(release.assets)) {
                for (const asset of release.assets) {
                    if (VENCORD_FILES.some(f => asset.name === f)) {
                        const localPath = join(DIST_DIR, asset.name);
                        // Download buffer and check hash
                        const buf = await fetchBuffer(asset.browser_download_url);
                        const remoteHash = sha256(buf);

                        if (existsSync(localPath)) {
                            const localBuf = await readFile(localPath);
                            if (sha256(localBuf) === remoteHash) continue;
                        }

                        PendingUpdates.push({
                            filename: asset.name,
                            url: asset.browser_download_url,
                            destPath: localPath,
                            hash: remoteHash,
                            isCore: true
                        });

                        HasCoreUpdate = true;
                        CachedChanges.push({
                            hash: release.tag_name ?? "latest",
                            author: "iMCord",
                            message: `[Vencord Core] Updated ${asset.name}`
                        });
                    }
                }
            }
        } catch (e) {
            console.warn("[iMCord Updater] Fallback release check failed:", e);
        }

        try {
            const contents = await githubGet<GitHubContentItem[]>("/contents/userplugins");
            if (Array.isArray(contents)) {
                for (const item of contents) {
                    if (!item.name.endsWith(".js") || !item.download_url) continue;

                    const filename = item.name;
                    const localPath = join(USER_PLUGINS_DIR, filename);
                    const remoteBuffer = await fetchBuffer(item.download_url);
                    const remoteHash = sha256(remoteBuffer);

                    if (existsSync(localPath)) {
                        const localBuffer = await readFile(localPath);
                        if (sha256(localBuffer) === remoteHash) continue;
                    } else {
                        const builtinHash = BUILTIN_PLUGIN_HASHES[filename];
                        if (builtinHash && builtinHash.toLowerCase() === remoteHash) {
                            continue;
                        }
                    }

                    PendingUpdates.push({
                        filename,
                        url: item.download_url,
                        destPath: localPath,
                        hash: remoteHash,
                        isCore: false
                    });

                    CachedChanges.push({
                        hash: item.sha.slice(0, 7),
                        author: "iMAboud",
                        message: `[Plugin] Updated ${filename}`
                    });
                }
            }
        } catch (e) {
            console.warn("[iMCord Updater] Fallback userplugins check failed:", e);
        }
    }

    return PendingUpdates.length > 0;
}

async function applyUpdates(): Promise<boolean> {
    if (PendingUpdates.length === 0) return true;

    const hadCoreUpdate = HasCoreUpdate;

    for (const updateItem of PendingUpdates) {
        const contents = await fetchBuffer(updateItem.url);
        await writeFile(updateItem.destPath, contents);
    }

    PendingUpdates = [];
    CachedChanges = [];
    HasCoreUpdate = false;

    if (hadCoreUpdate) {
        setTimeout(() => {
            try {
                app.relaunch();
                app.exit(0);
            } catch {
                // Ignore if renderer initiates relaunch
            }
        }, 1000);
    }

    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => `https://github.com/${IMACORD_REPO}`));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(fetchUpdates));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(applyUpdates));

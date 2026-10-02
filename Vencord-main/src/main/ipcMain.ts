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

import "./updater";
import "./ipcPlugins";
import "./settings";

import { debounce } from "@shared/debounce";
import { IpcEvents } from "@shared/IpcEvents";
import { BrowserWindow, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import monacoHtml from "file://monacoWin.html?minify&base64";
import { FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "fs";
import { open, readdir, readFile, unlink, writeFile } from "fs/promises";
import { release } from "os";
import { join } from "path";

import { registerCspIpcHandlers } from "./csp/manager";
import { getThemeInfo, stripBOM, UserThemeHeader } from "./themes";
import { ALLOWED_PROTOCOLS, QUICK_CSS_PATH, SETTINGS_DIR, THEMES_DIR, USER_PLUGINS_DIR } from "./utils/constants";
import { ensureSafePath } from "./utils/ensureSafePath";
import { makeLinksOpenExternally } from "./utils/externalLinks";

const RENDERER_CSS_PATH = join(__dirname, IS_VESKTOP ? "vencordDesktopRenderer.css" : "renderer.css");

mkdirSync(THEMES_DIR, { recursive: true });
mkdirSync(USER_PLUGINS_DIR, { recursive: true });

registerCspIpcHandlers();

const SEPARATOR_CSS_RULE = `div[role="separator"][class*="separator_"] {\n    display: none !important;\n}`;

function appendSeparatorRuleIfMissing(css: string): string {
    if (!css.includes('div[role="separator"][class*="separator_"]')) {
        const trimmed = css.trimEnd();
        return trimmed.length > 0 ? `${trimmed}\n\n${SEPARATOR_CSS_RULE}\n` : `${SEPARATOR_CSS_RULE}\n`;
    }
    return css;
}

try {
    let currentCss = "";
    try {
        currentCss = readFileSync(QUICK_CSS_PATH, "utf-8");
    } catch {}
    const updatedCss = appendSeparatorRuleIfMissing(currentCss);
    if (updatedCss !== currentCss) {
        writeFileSync(QUICK_CSS_PATH, updatedCss, "utf-8");
    }
} catch (e) {
    console.error("[iMACord] Failed to initialize QuickCSS separator rule", e);
}

async function readCss() {
    try {
        const css = await readFile(QUICK_CSS_PATH, "utf-8");
        const updated = appendSeparatorRuleIfMissing(css);
        if (updated !== css) {
            await writeFile(QUICK_CSS_PATH, updated, "utf-8").catch(() => {});
        }
        return updated;
    } catch {
        const initial = appendSeparatorRuleIfMissing("");
        try {
            await writeFile(QUICK_CSS_PATH, initial, "utf-8");
        } catch {}
        return initial;
    }
}

async function listThemes(): Promise<UserThemeHeader[]> {
    const files = await readdir(THEMES_DIR).catch(() => []);

    const themeInfo: UserThemeHeader[] = [];

    for (const fileName of files) {
        if (!fileName.endsWith(".css")) continue;

        const data = await getThemeData(fileName).then(stripBOM).catch(() => null);
        if (data == null) continue;

        themeInfo.push(getThemeInfo(data, fileName));
    }

    return themeInfo;
}

function getThemeData(fileName: string) {
    fileName = fileName.replace(/\?v=\d+$/, "");
    const safePath = ensureSafePath(THEMES_DIR, fileName);
    if (!safePath) return Promise.reject(`Unsafe path ${fileName}`);
    return readFile(safePath, "utf-8");
}

ipcMain.handle(IpcEvents.OPEN_QUICKCSS, () => shell.openPath(QUICK_CSS_PATH));

ipcMain.handle(IpcEvents.OPEN_EXTERNAL, (_, url) => {
    try {
        var { protocol } = new URL(url);
    } catch {
        throw "Malformed URL";
    }
    if (!ALLOWED_PROTOCOLS.includes(protocol))
        throw "Disallowed protocol.";

    shell.openExternal(url)
        .catch(err => console.error("[Vencord] Failed to open external link", url, err));
});


ipcMain.handle(IpcEvents.GET_QUICK_CSS, () => readCss());
ipcMain.handle(IpcEvents.SET_QUICK_CSS, (_, css) =>
    writeFileSync(QUICK_CSS_PATH, css)
);

ipcMain.handle(IpcEvents.GET_THEMES_LIST, () => listThemes());
ipcMain.handle(IpcEvents.GET_THEME_DATA, (_, fileName) => getThemeData(fileName));
ipcMain.handle(IpcEvents.GET_THEME_SYSTEM_VALUES, () => {
    let accentColor = systemPreferences.getAccentColor?.() ?? "";

    if (accentColor.length && accentColor[0] !== "#") {
        accentColor = `#${accentColor}`;
    }

    return {
        "os-accent-color": accentColor
    };
});

ipcMain.handle(IpcEvents.OPEN_THEMES_FOLDER, () => shell.openPath(THEMES_DIR));
ipcMain.handle(IpcEvents.OPEN_SETTINGS_FOLDER, () => shell.openPath(SETTINGS_DIR));
ipcMain.handle(IpcEvents.OPEN_USER_PLUGINS_FOLDER, () => shell.openPath(USER_PLUGINS_DIR));

ipcMain.handle(IpcEvents.GET_USER_PLUGINS_LIST, async () => {
    const files = await readdir(USER_PLUGINS_DIR).catch(() => []);
    const plugins: Array<{ name: string; code: string; filename: string }> = [];
    for (const fileName of files) {
        if (!fileName.endsWith(".js")) continue;
        const safePath = ensureSafePath(USER_PLUGINS_DIR, fileName);
        if (!safePath) continue;
        const code = await readFile(safePath, "utf-8").catch(() => null);
        if (code) {
            plugins.push({
                name: fileName.replace(/\.js$/, ""),
                code,
                filename: fileName
            });
        }
    }
    return plugins;
});

ipcMain.handle(IpcEvents.SAVE_USER_PLUGIN, async (_, name: string, code: string) => {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "") || "customPlugin";
    const fileName = `${safeName}.js`;
    const safePath = ensureSafePath(USER_PLUGINS_DIR, fileName);
    if (!safePath) throw new Error("Invalid plugin name");
    writeFileSync(safePath, code, "utf-8");
    return { name: safeName, filename: fileName, code };
});

ipcMain.handle(IpcEvents.DELETE_USER_PLUGIN, async (_, fileName: string) => {
    const safePath = ensureSafePath(USER_PLUGINS_DIR, fileName);
    if (!safePath) throw new Error("Invalid file name");
    await unlink(safePath).catch(() => {});
    return true;
});

let fsWatchers = [] as FSWatcher[];

ipcMain.handle(IpcEvents.INIT_FILE_WATCHERS, ({ sender }) => {
    fsWatchers.forEach(w => w.close());

    let quickCssWatcher: FSWatcher | undefined;
    let rendererCssWatcher: FSWatcher | undefined;

    open(QUICK_CSS_PATH, "a+").then(fd => {
        fd.close();
        quickCssWatcher = watch(QUICK_CSS_PATH, { persistent: false }, debounce(async () => {
            sender.postMessage(IpcEvents.QUICK_CSS_UPDATE, await readCss());
        }, 50));
    }).catch(() => { });

    const themesWatcher = watch(THEMES_DIR, { persistent: false }, debounce(() => {
        sender.postMessage(IpcEvents.THEME_UPDATE, void 0);
    }));

    if (IS_DEV) {
        rendererCssWatcher = watch(RENDERER_CSS_PATH, { persistent: false }, async () => {
            sender.postMessage(IpcEvents.RENDERER_CSS_UPDATE, await readFile(RENDERER_CSS_PATH, "utf-8"));
        });
    }

    fsWatchers = [quickCssWatcher, themesWatcher, rendererCssWatcher].filter(Boolean) as FSWatcher[];

    sender.once("destroyed", () => {
        quickCssWatcher?.close();
        themesWatcher.close();
        rendererCssWatcher?.close();
        fsWatchers = [];
    });
});

ipcMain.on(IpcEvents.GET_MONACO_THEME, e => {
    e.returnValue = nativeTheme.shouldUseDarkColors ? "vs-dark" : "vs-light";
});

ipcMain.handle(IpcEvents.OPEN_MONACO_EDITOR, async () => {
    const title = "iMACord QuickCSS Editor";
    const existingWindow = BrowserWindow.getAllWindows().find(w => w.title === title);
    if (existingWindow && !existingWindow.isDestroyed()) {
        existingWindow.focus();
        return;
    }

    const win = new BrowserWindow({
        title,
        autoHideMenuBar: true,
        darkTheme: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "white",
        webPreferences: {
            preload: join(__dirname, IS_DISCORD_DESKTOP ? "preload.js" : "vencordDesktopPreload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    makeLinksOpenExternally(win);

    await win.loadURL(`data:text/html;base64,${monacoHtml}`);
});

ipcMain.handle(IpcEvents.GET_RENDERER_CSS, () => readFile(RENDERER_CSS_PATH, "utf-8"));

if (IS_DISCORD_DESKTOP) {
    ipcMain.on(IpcEvents.PRELOAD_GET_RENDERER_JS, e => {
        e.returnValue = readFileSync(join(__dirname, "renderer.js"), "utf-8");
    });
}

ipcMain.on(IpcEvents.SUPPORTS_WINDOWS_MATERIAL, e => {
    e.returnValue = process.platform === "win32" && Number(release().split(".")[2]) >= 22621;
});

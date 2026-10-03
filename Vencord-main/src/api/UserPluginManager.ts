/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 Vendicated and contributors
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

import { addPatch, isPluginEnabled, startPlugin, stopPlugin } from "@api/PluginManager";
import { definePluginSettings, PlainSettings, Settings, SettingsStore } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, Plugin, StartAt } from "@utils/types";
import * as Webpack from "@webpack";
import * as Common from "@webpack/common";
import { React } from "@webpack/common";

import Plugins, { PluginMeta } from "~plugins";

const logger = new Logger("UserPluginManager", "#3b82f6");

type UserPluginListener = () => void;
const listeners = new Set<UserPluginListener>();
const userPluginCodeMap = new Map<string, string>();

export function getUserPluginCode(pluginName: string): string {
    return userPluginCodeMap.get(pluginName) || "";
}

export async function fetchUserPluginCode(pluginName: string): Promise<string> {
    if (userPluginCodeMap.has(pluginName) && userPluginCodeMap.get(pluginName)) {
        return userPluginCodeMap.get(pluginName)!;
    }
    if (VencordNative.userPlugins?.getList) {
        try {
            const list = await VencordNative.userPlugins.getList();
            for (const item of list) {
                userPluginCodeMap.set(item.name, item.code);
            }
        } catch { }
    }
    return userPluginCodeMap.get(pluginName) || "";
}

export function addUserPluginsListener(cb: UserPluginListener) {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function notifyUserPluginsUpdated() {
    for (const listener of listeners) {
        try {
            listener();
        } catch (e) {
            logger.error("Error in user plugin listener", e);
        }
    }
}

export function evalUserPlugin(code: string, fileName?: string): Plugin | null {
    try {
        const cleanCode = code
            .replace(/import\s*[\s\S]*?from\s*["'][^"']+["'];?/g, "")
            .replace(/import\s*["'][^"']+["'];?/g, "")
            .replace(/^\s*export\s+default\s+/gm, "return ")
            .replace(/^\s*export\s+const\s+/gm, "const ");

        let createdPlugin: Plugin | null = null;
        const customDefinePlugin = (p: any) => {
            const res = definePlugin(p);
            createdPlugin = res;
            return res;
        };

        const fn = new Function(
            "definePlugin",
            "definePluginSettings",
            "OptionType",
            "StartAt",
            "React",
            "Vencord",
            "Webpack",
            "find",
            "findByProps",
            "findStore",
            "findByCode",
            "Common",
            "FluxDispatcher",
            "enableStyle",
            "disableStyle",
            "Logger",
            "exports",
            "module",
            cleanCode
        );

        const RuntimeOptionType = {
            STRING: OptionType.STRING,
            NUMBER: OptionType.NUMBER,
            BIGINT: OptionType.BIGINT,
            BOOLEAN: OptionType.BOOLEAN,
            SELECT: OptionType.SELECT,
            SLIDER: OptionType.SLIDER,
            COMPONENT: OptionType.COMPONENT,
            CUSTOM: OptionType.CUSTOM
        };

        const RuntimeStartAt = {
            Init: StartAt.Init,
            DOMContentLoaded: StartAt.DOMContentLoaded,
            WebpackReady: StartAt.WebpackReady
        };

        const exportsObj: Record<string, unknown> = {};
        const moduleObj = { exports: exportsObj };
        const vencordObj = window.Vencord || { Webpack, Settings, PlainSettings, React };

        const result = fn(
            customDefinePlugin,
            definePluginSettings,
            RuntimeOptionType,
            RuntimeStartAt,
            React,
            vencordObj,
            Webpack,
            Webpack.find,
            Webpack.findByProps,
            Webpack.findStore,
            Webpack.findByCode,
            Common,
            Common.FluxDispatcher,
            enableStyle,
            disableStyle,
            Logger,
            exportsObj,
            moduleObj
        );

        const moduleExports = moduleObj.exports as Record<string, unknown>;
        const plugin = createdPlugin || result || moduleExports?.default || moduleObj.exports;
        if (plugin && typeof plugin === "object" && plugin.name) {
            return plugin as Plugin;
        }
        logger.error(`Failed to evaluate user plugin (${fileName || "unknown"}): Invalid plugin object`, plugin);
        return null;
    } catch (e) {
        logger.error(`Error evaluating user plugin (${fileName || "unknown"}):`, e);
        return null;
    }
}

export function registerUserPlugin(plugin: Plugin, fileName: string, isNewPlugin: boolean = false) {
    PluginMeta[plugin.name] = {
        folderName: fileName,
        userPlugin: true
    };
    Plugins[plugin.name] = plugin;

    if (plugin.settings) {
        plugin.settings.pluginName = plugin.name;
        for (const [key, def] of Object.entries(plugin.settings.def)) {
            if (def.onChange) {
                SettingsStore.addChangeListener(`plugins.${plugin.name}.${key}`, def.onChange);
            }
        }
    }

    if (!Settings.plugins[plugin.name] || Settings.plugins[plugin.name].enabled === undefined) {
        Settings.plugins[plugin.name] = { enabled: true };
    } else if (isNewPlugin) {
        Settings.plugins[plugin.name].enabled = true;
    }

    if (plugin.patches) {
        for (const patch of plugin.patches) {
            addPatch(patch, plugin.name);
        }
    }

    if (isNewPlugin) {
        if (isPluginEnabled(plugin.name) && !plugin.started) {
            startPlugin(plugin);
        }
    }

    notifyUserPluginsUpdated();
}

export async function deleteUserPlugin(pluginName: string): Promise<boolean> {
    if (!VencordNative.userPlugins?.delete) return false;
    const plugin = Plugins[pluginName];
    if (plugin?.started) {
        try {
            stopPlugin(plugin);
        } catch (e) {
            logger.warn("Error stopping plugin on delete:", e);
        }
    }
    const meta = PluginMeta[pluginName];
    const fileName = meta?.folderName || `${pluginName}.js`;
    try {
        await VencordNative.userPlugins.delete(fileName);
        if (!fileName.endsWith(".js")) {
            await VencordNative.userPlugins.delete(`${fileName}.js`);
        }
    } catch {}
    delete Plugins[pluginName];
    delete PluginMeta[pluginName];
    userPluginCodeMap.delete(pluginName);
    if (Settings.plugins[pluginName]) delete Settings.plugins[pluginName];
    if (PlainSettings.plugins[pluginName]) delete PlainSettings.plugins[pluginName];
    notifyUserPluginsUpdated();
    return true;
}

export async function saveAndActivateUserPlugin(name: string, code: string, oldPluginName?: string): Promise<Plugin> {
    if (!VencordNative.userPlugins) {
        throw new Error("UserPlugins are not supported on this platform");
    }

    const plugin = evalUserPlugin(code, name);
    if (!plugin || !plugin.name) {
        throw new Error("Invalid plugin code: Could not parse definePlugin call");
    }

    const renameTarget = oldPluginName && oldPluginName !== plugin.name ? oldPluginName : (name && name !== plugin.name ? name : undefined);
    if (renameTarget) {
        const oldPlugin = Plugins[renameTarget];
        if (oldPlugin?.started) {
            try {
                stopPlugin(oldPlugin);
            } catch (e) {
                logger.warn("Error stopping old plugin version before rename:", e);
            }
        }
        const oldMeta = PluginMeta[renameTarget];
        const oldFile = oldMeta?.folderName || `${renameTarget}.js`;
        try {
            await VencordNative.userPlugins.delete(oldFile);
            if (!oldFile.endsWith(".js")) {
                await VencordNative.userPlugins.delete(`${oldFile}.js`);
            }
        } catch (e) {
            logger.warn("Error deleting old plugin file on rename:", e);
        }
        delete Plugins[renameTarget];
        delete PluginMeta[renameTarget];
        userPluginCodeMap.delete(renameTarget);

        if (Settings.plugins[renameTarget]) {
            Settings.plugins[plugin.name] = {
                ...Settings.plugins[renameTarget],
                ...Settings.plugins[plugin.name],
                enabled: true
            };
        }
    }

    const existingPlugin = Plugins[plugin.name];
    if (existingPlugin?.started) {
        try {
            stopPlugin(existingPlugin);
        } catch (e) {
            logger.warn("Error stopping old plugin version before reload:", e);
        }
    }

    const { filename } = await VencordNative.userPlugins.save(plugin.name, code);
    userPluginCodeMap.set(plugin.name, code);
    userPluginCodeMap.set(name, code);
    registerUserPlugin(plugin, filename, true);
    return plugin;
}

export async function loadAllUserPlugins() {
    if (!VencordNative.userPlugins?.getList) return;

    try {
        const userPlugins = await VencordNative.userPlugins.getList();
        const legacyNames = [
            "hidecontextmenuitems.js",
            "hidecontextmenuitems.js.new",
            "alwayshidenonvideo.js",
            "focus.js",
            "superdebloat.js",
            "fucknitro.js",
            "curshare.js",
            "discorddebloater.js",
            "discorddebloater.js.new"
        ];
        if ("DiscordDebloater" in Settings.plugins) {
            Reflect.deleteProperty(Settings.plugins, "DiscordDebloater");
        }
        if ("DiscordDebloater" in PlainSettings.plugins) {
            Reflect.deleteProperty(PlainSettings.plugins, "DiscordDebloater");
        }
        for (const item of userPlugins) {
            const lowerFile = item.filename.toLowerCase();
            const lowerName = item.name.toLowerCase();
            if (legacyNames.includes(lowerFile) || legacyNames.includes(`${lowerName}.js`)) {
                try {
                    await VencordNative.userPlugins.delete(item.filename);
                } catch {}
            }
        }

        for (const { name, code, filename } of userPlugins) {
            const lowerFile = filename.toLowerCase();
            const lowerName = name.toLowerCase();
            if (legacyNames.includes(lowerFile) || legacyNames.includes(`${lowerName}.js`)) {
                continue;
            }
            userPluginCodeMap.set(name, code);
            const plugin = evalUserPlugin(code, filename);
            if (plugin) {
                userPluginCodeMap.set(plugin.name, code);
                registerUserPlugin(plugin, filename, false);
            }
        }
    } catch (e) {
        logger.error("Failed to load user plugins:", e);
    }
}

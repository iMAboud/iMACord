/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openNotificationLogModal } from "@api/Notifications/notificationLog";
import { isPluginEnabled, isSettingDisabled, isSettingHidden, plugins, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings, useSettings } from "@api/Settings";
import { addUserPluginsListener } from "@api/UserPluginManager";
import { openPluginModal, openSettingsTabModal, PluginsTab, ThemesTab, UpdaterTab } from "@components/settings";
import { CustomPluginModal } from "@components/settings/tabs/plugins/CustomPluginModal";
import { relaunch } from "@utils/native";
import { useAwaiter } from "@utils/react";
import { wordsFromCamel, wordsToTitle } from "@utils/text";
import { OptionType, Plugin } from "@utils/types";
import { changes, checkForUpdates, isOutdated, update } from "@utils/updater";
import { Menu, openModal, showToast, useEffect, useMemo, useState } from "@webpack/common";
import type { ReactNode } from "react";

import Plugins, { PluginMeta } from "~plugins";

import { settings } from ".";

function buildPluginMenu() {
    const { showPluginMenu } = settings.use(["showPluginMenu"]);

    // has to be here due to hooks
    const pluginEntries = buildPluginMenuEntries();

    if (!showPluginMenu) return null;

    return (
        <Menu.MenuItem
            id="plugins"
            label="Plugins"
            action={() => openSettingsTabModal(PluginsTab)}
        >
            {pluginEntries}
        </Menu.MenuItem>
    );
}

export function buildPluginMenuEntries(includeEmpty = false) {
    const pluginSettings = useSettings().plugins;

    const [userPluginsVersion, setUserPluginsVersion] = useState(0);
    useEffect(() => addUserPluginsListener(() => setUserPluginsVersion(v => v + 1)), []);

    const [search, setSearch] = useState("");

    const lowerSearch = search.toLowerCase();

    const sortedPlugins = useMemo(() =>
        Object.values(Plugins).sort((a, b) => a.name.localeCompare(b.name)),
        [userPluginsVersion]
    );

    const candidates = useMemo(() =>
        sortedPlugins
            .filter(p => {
                const isUserPlugin = Boolean(PluginMeta[p.name]?.userPlugin);
                if (!isPluginEnabled(p.name) && !isUserPlugin) return false;
                if (p.name.endsWith("API")) return false;

                const name = p.name.toLowerCase();
                return name.includes(lowerSearch);
            }),
        [sortedPlugins, lowerSearch]
    );

    return (
        <>
            {IS_DISCORD_DESKTOP && (
                <Menu.MenuItem
                    id="plugins-add-new"
                    label="Add Plugin"
                    action={() => openModal(modalProps => <CustomPluginModal modalProps={modalProps} />)}
                />
            )}
            {IS_DISCORD_DESKTOP && <Menu.MenuSeparator />}

            <Menu.MenuControlItem
                id="plugins-search"
                control={(props, ref) => (
                    <Menu.MenuSearchControl
                        {...props}
                        query={search}
                        onChange={setSearch}
                        ref={ref}
                    />
                )}
            />

            <Menu.MenuSeparator />

            {candidates
                .map(p => {
                    const isUserPlugin = Boolean(PluginMeta?.[p.name]?.userPlugin);
                    const options = [] as ReactNode[];

                    let hasAnyOption = false;

                    if (isUserPlugin) {
                        options.push(
                            <Menu.MenuCheckboxItem
                                id={`${p.name}-enabled`}
                                key="enabled"
                                label="Enabled"
                                checked={isPluginEnabled(p.name)}
                                action={() => {
                                    const next = !isPluginEnabled(p.name);
                                    Settings.plugins[p.name] = { ...Settings.plugins[p.name], enabled: next };
                                    if (next) {
                                        startPlugin(p);
                                    } else {
                                        stopPlugin(p);
                                    }
                                    setUserPluginsVersion(v => v + 1);
                                }}
                            />
                        );
                    }

                    if (p.settings) for (const [key, option] of Object.entries(p.settings.def)) {
                        if (isSettingHidden(p.settings, option)) continue;

                        hasAnyOption = true;

                        const s = pluginSettings?.[p.name] ?? {};

                        const baseProps = {
                            id: `${p.name}-${key}`,
                            key: key,
                            label: wordsToTitle(wordsFromCamel(key)),
                            disabled: isSettingDisabled(p.settings, option)
                        };

                        switch (option.type) {
                            case OptionType.BOOLEAN:
                                options.push(
                                    <Menu.MenuCheckboxItem
                                        {...baseProps}
                                        checked={s[key]}
                                        action={() => {
                                            s[key] = !s[key];
                                            if (option.restartNeeded) showToast("Restart to apply the change");
                                        }}
                                    />
                                );
                                break;
                            case OptionType.SELECT:
                                options.push(
                                    <Menu.MenuItem {...baseProps}>
                                        {option.options.map(opt => (
                                            <Menu.MenuRadioItem
                                                group={`${p.name}-${key}`}
                                                id={`${p.name}-${key}-${opt.value}`}
                                                key={opt.label}
                                                label={opt.label}
                                                checked={s[key] === opt.value}
                                                action={() => {
                                                    s[key] = opt.value;
                                                    if (option.restartNeeded) showToast("Restart to apply the change");
                                                }}
                                            />
                                        ))}
                                    </Menu.MenuItem>
                                );
                                break;
                            case OptionType.SLIDER:
                                // The menu slider doesn't support these options. Skip to avoid confusion
                                if (option.stickToMarkers || option.componentProps) continue;

                                options.push(
                                    <Menu.MenuControlItem
                                        {...baseProps}
                                        control={(props, ref) => (
                                            <Menu.MenuSliderControl
                                                ref={ref}
                                                {...props}
                                                minValue={option.markers[0]}
                                                maxValue={option.markers.at(-1)!}
                                                value={s[key]}
                                                onChange={v => s[key] = v}
                                            />
                                        )}
                                    />
                                );
                                break;
                        }
                    }

                    const hasVisibleOptions = options.length > 0;
                    const shouldSkip = !isUserPlugin && !hasVisibleOptions && !(includeEmpty && hasAnyOption);
                    if (shouldSkip) return null;

                    return (
                        <Menu.MenuItem
                            id={`${p.name}-menu`}
                            key={p.name}
                            label={p.name}
                            action={() => openPluginModal(p)}
                        >
                            {hasVisibleOptions && (
                                <>
                                    <Menu.MenuGroup label={p.name}>
                                        {options}
                                    </Menu.MenuGroup>

                                    <Menu.MenuSeparator />

                                    <Menu.MenuItem
                                        id={`${p.name}-open`}
                                        label={"Open Settings"}
                                        action={() => openPluginModal(p)}
                                    />
                                </>
                            )}
                        </Menu.MenuItem>
                    );
                })
            }
        </>
    );
}

export function buildUpdaterMenuEntries() {
    const Tab = UpdaterTab;
    const [status, setStatus] = useState<"idle" | "checking" | "has_updates" | "updating" | "up_to_date">(
        isOutdated ? "has_updates" : "idle"
    );
    const [count, setCount] = useState(changes?.length ?? 0);

    const handleAction = async () => {
        if (status === "has_updates") {
            setStatus("updating");
            try {
                const res = await update();
                if (res) {
                    showToast("Update complete! Restarting...");
                    setTimeout(() => relaunch(), 1000);
                } else {
                    setStatus("idle");
                    showToast("Update completed without changes");
                }
            } catch (err: unknown) {
                setStatus("has_updates");
                const msg = err instanceof Error ? err.message : String(err);
                showToast(`Update failed: ${msg}`);
            }
        } else {
            setStatus("checking");
            try {
                const outdated = await checkForUpdates();
                if (outdated) {
                    setStatus("has_updates");
                    setCount(changes?.length ?? 0);
                    showToast("New update available!");
                } else {
                    setStatus("up_to_date");
                    showToast("iMCord is up to date!");
                    setTimeout(() => setStatus("idle"), 3000);
                }
            } catch (err: unknown) {
                setStatus("idle");
                const msg = err instanceof Error ? err.message : String(err);
                showToast(`Check failed: ${msg}`);
            }
        }
    };

    let label = "Check for Updates";
    if (status === "checking") label = "Checking for Updates...";
    else if (status === "has_updates") label = `Update Now${count > 0 ? ` (${count})` : ""}`;
    else if (status === "updating") label = "Updating...";
    else if (status === "up_to_date") label = "Up to Date ✓";

    return (
        <>
            {Tab && (
                <Menu.MenuItem
                    id="updater-open-tab"
                    label="Open Updater Tab"
                    action={() => openSettingsTabModal(Tab)}
                />
            )}
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="updater-dynamic-btn"
                label={label}
                disabled={status === "checking" || status === "updating"}
                action={handleAction}
            />
        </>
    );
}

export function buildThemeMenu() {
    return (
        <Menu.MenuItem
            id="themes"
            label="Themes"
            action={() => openSettingsTabModal(ThemesTab)}
        >
            {buildThemeMenuEntries()}
        </Menu.MenuItem>
    );
}

export function buildThemeMenuEntries() {
    const { useQuickCss, enabledThemes } = useSettings(["useQuickCss", "enabledThemes"]);
    const [themes] = useAwaiter(VencordNative.themes.getThemesList);

    return (
        <>
            <Menu.MenuCheckboxItem
                id="toggle-quickcss"
                checked={useQuickCss}
                label={"Enable QuickCSS"}
                action={() => {
                    Settings.useQuickCss = !useQuickCss;
                }}
            />
            <Menu.MenuItem
                id="edit-quickcss"
                label="Edit QuickCSS"
                action={() => VencordNative.quickCss.openEditor()}
            />
            <Menu.MenuItem
                id="manage-themes"
                label="Manage Themes"
                action={() => openSettingsTabModal(ThemesTab)}
            />
            {!!themes?.length && (
                <Menu.MenuGroup>
                    {themes.map(theme => (
                        <Menu.MenuCheckboxItem
                            id={`theme-${theme.fileName}`}
                            key={theme.fileName}
                            label={theme.name}
                            checked={enabledThemes.includes(theme.fileName)}
                            action={() => {
                                if (enabledThemes.includes(theme.fileName)) {
                                    Settings.enabledThemes = enabledThemes.filter(t => t !== theme.fileName);
                                } else {
                                    Settings.enabledThemes = [...enabledThemes, theme.fileName];
                                }
                            }}
                        />
                    ))}
                </Menu.MenuGroup>
            )}
        </>
    );
}

function buildCustomPluginEntries() {
    const pluginEntries = [] as { plugin: Plugin, node: ReactNode; }[];

    for (const plugin of Object.values(plugins)) {
        if (plugin.toolboxActions && isPluginEnabled(plugin.name)) {
            const entries = typeof plugin.toolboxActions === "function"
                ? plugin.toolboxActions()
                : Object.entries(plugin.toolboxActions).map(([text, action]) => {
                    const key = `${plugin.name}-${text}`;

                    return (
                        <Menu.MenuItem
                            id={key}
                            key={key}
                            label={text}
                            action={action}
                        />
                    );
                });

            if (!entries || Array.isArray(entries) && entries.length === 0) continue;

            pluginEntries.push({
                plugin,
                node:
                    <Menu.MenuGroup label={plugin.name} key={`${plugin.name}-group`}>
                        {entries}
                    </Menu.MenuGroup>
            });
        }
    }

    // If there aren't too many entries, just put them all in the main menu.
    // Otherwise, add submenus for each plugin
    // FIXME: the Slider component has broken styles that overlap with higher context menus
    // https://discord.com/channels/1015060230222131221/1015063227299811479/1440489344631705693
    if (pluginEntries.length <= 5)
        return pluginEntries.map(e => e.node);

    const submenuEntries = pluginEntries.map(({ node, plugin }) => (
        <Menu.MenuItem
            id={`${plugin.name}-menu`}
            key={`${plugin.name}-menu`}
            label={plugin.name}
            action={() => openPluginModal(plugin)}
        >
            {node}
        </Menu.MenuItem>
    ));

    return <Menu.MenuGroup>{submenuEntries}</Menu.MenuGroup>;
}

export function renderPopout(onClose: () => void) {
    return (
        <Menu.Menu
            navId="vc-toolbox"
            onClose={onClose}
        >
            <Menu.MenuItem
                id="notifications"
                label="Open Notification Log"
                action={openNotificationLogModal}
            />

            {buildThemeMenu()}
            {buildPluginMenu()}

            {buildCustomPluginEntries()}
        </Menu.Menu >
    );
}

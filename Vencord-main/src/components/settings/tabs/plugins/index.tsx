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

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { isPluginEnabled } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { addUserPluginsListener } from "@api/UserPluginManager";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { ChangeList } from "@utils/ChangeList";
import { classNameFactory } from "@utils/css";
import { isTruthy } from "@utils/guards";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { PluginTarget } from "@utils/pluginTargets";
import { useAwaiter, useCleanupEffect } from "@utils/react";
import { PluginTag, PluginTags } from "@utils/types";
import { Button, ConfirmModal, lodash, openModal, Parser, React, SearchableSelect, Select, TextInput, Tooltip, useMemo, useRef, useState } from "@webpack/common";
import { JSX } from "react";

import Plugins, { ExcludedPlugins, PluginMeta } from "~plugins";

import { CustomPluginModal } from "./CustomPluginModal";
import { PluginCard } from "./PluginCard";
import { UIElementsButton } from "./UIElements";

export const cl = classNameFactory("vc-plugins-");
export const logger = new Logger("PluginSettings", "#a6d189");

function ReloadRequiredCard({ required }: { required: boolean; }) {
    return (
        <Card variant={required ? "warning" : "normal"} className={cl("info-card")}>
            {required
                ? (
                    <>
                        <HeadingTertiary>Restart required!</HeadingTertiary>
                        <Paragraph className={cl("dep-text")}>
                            Restart now to apply new plugins and their settings
                        </Paragraph>
                        <Button onClick={() => location.reload()} className={cl("restart-button")}>
                            Restart
                        </Button>
                    </>
                )
                : (
                    <>
                        <div className={cl("banner-icon")}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
                            </svg>
                        </div>
                        <div className={cl("banner-text")}>
                            <HeadingTertiary style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>Plugin Management</HeadingTertiary>
                            <Paragraph style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                                Press the cog wheel or info icon to get more info on a plugin.
                            </Paragraph>
                            <Paragraph style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                                Plugins with a cog wheel have settings you can modify!
                            </Paragraph>
                        </div>
                    </>
                )}
        </Card>
    );
}

const enum SearchStatus {
    ALL,
    FAVORITES,
    ENABLED,
    DISABLED,
    NEW,
    HIDDEN,
    USER_PLUGINS,
    API_PLUGINS
}

function ExcludedPluginsList({ search }: { search: string; }) {
    const matchingExcludedPlugins = search
        ? Object.entries(ExcludedPlugins)
            .filter(([name]) => name.toLowerCase().includes(search))
        : [];

    const ExcludedReasons: Record<PluginTarget, string> = {
        desktop: "Discord Desktop app or Vesktop",
        discordDesktop: "Discord Desktop app",
        vesktop: "Vesktop app",
        web: "Vesktop app and the Web version of Discord",
        dev: "Developer version of iMACord",
        browser: "Web Browser version of iMACord"
    };

    return (
        <Paragraph className={Margins.top16}>
            {matchingExcludedPlugins.length
                ? <>
                    <Paragraph>Are you looking for:</Paragraph>
                    <ul>
                        {matchingExcludedPlugins.map(([name, reason]) => (
                            <li key={name}>
                                <b>{name}</b>: Only available on the {ExcludedReasons[reason]}
                            </li>
                        ))}
                    </ul>
                </>
                : "No plugins meet the search criteria."
            }
        </Paragraph>
    );
}

function PluginSettings() {
    const settings = useSettings();
    const changeRef = useRef<ChangeList<string>>(null);
    const changes = changeRef.current ??= new ChangeList<string>();

    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    React.useEffect(() => addUserPluginsListener(forceUpdate), []);

    useCleanupEffect(() => {
        if (changes.hasChanges)
            openModal(props => (
                <ConfirmModal
                    {...props}
                    title="Restart required"
                    confirmText="Restart now"
                    cancelText="Later!"
                    variant="primary"
                    onConfirm={() => location.reload()}
                >
                    <>
                        <p>The following plugins require a restart:</p>
                        <div>{changes.map((s, i) => (
                            <React.Fragment key={s}>
                                {i > 0 && ", "}
                                {Parser.parse("`" + s.split(".")[0] + "`")}
                            </React.Fragment>
                        ))}</div>
                    </>
                </ConfirmModal>
            ));
    }, []);

    const depMap = useMemo(() => {
        const o = {} as Record<string, string[]>;
        for (const plugin in Plugins) {
            const deps = Plugins[plugin].dependencies;
            if (deps) {
                for (const dep of deps) {
                    o[dep] ??= [];
                    o[dep].push(plugin);
                }
            }
        }
        return o;
    }, []);

    const pluginCount = Object.keys(Plugins).length;
    const sortedPlugins = useMemo(() =>
        Object.values(Plugins).sort((a, b) => {
            const isUserA = Boolean(PluginMeta[a.name]?.userPlugin);
            const isUserB = Boolean(PluginMeta[b.name]?.userPlugin);
            const isEnabledA = isPluginEnabled(a.name);
            const isEnabledB = isPluginEnabled(b.name);

            // Group 0: custom added plugins first
            // Group 1: enabled stock vencord plugins second
            // Group 2: remaining disabled stock plugins third
            const rankA = isUserA ? 0 : (isEnabledA ? 1 : 2);
            const rankB = isUserB ? 0 : (isEnabledB ? 1 : 2);

            if (rankA !== rankB) return rankA - rankB;

            if (isUserA && isUserB && isEnabledA !== isEnabledB) {
                return isEnabledA ? -1 : 1;
            }

            const favA = Number(settings.plugins[a.name]?.isFavorite ?? false);
            const favB = Number(settings.plugins[b.name]?.isFavorite ?? false);
            if (favA !== favB) return favB - favA;

            return a.name.localeCompare(b.name);
        }),
        [pluginCount, settings.plugins]
    );

    const hasUserPlugins = Object.values(PluginMeta).some(m => m.userPlugin);

    const [searchValue, setSearchValue] = useState({ value: "", tags: [] as PluginTag[], status: SearchStatus.ALL });

    const search = searchValue.value.toLowerCase();
    const onSearch = (query: string) => setSearchValue(prev => ({ ...prev, value: query }));

    const pluginFilter = (plugin: typeof Plugins[keyof typeof Plugins]) => {
        const { status, tags } = searchValue;
        const isUserHidden = Boolean(settings.plugins[plugin.name]?.isUserHidden);

        if (status === SearchStatus.HIDDEN) {
            if (!isUserHidden) return false;
        } else {
            if (isUserHidden) return false;
        }

        switch (status) {
            case SearchStatus.FAVORITES:
                if (!settings.plugins[plugin.name]?.isFavorite) return false;
                break;
            case SearchStatus.DISABLED:
                if (isPluginEnabled(plugin.name)) return false;
                break;
            case SearchStatus.ENABLED:
                if (!isPluginEnabled(plugin.name)) return false;
                break;
            case SearchStatus.NEW:
                if (!newPlugins?.includes(plugin.name) && !PluginMeta[plugin.name]?.userPlugin) return false;
                break;
            case SearchStatus.USER_PLUGINS:
                if (!PluginMeta[plugin.name]?.userPlugin) return false;
                break;
            case SearchStatus.API_PLUGINS:
                if (!plugin.name.endsWith("API")) return false;
                break;
            case SearchStatus.HIDDEN:
            case SearchStatus.ALL:
                break;
        }

        if (tags.length && tags.some(t => !plugin.tags?.includes(t))) return false;

        if (!search.length) return true;

        return (
            plugin.name.toLowerCase().includes(search) ||
            plugin.name.match(/[A-Z]/g)?.join("").toLowerCase().includes(search) || // acronyms like BF for BetterFolders
            plugin.description.toLowerCase().includes(search) ||
            plugin.searchTerms?.some(t => t.toLowerCase().includes(search))
        );
    };

    const [newPlugins] = useAwaiter(() => DataStore.get("Vencord_existingPlugins").then((cachedPlugins: Record<string, number> | undefined) => {
        const now = Date.now() / 1000;
        const existingTimestamps: Record<string, number> = {};
        const sortedPluginNames = Object.values(sortedPlugins).map(plugin => plugin.name);

        const newPlugins: string[] = [];
        for (const { name: p } of sortedPlugins) {
            const time = existingTimestamps[p] = cachedPlugins?.[p] ?? now;
            if ((time + 60 * 60 * 24 * 2) > now) {
                newPlugins.push(p);
            }
        }
        DataStore.set("Vencord_existingPlugins", existingTimestamps);

        return lodash.isEqual(newPlugins, sortedPluginNames) ? [] : newPlugins;
    }), { deps: [pluginCount], fallbackValue: [] });

    const plugins = [] as JSX.Element[];
    const requiredPlugins = [] as JSX.Element[];

    const showApi = searchValue.status === SearchStatus.API_PLUGINS;
    for (const p of sortedPlugins) {
        if (p.hidden || (!p.settings && p.name.endsWith("API") && !showApi))
            continue;

        if (!pluginFilter(p)) continue;

        const isRequired = p.required || p.isDependency || depMap[p.name]?.some(d => settings.plugins[d].enabled);

        if (isRequired) {
            const tooltipText = p.required || !depMap[p.name]
                ? "This plugin is required for Vencord to function."
                : makeDependencyList(depMap[p.name]?.filter(d => settings.plugins[d].enabled));

            requiredPlugins.push(
                <Tooltip text={tooltipText} key={p.name}>
                    {({ onMouseLeave, onMouseEnter }) => (
                        <PluginCard
                            onMouseLeave={onMouseLeave}
                            onMouseEnter={onMouseEnter}
                            onRestartNeeded={(name, key) => changes.handleChange(`${name}.${key}`)}
                            disabled={true}
                            plugin={p}
                            key={p.name}
                        />
                    )}
                </Tooltip>
            );
        } else {
            plugins.push(
                <PluginCard
                    onRestartNeeded={(name, key) => changes.handleChange(`${name}.${key}`)}
                    disabled={false}
                    plugin={p}
                    isNew={newPlugins?.includes(p.name) || PluginMeta[p.name]?.userPlugin}
                    key={p.name}
                />
            );
        }
    }

    return (
        <SettingsTab>
            <ReloadRequiredCard required={changes.hasChanges} />

            <div className={cl("top-actions")}>
                <UIElementsButton />
                {IS_DISCORD_DESKTOP && (
                    <button
                        type="button"
                        className={classes(cl("action-btn"), cl("add-btn"))}
                        onClick={() => openModal(modalProps => <CustomPluginModal modalProps={modalProps} />)}
                    >
                        <svg
                            className={cl("btn-icon")}
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        <span>Add Plugin</span>
                    </button>
                )}
                {IS_DISCORD_DESKTOP && (
                    <button
                        type="button"
                        className={classes(cl("action-btn"), cl("folder-btn"))}
                        onClick={() => VencordNative.userPlugins?.openFolder()}
                    >
                        <svg
                            className={cl("btn-icon")}
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                        </svg>
                        <span>Open Folder</span>
                    </button>
                )}
            </div>

            <div className={cl("section-header")}>
                <svg className={cl("section-icon")} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                <span>Filters</span>
            </div>

            <ErrorBoundary noop>
                <div className={cl("search-wrapper")}>
                    <svg className={cl("search-icon")} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <TextInput
                        inputClassName={cl("search-input")}
                        placeholder="Search for a plugin..."
                        value={searchValue.value}
                        onChange={onSearch}
                        autoFocus
                    />
                </div>
            </ErrorBoundary>

            <ErrorBoundary noop>
                <div className={classes(Margins.bottom20, Margins.top8, cl("filter-controls"))}>
                    <Select
                        options={[
                            { label: "Show All", value: SearchStatus.ALL, default: true },
                            { label: "Show Favorites", value: SearchStatus.FAVORITES },
                            { label: "Show Enabled", value: SearchStatus.ENABLED },
                            { label: "Show Disabled", value: SearchStatus.DISABLED },
                            { label: "Show New", value: SearchStatus.NEW },
                            { label: "Hidden", value: SearchStatus.HIDDEN },
                            hasUserPlugins && { label: "Show UserPlugins", value: SearchStatus.USER_PLUGINS },
                            { label: "Show API Plugins", value: SearchStatus.API_PLUGINS },
                        ].filter(isTruthy)}
                        serialize={String}
                        select={status => setSearchValue(prev => ({ ...prev, status }))}
                        isSelected={v => v === searchValue.status}
                        closeOnSelect={true}
                        placeholder="Filter by Type"
                    />
                    <SearchableSelect
                        options={PluginTags.map(tag => ({ label: tag, value: tag }))}
                        value={searchValue.tags}
                        onChange={tags => setSearchValue(prev => ({ ...prev, tags }))}
                        closeOnSelect={false}
                        placeholder="Filter by Tags"
                        multi
                    />
                </div>
            </ErrorBoundary>

            <div className={cl("section-header")}>
                <svg className={cl("section-icon")} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
                <span>Plugins</span>
            </div>

            {plugins.length || requiredPlugins.length
                ? (
                    <div className={cl("grid")}>
                        {plugins.length
                            ? plugins
                            : <Paragraph>No plugins meet the search criteria.</Paragraph>
                        }
                    </div>
                )
                : <ExcludedPluginsList search={search} />
            }


            <Divider className={Margins.top20} />

            <div className={cl("section-header")}>
                <svg className={cl("section-icon")} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>Required Plugins</span>
            </div>

            <div className={cl("grid")}>
                {requiredPlugins.length
                    ? requiredPlugins
                    : <Paragraph>No plugins meet the search criteria.</Paragraph>
                }
            </div>
        </SettingsTab >
    );
}

function makeDependencyList(deps: string[]) {
    return (
        <>
            <Paragraph>This plugin is required by:</Paragraph>
            {deps.map((dep: string) => <Paragraph key={dep} className={cl("dep-text")}>{dep}</Paragraph>)}
        </>
    );
}

export default wrapTab(PluginSettings, "Plugins");

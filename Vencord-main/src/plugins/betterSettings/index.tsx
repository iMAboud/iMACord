/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { openSettingsTabModal, UpdaterTab } from "@components/settings";
import { buildPluginMenuEntries, buildThemeMenuEntries, buildUpdaterMenuEntries } from "@plugins/vencordToolbox/menu";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { getIntlMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import { ComponentDispatch, FocusLock, Menu, useEffect, useRef } from "@webpack/common";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";

import fullHeightStyle from "./fullHeightContext.css?managed";

const cl = classNameFactory("");
const Classes = findCssClassesLazy("animating", "baseLayer", "bg", "layer", "layers");

const settings = definePluginSettings({
    disableFade: {
        description: "Disable the crossfade animation",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    organizeMenu: {
        description: "Organizes the settings cog context menu into categories",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    eagerLoad: {
        description: "Removes the loading delay when opening the menu for the first time",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    }
});

interface LayerProps extends HTMLAttributes<HTMLDivElement> {
    mode: "SHOWN" | "HIDDEN";
    baseLayer?: boolean;
}

function Layer({ mode, baseLayer = false, ...props }: LayerProps) {
    const hidden = mode === "HIDDEN";
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => () => {
        ComponentDispatch.dispatch("LAYER_POP_START");
        ComponentDispatch.dispatch("LAYER_POP_COMPLETE");
    }, []);

    const node = (
        <div
            ref={containerRef}
            aria-hidden={hidden}
            className={cl({
                [Classes.layer]: true,
                [Classes.baseLayer]: baseLayer,
                "stop-animations": hidden
            })}
            style={{ opacity: hidden ? 0 : undefined }}
            {...props}
        />
    );

    return baseLayer
        ? node
        : <FocusLock containerRef={containerRef}>{node}</FocusLock>;
}

export default definePlugin({
    name: "BetterSettings",
    description: "Enhances your settings-menu-opening experience",
    authors: [Devs.Kyuuhachi],
    tags: ["Appearance", "Customisation", "Organisation"],
    settings,

    start() {
        if (settings.store.organizeMenu)
            enableStyle(fullHeightStyle);
    },

    stop() {
        disableStyle(fullHeightStyle);
    },

    patches: [
        {
            find: "this.renderArtisanalHack()",
            replacement: [
                {
                    match: /class (\i)( extends \i\.PureComponent.+?jsx\)\(\1,\{mode:)/,
                    replace: "var $1=$self.Layer;class VencordPatchedOldFadeLayer$2",
                    predicate: () => settings.store.disableFade
                },
                { // Lazy-load contents
                    match: /createPromise:\(\)=>([^:}]*?),webpackId:"?\d+"?,name:(?!="CollectiblesShop")"[^"]+"/g,
                    replace: "$&,_:$1",
                    predicate: () => settings.store.eagerLoad
                }
            ]
        },
        { // For some reason standardSidebarView also has a small fade-in
            find: 'minimal:"contentColumnMinimal"',
            replacement: [
                {
                    match: /(?=\(0,\i\.\i\)\((\i),\{from:\{position:"absolute")/,
                    replace: "(_cb=>_cb(void 0,$1))||"
                },
                {
                    match: /\i\.animated\.div/,
                    replace: '"div"'
                }
            ],
            predicate: () => settings.store.disableFade
        },
        { // Disable fade animations for settings menu
            find: '"data-mana-component":"layer-modal"',
            replacement: [
                {
                    match: /(\i)\.animated\.div(?=,\{"data-mana-component":"layer-modal")/,
                    replace: '"div"'
                },
                {
                    match: /(?<="data-mana-component":"layer-modal"[^}]*?)style:\i,/,
                    replace: "style:{},"
                }
            ],
            predicate: () => settings.store.disableFade
        },
        { // Disable initial and exit delay for settings menu
            find: "headerId:void 0,headerIdIsManaged:!1",
            replacement: {
                match: /let (\i)=300/,
                replace: "let $1=0"
            },
            predicate: () => settings.store.disableFade
        },
        { // Load menu TOC eagerly
            find: "handleOpenSettingsContextMenu=",
            replacement: {
                match: /(?=handleOpenSettingsContextMenu=.{0,100}?null!=\i&&.{0,100}?(await [^};]*?\)\)))/,
                replace: "_vencordBetterSettingsEagerLoad=(async ()=>$1)();"
            },
            predicate: () => settings.store.eagerLoad
        },
        { // Settings cog context menu
            find: "#{intl::USER_SETTINGS_ACTIONS_MENU_LABEL}",
            predicate: () => settings.store.organizeMenu,
            replacement: [
                {
                    match: /children:\[(\i),(?<=\1=(?:function|.{0,30}\.openUserSettings).+?)/, // TODO .{0,30}\.openUserSettings is stable compat
                    replace: "children:[$self.transformSettingsEntries($1),",
                },
            ]
        },
    ],

    // This is the very outer layer of the entire ui, so we can't wrap this in an ErrorBoundary
    // without possibly also catching unrelated errors of children.
    //
    // Thus, we sanity check webpack modules
    Layer(props: LayerProps) {
        try {
            [FocusLock.$$vencordGetWrappedComponent(), ComponentDispatch, Classes.layer].forEach(e => e.test);
        } catch {
            new Logger("BetterSettings").error("Failed to find some components");
            return props.children;
        }

        return <Layer {...props} />;
    },

    transformSettingsEntries(list: ReactElement<any>[]): ReactNode[] {
        if (!Array.isArray(list)) return list;

        try {
            const items: ReactNode[] = [];

            for (const item of list) {
                const { key, props } = item;
                if (!props) continue;

                if (key === "vencord_plugins" || key === "vencord_themes" || key === "vencord_updater") {
                    const children = key === "vencord_plugins"
                        ? buildPluginMenuEntries()
                        : key === "vencord_themes"
                            ? buildThemeMenuEntries()
                            : buildUpdaterMenuEntries();

                    items.push(
                        <Menu.MenuItem key={key} label={props.label} id={props.label} {...props}>
                            {children}
                        </Menu.MenuItem>
                    );
                } else if (key === "user_section" || (key?.endsWith("_section") && props.label)) {
                    const label = key === "user_section"
                        ? getIntlMessage("USER_SETTINGS")
                        : props.label;

                    const transformedChildren = this.transformSettingsEntries(props.children);

                    if (key === "vencord_section") {
                        const hasUpdater = transformedChildren.some(
                            child => child != null && typeof child === "object" && "key" in child && child.key === "vencord_updater"
                        );

                        if (!hasUpdater && !IS_UPDATER_DISABLED) {
                            const updaterItem = (
                                <Menu.MenuItem
                                    key="vencord_updater"
                                    label="Updater"
                                    id="Updater"
                                    action={() => {
                                        if (UpdaterTab) openSettingsTabModal(UpdaterTab);
                                    }}
                                >
                                    {buildUpdaterMenuEntries()}
                                </Menu.MenuItem>
                            );

                            const themeIdx = transformedChildren.findIndex(
                                child => child != null && typeof child === "object" && "key" in child && child.key === "vencord_themes"
                            );

                            if (themeIdx !== -1) {
                                transformedChildren.splice(themeIdx + 1, 0, updaterItem);
                            } else {
                                transformedChildren.push(updaterItem);
                            }
                        }
                    }

                    items.push(
                        <Menu.MenuItem key={key} label={label} id={label}>
                            {transformedChildren}
                        </Menu.MenuItem>
                    );
                } else {
                    items.push(item);
                }
            }

            return items;
        } catch (e) {
            new Logger("BetterSettings").error("Failed to transform settings entries", e);
            return list;
        }
    }
});

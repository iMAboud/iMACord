/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { hasAnyVisibleSettings, isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { deleteUserPlugin, getUserPluginCode } from "@api/UserPluginManager";
import { CogWheel, InfoIcon } from "@components/Icons";
import { AddonCard } from "@components/settings/AddonCard";
import { classes } from "@utils/misc";
import { Plugin } from "@utils/types";
import { openModal, React, showToast, Toasts, Tooltip } from "@webpack/common";

import { PluginMeta } from "~plugins";

import { cl, logger } from ".";
import { CustomPluginModal } from "./CustomPluginModal";
import { openPluginModal } from "./PluginModal";

interface PluginCardProps extends React.HTMLProps<HTMLDivElement> {
    plugin: Plugin;
    disabled: boolean;
    onRestartNeeded(name: string, key: string): void;
    isNew?: boolean;
}

export function PluginCard({ plugin, disabled, onRestartNeeded, onMouseEnter, onMouseLeave, isNew }: PluginCardProps) {
    const settings = Settings.plugins[plugin.name];

    const isEnabled = () => isPluginEnabled(plugin.name);

    function toggleEnabled() {
        const wasEnabled = isEnabled();

        // If we're enabling a plugin, make sure all deps are enabled recursively.
        if (!wasEnabled) {
            const { restartNeeded, failures } = startDependenciesRecursive(plugin);

            if (failures.length) {
                logger.error(`Failed to start dependencies for ${plugin.name}: ${failures.join(", ")}`);
                showNotice("Failed to start dependencies: " + failures.join(", "), "Close", () => null);
                return;
            }

            if (restartNeeded) {
                // If any dependencies have patches, don't start the plugin yet.
                settings.enabled = true;
                onRestartNeeded(plugin.name, "enabled");
                return;
            }
        }

        // if the plugin requires a restart, don't use stopPlugin/startPlugin. Wait for restart to apply changes.
        if (pluginRequiresRestart(plugin)) {
            settings.enabled = !wasEnabled;
            onRestartNeeded(plugin.name, "enabled");
            return;
        }

        // If the plugin is enabled, but hasn't been started, then we can just toggle it off.
        if (wasEnabled && !plugin.started) {
            settings.enabled = !wasEnabled;
            return;
        }

        const result = wasEnabled ? stopPlugin(plugin) : startPlugin(plugin);

        if (!result) {
            settings.enabled = false;

            const msg = `Error while ${wasEnabled ? "stopping" : "starting"} plugin ${plugin.name}`;
            showToast(msg, Toasts.Type.FAILURE, {
                position: Toasts.Position.BOTTOM,
            });

            return;
        }

        settings.enabled = !wasEnabled;
    }

    const isUserHidden = Boolean(settings?.isUserHidden);
    const isUserPlugin = Boolean(PluginMeta[plugin.name]?.userPlugin);

    function toggleHide(e: React.MouseEvent) {
        e.stopPropagation();
        if (!settings) {
            Settings.plugins[plugin.name] = { enabled: isEnabled(), isUserHidden: !isUserHidden };
        } else {
            settings.isUserHidden = !isUserHidden;
        }
        showToast(isUserHidden ? `Unhid "${plugin.name}"` : `Moved "${plugin.name}" to Hidden`, Toasts.Type.SUCCESS);
    }

    function openEditModal(e: React.MouseEvent) {
        e.stopPropagation();
        openModal(modalProps => (
            <CustomPluginModal
                modalProps={modalProps}
                initialPluginName={plugin.name}
                initialPluginCode={getUserPluginCode(plugin.name)}
                isEditing={true}
            />
        ));
    }

    return (
        <AddonCard
            name={plugin.name}
            description={plugin.description}
            isNew={isNew}
            enabled={isEnabled()}
            setEnabled={toggleEnabled}
            disabled={disabled}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            infoButton={
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    {isUserPlugin && (
                        <>
                            <Tooltip text="Edit Plugin Script (.js)">
                                {tooltipProps => (
                                    <button
                                        {...tooltipProps}
                                        role="button"
                                        onClick={openEditModal}
                                        className={cl("info-button")}
                                    >
                                        <svg className={classes(cl("info-icon"), "vc-icon")} role="img" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                        </svg>
                                    </button>
                                )}
                            </Tooltip>
                            <Tooltip text="Delete Plugin">
                                {tooltipProps => (
                                    <button
                                        {...tooltipProps}
                                        role="button"
                                        onClick={async e => {
                                            e.stopPropagation();
                                            await deleteUserPlugin(plugin.name);
                                            showToast(`Deleted plugin "${plugin.name}"`, Toasts.Type.SUCCESS);
                                        }}
                                        className={cl("info-button")}
                                    >
                                        <svg className={classes(cl("info-icon"), "vc-icon")} role="img" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="3 6 5 6 21 6" />
                                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                        </svg>
                                    </button>
                                )}
                            </Tooltip>
                        </>
                    )}

                    <Tooltip text={isUserHidden ? "Unhide Plugin" : "Hide Plugin"}>
                        {tooltipProps => (
                            <button
                                {...tooltipProps}
                                role="switch"
                                onClick={toggleHide}
                                className={cl("info-button")}
                                style={{ color: isUserHidden ? "#ed4245" : undefined }}
                            >
                                <svg className={classes(cl("info-icon"), "vc-icon")} role="img" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    {isUserHidden ? (
                                        <>
                                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                            <line x1="1" y1="1" x2="23" y2="23" />
                                        </>
                                    ) : (
                                        <>
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                            <circle cx="12" cy="12" r="3" />
                                        </>
                                    )}
                                </svg>
                            </button>
                        )}
                    </Tooltip>

                    <button
                        role="switch"
                        onClick={() => openPluginModal(plugin, onRestartNeeded)}
                        className={cl("info-button")}
                    >
                        {hasAnyVisibleSettings(plugin)
                            ? <CogWheel className={cl("info-icon")} />
                            : <InfoIcon className={cl("info-icon")} />
                        }
                    </button>
                </div>
            } />
    );
}

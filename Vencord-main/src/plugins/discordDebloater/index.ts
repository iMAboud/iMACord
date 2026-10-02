/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { FluxDispatcher, SelectedChannelStore } from "@webpack/common";

import managedStyle from "./styles.css?managed";

const settings = definePluginSettings({
    suppressVoiceStats: {
        type: OptionType.BOOLEAN,
        description: "Drop MEDIA_ENGINE_CONNECTION_STATS when not in voice, throttle to 5s in voice",
        default: true
    },
    consolidateStylesheets: {
        type: OptionType.BOOLEAN,
        description: "Deduplicate and clean up empty runtime style tags to reduce style recalc cost",
        default: true
    },
    debloatElements: {
        type: OptionType.BOOLEAN,
        description: "Hide Nitro upsells, clips, and shop UI with rendering containment",
        default: true
    },
    throttleNoisyFlux: {
        type: OptionType.BOOLEAN,
        description: "Throttle non-critical Flux dispatches (typing events, redundant experiments)",
        default: true
    },
    idleGarbageCollection: {
        type: OptionType.BOOLEAN,
        description: "Trigger V8 garbage collection on idle if exposed via Electron flag",
        default: true
    }
});

interface FluxEvent {
    type: string;
    [key: string]: unknown;
}

type DispatchFn = (event: FluxEvent) => Promise<unknown> | void;

interface DispatcherWithInternals {
    dispatch: DispatchFn;
}

interface WindowWithGc extends Window {
    gc?: () => void;
}

export default definePlugin({
    name: "DiscordDebloater",
    description: "Deep client debloater and lag eliminator targeting Flux and stylesheet bloat",
    authors: [Devs.Ven],
    startAt: StartAt.WebpackReady,
    enabledByDefault: true,
    settings,

    cleanupTimer: null as ReturnType<typeof setInterval> | null,
    gcTimer: null as ReturnType<typeof setInterval> | null,
    originalDispatch: null as DispatchFn | null,
    lastVoiceStatsTime: 0,
    lastTypingTime: 0,
    lastGamesTime: 0,

    start() {
        if (settings.store.debloatElements) {
            enableStyle(managedStyle);
        }

        this.hookDispatcher();

        if (settings.store.consolidateStylesheets) {
            this.pruneStylesheets();
            this.cleanupTimer = setInterval(() => this.pruneStylesheets(), 20000);
        }

        if (settings.store.idleGarbageCollection) {
            this.gcTimer = setInterval(() => this.triggerGc(), 60000);
        }
    },

    stop() {
        disableStyle(managedStyle);

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        if (this.gcTimer) {
            clearInterval(this.gcTimer);
            this.gcTimer = null;
        }

        this.unhookDispatcher();
    },

    hookDispatcher() {
        const dispatcher = FluxDispatcher as unknown as DispatcherWithInternals | undefined;
        if (!dispatcher || typeof dispatcher.dispatch !== "function") return;

        this.originalDispatch = dispatcher.dispatch.bind(dispatcher);
        const original = this.originalDispatch;
        const self = this;

        dispatcher.dispatch = function (event: FluxEvent) {
            const eventType = event?.type;
            if (!eventType) return original(event);

            if (settings.store.suppressVoiceStats && eventType === "MEDIA_ENGINE_CONNECTION_STATS") {
                const inVoice = !!SelectedChannelStore?.getVoiceChannelId?.();
                if (!inVoice) {
                    return;
                }

                const now = performance.now();
                if (now - self.lastVoiceStatsTime < 5000) {
                    return;
                }
                self.lastVoiceStatsTime = now;
            }

            if (settings.store.throttleNoisyFlux) {
                if (eventType === "TRACK" || eventType === "EXPERIMENT_TRIGGER" || eventType.startsWith("QUESTS_FETCH_")) {
                    return;
                }

                if (eventType === "RUNNING_NON_GAMES_CHANGE") {
                    return;
                }

                if (eventType === "RUNNING_GAMES_CHANGE") {
                    const now = performance.now();
                    if (now - self.lastGamesTime < 30000) {
                        return;
                    }
                    self.lastGamesTime = now;
                }

                if (eventType === "TYPING_START_LOCAL") {
                    const now = performance.now();
                    if (now - self.lastTypingTime < 3000) {
                        return;
                    }
                    self.lastTypingTime = now;
                }
            }

            return original(event);
        };
    },

    unhookDispatcher() {
        const dispatcher = FluxDispatcher as unknown as DispatcherWithInternals | undefined;
        if (dispatcher && this.originalDispatch) {
            dispatcher.dispatch = this.originalDispatch;
            this.originalDispatch = null;
        }
    },

    pruneStylesheets() {
        try {
            const styleElements = Array.from(document.querySelectorAll<HTMLStyleElement>("head > style"));
            const seen = new Set<string>();

            for (const style of styleElements) {
                if (style.id?.includes("vencord") || style.hasAttribute("data-vencord") || style.hasAttribute("data-vencord-name")) {
                    continue;
                }

                const text = style.textContent?.trim();
                if (!text && style.sheet?.cssRules?.length === 0) {
                    style.remove();
                    continue;
                }

                if (text && text.length > 80) {
                    if (seen.has(text)) {
                        style.remove();
                    } else {
                        seen.add(text);
                    }
                }
            }
        } catch {
            // Non-critical background style pruning
        }
    },

    triggerGc() {
        try {
            const win = window as unknown as WindowWithGc;
            if (typeof win.gc === "function") {
                win.gc();
            }
        } catch {
            // Non-critical memory cleanup
        }
    }
});

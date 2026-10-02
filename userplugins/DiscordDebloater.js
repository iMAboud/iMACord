import definePlugin, { StartAt } from "@utils/types";
import { FluxDispatcher, SelectedChannelStore } from "@webpack/common";

const STYLE_ID = "vencord-discord-debloater-css";
const DEBLOAT_CSS = `
[data-list-id="chat-messages"] [id^="chat-messages-"] {
    contain-intrinsic-size: auto 48px;
    content-visibility: auto;
}
[class*="nitroGiftButton"],
[class*="giftCodeContainer"],
[class*="premiumFeature"],
[class*="upsellBanner"],
[class*="nitroUpsell"],
[class*="premiumTab"],
[class*="badgeList_"] [aria-label*="Nitro"],
[href="/shop"],
[class*="clipsIcon"],
[class*="recordClipButton"],
[class*="partyContainer"],
[class*="burstReactionPicker"] {
    display: none !important;
    contain: strict !important;
    content-visibility: hidden !important;
}
svg {
    shape-rendering: geometricprecision;
}
`;

export default definePlugin({
    name: "DiscordDebloater",
    description: "Deep client debloater and lag eliminator targeting Flux and stylesheet bloat",
    authors: [{ name: "Performance Debloater", id: 0n }],
    startAt: StartAt.WebpackReady,
    enabledByDefault: true,

    start() {
        this.injectCss();
        this.hookDispatcher();
        this.pruneStylesheets();
        this.cleanupTimer = setInterval(() => this.pruneStylesheets(), 20000);
        this.gcTimer = setInterval(() => this.triggerGc(), 60000);
    },

    stop() {
        this.removeCss();
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.gcTimer) clearInterval(this.gcTimer);
        this.unhookDispatcher();
    },

    injectCss() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = DEBLOAT_CSS;
        document.head.appendChild(style);
    },

    removeCss() {
        document.getElementById(STYLE_ID)?.remove();
    },

    hookDispatcher() {
        const dispatcher = FluxDispatcher || window.Vencord?.Webpack?.Common?.FluxDispatcher;
        if (!dispatcher || typeof dispatcher.dispatch !== "function") return;

        this.originalDispatch = dispatcher.dispatch.bind(dispatcher);
        this.dispatcherInstance = dispatcher;
        const original = this.originalDispatch;
        let lastVoiceTime = 0;
        let lastTyping = 0;
        let lastGamesTime = 0;

        dispatcher.dispatch = function (event) {
            const type = event?.type;
            if (!type) return original(event);

            if (type === "MEDIA_ENGINE_CONNECTION_STATS") {
                const store = SelectedChannelStore || window.Vencord?.Webpack?.Common?.SelectedChannelStore;
                const inVoice = !!store?.getVoiceChannelId?.();
                if (!inVoice) return;

                const now = performance.now();
                if (now - lastVoiceTime < 5000) return;
                lastVoiceTime = now;
            }

            if (type === "TRACK" || type === "EXPERIMENT_TRIGGER" || type.startsWith("QUESTS_FETCH_")) {
                return;
            }

            if (type === "RUNNING_NON_GAMES_CHANGE") {
                return;
            }

            if (type === "RUNNING_GAMES_CHANGE") {
                const now = performance.now();
                if (now - lastGamesTime < 30000) return;
                lastGamesTime = now;
            }

            if (type === "TYPING_START_LOCAL") {
                const now = performance.now();
                if (now - lastTyping < 3000) return;
                lastTyping = now;
            }

            return original(event);
        };
    },

    unhookDispatcher() {
        if (this.dispatcherInstance && this.originalDispatch) {
            this.dispatcherInstance.dispatch = this.originalDispatch;
            this.originalDispatch = null;
            this.dispatcherInstance = null;
        }
    },

    pruneStylesheets() {
        try {
            const styles = Array.from(document.querySelectorAll("head > style"));
            const seen = new Set();
            for (const style of styles) {
                if (style.id?.includes("vencord") || style.hasAttribute("data-vencord")) continue;
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
        } catch {}
    },

    triggerGc() {
        try {
            if (typeof window.gc === "function") window.gc();
        } catch {}
    }
});

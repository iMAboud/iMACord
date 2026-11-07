import definePlugin, { StartAt } from "@utils/types";
import { FluxDispatcher, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

const STORAGE_KEY = "Vencord_ElementHider_Rules_v1";
const IDB_NAME = "VencordElementHiderDB";
const IDB_STORE = "rules_store";
const STYLE_ID = "vc-element-hider-persistent-style";
const PREVIEW_STYLE_ID = "vc-element-hider-preview-style";
const UI_STYLE_ID = "vc-element-hider-ui-style";
const OVERLAY_ID = "vc-element-hider-highlight-overlay";
const POPUP_ID = "vc-element-hider-popup";

const FORBIDDEN_TAGS = new Set(["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "LINK", "META"]);

function getCommonStores() {
    const fallbackCommon =
        (typeof window !== "undefined" &&
            window.Vencord &&
            window.Vencord.Webpack &&
            window.Vencord.Webpack.Common) ||
        {};

    return {
        FluxDispatcher:
            typeof FluxDispatcher !== "undefined"
                ? FluxDispatcher
                : fallbackCommon.FluxDispatcher,
        Toasts:
            typeof Toasts !== "undefined"
                ? Toasts
                : fallbackCommon.Toasts,
        UserStore:
            typeof UserStore !== "undefined"
                ? UserStore
                : fallbackCommon.UserStore,
        SelectedChannelStore:
            typeof SelectedChannelStore !== "undefined"
                ? SelectedChannelStore
                : fallbackCommon.SelectedChannelStore
    };
}

let cachedStorage = null;
function getPersistentLocalStorage() {
    if (cachedStorage) return cachedStorage;

    // 1. Vencord's preserved localStorage reference (captured before Discord deletes window.localStorage)
    try {
        if (
            typeof window !== "undefined" &&
            window.Vencord &&
            window.Vencord.Util &&
            window.Vencord.Util.localStorage
        ) {
            cachedStorage = window.Vencord.Util.localStorage;
            return cachedStorage;
        }
    } catch {}

    // 2. Direct window.localStorage if still present
    try {
        if (typeof window !== "undefined" && window.localStorage) {
            cachedStorage = window.localStorage;
            return cachedStorage;
        }
    } catch {}

    // 3. Same-origin iframe trick to recover localStorage after Discord deletes window.localStorage
    try {
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        (document.head || document.documentElement).appendChild(iframe);
        if (iframe.contentWindow && iframe.contentWindow.localStorage) {
            cachedStorage = iframe.contentWindow.localStorage;
        }
        iframe.remove();
        if (cachedStorage) return cachedStorage;
    } catch {}

    return null;
}

function idbLoadRules() {
    return new Promise(resolve => {
        try {
            if (typeof indexedDB === "undefined") {
                resolve(null);
                return;
            }
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => {
                try {
                    const db = req.result;
                    const tx = db.transaction(IDB_STORE, "readonly");
                    const store = tx.objectStore(IDB_STORE);
                    const getReq = store.get(STORAGE_KEY);
                    getReq.onsuccess = () => {
                        resolve(Array.isArray(getReq.result) ? getReq.result : null);
                        db.close();
                    };
                    getReq.onerror = () => {
                        resolve(null);
                        db.close();
                    };
                } catch {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

function idbSaveRules(rules) {
    try {
        if (typeof indexedDB === "undefined") return;
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => {
            try {
                const db = req.result;
                const tx = db.transaction(IDB_STORE, "readwrite");
                const store = tx.objectStore(IDB_STORE);
                store.put(rules, STORAGE_KEY);
                tx.oncomplete = () => db.close();
                tx.onerror = () => db.close();
            } catch {}
        };
    } catch {}
}

function isProtectedElement(el) {
    if (!el || !(el instanceof Element)) return true;
    if (FORBIDDEN_TAGS.has(el.tagName)) return true;
    if (el.id === "app-mount" || el.id === POPUP_ID || el.id === OVERLAY_ID) return true;
    if (el.closest(`#${POPUP_ID}`) || el.closest(`#${OVERLAY_ID}`)) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width >= window.innerWidth * 0.98 && rect.height >= window.innerHeight * 0.98) {
        return true;
    }
    return false;
}

function escapeCssIdentifier(str) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(str);
    }
    return String(str).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function getStableClassSelector(el, smartMode = true) {
    const classList = Array.from(el.classList || []).filter(
        cls => cls && !cls.startsWith("vc-element-hider")
    );
    if (classList.length === 0) return "";

    if (smartMode) {
        const stableParts = [];
        for (const cls of classList.slice(0, 3)) {
            const match = cls.match(/^([a-zA-Z0-9]+[-_])[a-zA-Z0-9]{5,8}$/);
            if (match) {
                stableParts.push(`[class*="${match[1]}"]`);
            } else {
                stableParts.push(`.${escapeCssIdentifier(cls)}`);
            }
        }
        return stableParts.join("");
    }

    return classList.map(c => `.${escapeCssIdentifier(c)}`).join("");
}

function getSingleElementSegment(el, smartMode = true) {
    const tag = el.tagName.toLowerCase();

    if (el.id && !/^\d+$/.test(el.id)) {
        return `${tag}#${escapeCssIdentifier(el.id)}`;
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.length < 48 && !/\d{5,}/.test(ariaLabel)) {
        const safeLabel = ariaLabel.replace(/"/g, '\\"');
        return `${tag}[aria-label="${safeLabel}"]`;
    }

    const dataListItemId = el.getAttribute("data-list-item-id");
    if (dataListItemId && smartMode) {
        const safeId = dataListItemId.replace(/"/g, '\\"');
        return `${tag}[data-list-item-id="${safeId}"]`;
    }

    const classSel = getStableClassSelector(el, smartMode);
    if (classSel) {
        return `${tag}${classSel}`;
    }

    const role = el.getAttribute("role");
    if (role) {
        return `${tag}[role="${role.replace(/"/g, '\\"')}"]`;
    }

    return tag;
}

function generateSelectorForElement(targetEl, smartMode = true) {
    if (!targetEl || !(targetEl instanceof Element)) return "";

    const single = getSingleElementSegment(targetEl, smartMode);
    try {
        if (smartMode && document.querySelectorAll(single).length === 1) {
            return single;
        }
    } catch {
        // Fallback to hierarchical selector builder
    }

    const segments = [];
    let current = targetEl;
    let depth = 0;

    while (
        current &&
        current instanceof Element &&
        !FORBIDDEN_TAGS.has(current.tagName) &&
        current.id !== "app-mount" &&
        depth < 5
    ) {
        let segment = getSingleElementSegment(current, smartMode);

        const parent = current.parentElement;
        if (parent) {
            const sameTagSiblings = Array.from(parent.children).filter(
                child => child.tagName === current.tagName
            );
            if (!smartMode && sameTagSiblings.length > 1) {
                const index = sameTagSiblings.indexOf(current) + 1;
                segment += `:nth-of-type(${index})`;
            } else if (smartMode && sameTagSiblings.length > 1) {
                try {
                    const testMatches = parent.querySelectorAll(`:scope > ${segment}`);
                    if (testMatches.length > 1) {
                        const index = sameTagSiblings.indexOf(current) + 1;
                        segment += `:nth-of-type(${index})`;
                    }
                } catch {
                    // Ignore invalid selector check
                }
            }
        }

        segments.unshift(segment);

        const candidate = segments.join(" > ");
        try {
            if (document.querySelectorAll(candidate).length === 1) {
                return candidate;
            }
        } catch {
            // Continue climbing
        }

        current = parent;
        depth++;
    }

    return segments.join(" > ");
}

function describeElement(el) {
    if (!el || !(el instanceof Element)) return "Unknown Element";
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const aria = el.getAttribute("aria-label");
    const firstClass = el.classList && el.classList.length > 0 ? `.${el.classList[0]}` : "";
    const textSample = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);

    let label = `${tag}${id || firstClass}`;
    if (aria) {
        label += ` [aria-label="${aria.slice(0, 24)}"]`;
    } else if (textSample) {
        label += ` ("${textSample}${el.textContent.trim().length > 28 ? "…" : ""}")`;
    }
    return label;
}

export default definePlugin({
    name: "ElementHider",
    description: "uBlock Origin-style element picker for Discord. Hold Ctrl + Right-Click on any element to preview hiding with a depth slider, save persistent rules, and inspect or revert hidden elements.",
    authors: [{ name: "CustomUser", id: 0n }],
    startAt: StartAt.WebpackReady,
    enabledByDefault: true,

    rules: [],
    ancestorChain: [],
    currentDepthIndex: 0,
    currentSelectorValue: "",
    smartSelectorMode: true,
    isPreviewActive: false,
    hoveredRuleId: null,
    activeTab: "picker",

    popupEl: null,
    overlayEl: null,
    persistentStyleEl: null,
    previewStyleEl: null,
    uiStyleEl: null,
    headObserver: null,

    boundContextMenu: null,
    boundKeyDown: null,
    boundWindowResize: null,
    fluxSubscription: null,

    start() {
        this.injectUiStyles();
        this.loadRules();
        this.setupStyleGuard();

        this.boundContextMenu = this.onContextMenu.bind(this);
        this.boundKeyDown = this.onKeyDown.bind(this);
        this.boundWindowResize = this.updateHighlightBox.bind(this);

        document.addEventListener("contextmenu", this.boundContextMenu, true);
        document.addEventListener("keydown", this.boundKeyDown, true);
        window.addEventListener("resize", this.boundWindowResize, true);

        const { FluxDispatcher: dispatcher } = getCommonStores();
        if (dispatcher && typeof dispatcher.subscribe === "function") {
            this.fluxSubscription = () => {
                this.applyPersistentRules();
            };
            dispatcher.subscribe("CHANNEL_SELECT", this.fluxSubscription);
        }
    },

    stop() {
        if (this.headObserver) {
            this.headObserver.disconnect();
            this.headObserver = null;
        }
        if (this.boundContextMenu) {
            document.removeEventListener("contextmenu", this.boundContextMenu, true);
            this.boundContextMenu = null;
        }
        if (this.boundKeyDown) {
            document.removeEventListener("keydown", this.boundKeyDown, true);
            this.boundKeyDown = null;
        }
        if (this.boundWindowResize) {
            window.removeEventListener("resize", this.boundWindowResize, true);
            this.boundWindowResize = null;
        }

        const { FluxDispatcher: dispatcher } = getCommonStores();
        if (this.fluxSubscription && dispatcher && typeof dispatcher.unsubscribe === "function") {
            dispatcher.unsubscribe("CHANNEL_SELECT", this.fluxSubscription);
            this.fluxSubscription = null;
        }

        this.closePopup();
        this.removeStyleElement(STYLE_ID);
        this.removeStyleElement(PREVIEW_STYLE_ID);
        this.removeStyleElement(UI_STYLE_ID);

        this.persistentStyleEl = null;
        this.previewStyleEl = null;
        this.uiStyleEl = null;
        this.ancestorChain = [];
        this.hoveredRuleId = null;
    },

    setupStyleGuard() {
        if (typeof MutationObserver === "undefined" || !document.head) return;
        this.headObserver = new MutationObserver(() => {
            if (!document.getElementById(STYLE_ID) && this.rules.length > 0) {
                this.applyPersistentRules();
            }
            if (!document.getElementById(UI_STYLE_ID)) {
                this.injectUiStyles();
            }
        });
        this.headObserver.observe(document.head, { childList: true });
    },

    loadRules() {
        let loaded = null;

        // 1. Try Vencord.Settings.plugins.ElementHider.savedRules (persisted natively by Vencord/iMACord)
        try {
            const pluginSettings =
                typeof window !== "undefined" &&
                window.Vencord &&
                window.Vencord.Settings &&
                window.Vencord.Settings.plugins &&
                window.Vencord.Settings.plugins.ElementHider;
            if (pluginSettings && Array.isArray(pluginSettings.savedRules)) {
                loaded = pluginSettings.savedRules;
            }
        } catch {}

        // 2. Try Vencord.Util.localStorage / iframe-recovered localStorage
        if (!loaded || loaded.length === 0) {
            try {
                const storage = getPersistentLocalStorage();
                if (storage) {
                    const raw = storage.getItem(STORAGE_KEY);
                    const parsed = raw ? JSON.parse(raw) : null;
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        loaded = parsed;
                    }
                }
            } catch {}
        }

        if (Array.isArray(loaded)) {
            this.rules = loaded;
            this.applyPersistentRules();
        }

        // 3. Also check Vencord.Api.DataStore and IndexedDB asynchronously (survives even if localStorage is cleared)
        try {
            const dataStore =
                typeof window !== "undefined" &&
                window.Vencord &&
                window.Vencord.Api &&
                window.Vencord.Api.DataStore;
            if (dataStore && typeof dataStore.get === "function") {
                Promise.resolve(dataStore.get(STORAGE_KEY))
                    .then(res => {
                        if (Array.isArray(res) && res.length > 0 && this.rules.length === 0) {
                            this.rules = res;
                            this.applyPersistentRules();
                            if (this.popupEl) this.renderPopup();
                        }
                    })
                    .catch(() => {});
            }
        } catch {}

        idbLoadRules().then(idbRules => {
            if (Array.isArray(idbRules) && idbRules.length > 0 && this.rules.length === 0) {
                this.rules = idbRules;
                this.applyPersistentRules();
                if (this.popupEl) this.renderPopup();
            }
        });
    },

    saveRules() {
        const serialized = JSON.stringify(this.rules);
        const cleanCopy = JSON.parse(serialized);

        // 1. Save to Vencord.Settings.plugins.ElementHider (synced to disk by Vencord/iMACord)
        try {
            if (
                typeof window !== "undefined" &&
                window.Vencord &&
                window.Vencord.Settings &&
                window.Vencord.Settings.plugins
            ) {
                if (!window.Vencord.Settings.plugins.ElementHider) {
                    window.Vencord.Settings.plugins.ElementHider = {};
                }
                window.Vencord.Settings.plugins.ElementHider.savedRules = cleanCopy;
            }
        } catch {}

        // 2. Save to Vencord.Util.localStorage / iframe-recovered localStorage
        try {
            const storage = getPersistentLocalStorage();
            if (storage) {
                storage.setItem(STORAGE_KEY, serialized);
            }
        } catch {}

        // 3. Save to Vencord.Api.DataStore (IndexedDB-backed)
        try {
            const dataStore =
                typeof window !== "undefined" &&
                window.Vencord &&
                window.Vencord.Api &&
                window.Vencord.Api.DataStore;
            if (dataStore && typeof dataStore.set === "function") {
                dataStore.set(STORAGE_KEY, cleanCopy);
            }
        } catch {}

        // 4. Save to native IndexedDB directly as rock-solid fallback
        idbSaveRules(cleanCopy);

        this.applyPersistentRules();
    },

    notify(message, type = "SUCCESS") {
        try {
            const { Toasts: toastsApi } = getCommonStores();
            if (toastsApi && typeof toastsApi.show === "function") {
                toastsApi.show({
                    message,
                    id: toastsApi.genId ? toastsApi.genId() : String(Date.now()),
                    type: (toastsApi.Type && toastsApi.Type[type]) || 1,
                    options: { position: (toastsApi.Position && toastsApi.Position.BOTTOM) || 1 }
                });
            }
        } catch {
            // Ignore toast errors if unavailable
        }
    },

    removeStyleElement(id) {
        const existing = document.getElementById(id);
        if (existing) existing.remove();
    },

    injectUiStyles() {
        this.removeStyleElement(UI_STYLE_ID);
        const style = document.createElement("style");
        style.id = UI_STYLE_ID;
        style.textContent = `
            #${OVERLAY_ID} {
                position: fixed;
                pointer-events: none;
                z-index: 999998;
                border: 2px solid #ed4245;
                background: rgba(237, 66, 69, 0.18);
                box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5), inset 0 0 8px rgba(237, 66, 69, 0.28);
                border-radius: 4px;
                transition: top 0.06s ease, left 0.06s ease, width 0.06s ease, height 0.06s ease;
            }
            #${POPUP_ID} {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 420px;
                max-width: calc(100vw - 32px);
                background: #1e1f22;
                color: #f2f3f5;
                border: 1px solid #3f4147;
                border-radius: 10px;
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
                z-index: 999999;
                font-family: var(--font-primary, "gg sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
                font-size: 13px;
                user-select: none;
                overflow: hidden;
            }
            #${POPUP_ID} * {
                box-sizing: border-box;
            }
            .vc-eh-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: #111214;
                border-bottom: 1px solid #2b2d31;
                cursor: grab;
            }
            .vc-eh-header:active {
                cursor: grabbing;
            }
            .vc-eh-title {
                font-weight: 700;
                font-size: 13px;
                color: #ffffff;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .vc-eh-badge {
                background: #5865f2;
                color: #fff;
                font-size: 11px;
                padding: 2px 6px;
                border-radius: 999px;
                font-weight: 600;
            }
            .vc-eh-tabs {
                display: flex;
                background: #2b2d31;
                padding: 4px;
                gap: 4px;
            }
            .vc-eh-tab {
                flex: 1;
                text-align: center;
                padding: 6px 8px;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                color: #b5bac1;
                background: transparent;
                border: none;
                transition: background 0.15s, color 0.15s;
            }
            .vc-eh-tab.active {
                background: #404249;
                color: #ffffff;
            }
            .vc-eh-body {
                padding: 14px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                max-height: 410px;
                overflow-y: auto;
            }
            .vc-eh-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .vc-eh-label {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                color: #949ba4;
            }
            .vc-eh-slider-wrap {
                display: flex;
                align-items: center;
                gap: 8px;
                background: #2b2d31;
                padding: 8px 10px;
                border-radius: 8px;
            }
            .vc-eh-step-btn {
                width: 26px;
                height: 26px;
                border-radius: 6px;
                border: 1px solid #4e5058;
                background: #313338;
                color: #f2f3f5;
                font-weight: 700;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .vc-eh-step-btn:hover:not(:disabled) {
                background: #404249;
            }
            .vc-eh-step-btn:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }
            .vc-eh-slider {
                flex: 1;
                accent-color: #5865f2;
                cursor: pointer;
            }
            .vc-eh-selector-input {
                width: 100%;
                min-height: 54px;
                background: #111214;
                color: #dbdee1;
                border: 1px solid #3f4147;
                border-radius: 6px;
                padding: 8px;
                font-family: monospace;
                font-size: 12px;
                resize: vertical;
                user-select: text;
            }
            .vc-eh-selector-input:focus {
                outline: none;
                border-color: #5865f2;
            }
            .vc-eh-meta {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 12px;
                color: #b5bac1;
                background: #2b2d31;
                padding: 6px 10px;
                border-radius: 6px;
            }
            .vc-eh-actions {
                display: flex;
                gap: 8px;
                margin-top: 2px;
            }
            .vc-eh-btn {
                flex: 1;
                padding: 8px 12px;
                border-radius: 6px;
                border: none;
                font-weight: 600;
                font-size: 12px;
                cursor: pointer;
                transition: filter 0.15s, background 0.15s;
            }
            .vc-eh-btn:hover {
                filter: brightness(1.1);
            }
            .vc-eh-btn-primary {
                background: #da373c;
                color: #ffffff;
            }
            .vc-eh-btn-secondary {
                background: #4e5058;
                color: #ffffff;
            }
            .vc-eh-btn-preview {
                background: #2b2d31;
                border: 1px solid #5865f2;
                color: #f2f3f5;
            }
            .vc-eh-btn-preview.active {
                background: #5865f2;
                color: #ffffff;
            }
            .vc-eh-rule-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .vc-eh-rule-item {
                background: #2b2d31;
                border: 1px solid #3f4147;
                border-radius: 8px;
                padding: 8px 10px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                transition: border-color 0.15s;
            }
            .vc-eh-rule-item:hover {
                border-color: #5865f2;
            }
            .vc-eh-rule-info {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 3px;
            }
            .vc-eh-rule-label {
                font-weight: 600;
                color: #f2f3f5;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .vc-eh-rule-selector {
                font-family: monospace;
                font-size: 11px;
                color: #949ba4;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .vc-eh-rule-controls {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .vc-eh-small-btn {
                padding: 4px 8px;
                border-radius: 5px;
                border: none;
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                background: #da373c;
                color: #fff;
            }
            .vc-eh-empty {
                text-align: center;
                color: #949ba4;
                padding: 20px 10px;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
        this.uiStyleEl = style;
    },

    applyPersistentRules() {
        let style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement("style");
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        this.persistentStyleEl = style;

        const activeSelectors = this.rules
            .filter(r => r && r.enabled !== false && r.selector && r.id !== this.hoveredRuleId)
            .map(r => `${r.selector} { display: none !important; }`);

        style.textContent = activeSelectors.join("\n");
    },

    applyPreviewSelector(selector) {
        let style = document.getElementById(PREVIEW_STYLE_ID);
        if (!style) {
            style = document.createElement("style");
            style.id = PREVIEW_STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        this.previewStyleEl = style;

        if (!this.isPreviewActive || !selector || this.activeTab !== "picker") {
            style.textContent = "";
            return;
        }

        try {
            document.querySelectorAll(selector);
            style.textContent = `${selector} { display: none !important; }`;
        } catch {
            style.textContent = "";
        }
    },

    buildAncestorChain(startEl) {
        const chain = [];
        let curr = startEl;
        while (curr && curr instanceof Element && !isProtectedElement(curr)) {
            chain.push(curr);
            curr = curr.parentElement;
        }
        return chain;
    },

    onContextMenu(e) {
        if (!e.ctrlKey && !e.metaKey) return;

        if (e.target && e.target instanceof Element && e.target.closest(`#${POPUP_ID}`)) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        this.applyPreviewSelector("");

        const target = e.target instanceof Element ? e.target : null;
        if (!target || isProtectedElement(target)) {
            this.activeTab = "manager";
            this.ancestorChain = [];
            this.currentDepthIndex = 0;
            this.openPopup();
            return;
        }

        this.ancestorChain = this.buildAncestorChain(target);
        if (this.ancestorChain.length === 0) {
            this.activeTab = "manager";
            this.openPopup();
            return;
        }

        this.currentDepthIndex = 0;
        this.activeTab = e.shiftKey ? "manager" : "picker";
        this.isPreviewActive = false;
        this.openPopup();
    },

    onKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key && e.key.toLowerCase() === "h") {
            e.preventDefault();
            e.stopPropagation();
            this.activeTab = "manager";
            this.isPreviewActive = false;
            this.openPopup();
            return;
        }

        if (!this.popupEl) return;
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closePopup();
        }
    },

    getCurrentElement() {
        return this.ancestorChain[this.currentDepthIndex] || null;
    },

    highlightElementRect(el) {
        if (!el || !(el instanceof Element) || !document.body.contains(el)) {
            if (this.overlayEl) this.overlayEl.style.display = "none";
            return;
        }

        if (!this.overlayEl) {
            this.overlayEl = document.createElement("div");
            this.overlayEl.id = OVERLAY_ID;
            document.body.appendChild(this.overlayEl);
        }

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) {
            this.overlayEl.style.display = "none";
            return;
        }

        this.overlayEl.style.display = "block";
        this.overlayEl.style.top = `${Math.max(0, rect.top)}px`;
        this.overlayEl.style.left = `${Math.max(0, rect.left)}px`;
        this.overlayEl.style.width = `${Math.max(0, rect.width)}px`;
        this.overlayEl.style.height = `${Math.max(0, rect.height)}px`;
    },

    updateHighlightBox() {
        if (!this.popupEl) {
            if (this.overlayEl) this.overlayEl.style.display = "none";
            return;
        }

        if (this.activeTab === "manager") {
            if (!this.hoveredRuleId) {
                if (this.overlayEl) this.overlayEl.style.display = "none";
                return;
            }
            const hoveredRule = this.rules.find(r => r.id === this.hoveredRuleId);
            if (!hoveredRule || !hoveredRule.selector) {
                if (this.overlayEl) this.overlayEl.style.display = "none";
                return;
            }
            try {
                const match = document.querySelector(hoveredRule.selector);
                this.highlightElementRect(match);
            } catch {
                if (this.overlayEl) this.overlayEl.style.display = "none";
            }
            return;
        }

        if (this.isPreviewActive) {
            if (this.overlayEl) this.overlayEl.style.display = "none";
            return;
        }

        this.highlightElementRect(this.getCurrentElement());
    },

    openPopup() {
        if (!this.popupEl) {
            this.popupEl = document.createElement("div");
            this.popupEl.id = POPUP_ID;
            document.body.appendChild(this.popupEl);
        }
        this.renderPopup();
    },

    closePopup() {
        this.hoveredRuleId = null;
        this.applyPersistentRules();
        this.applyPreviewSelector("");
        if (this.overlayEl) {
            this.overlayEl.remove();
            this.overlayEl = null;
        }
        if (this.popupEl) {
            this.popupEl.remove();
            this.popupEl = null;
        }
    },

    makeHeaderDraggable(headerEl) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        const onMouseMove = e => {
            if (!isDragging || !this.popupEl) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const nextLeft = Math.min(
                window.innerWidth - this.popupEl.offsetWidth - 8,
                Math.max(8, initialLeft + dx)
            );
            const nextTop = Math.min(
                window.innerHeight - this.popupEl.offsetHeight - 8,
                Math.max(8, initialTop + dy)
            );
            this.popupEl.style.left = `${nextLeft}px`;
            this.popupEl.style.top = `${nextTop}px`;
            this.popupEl.style.right = "auto";
            this.popupEl.style.bottom = "auto";
        };

        const onMouseUp = () => {
            isDragging = false;
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };

        headerEl.addEventListener("mousedown", e => {
            if (e.target.tagName === "BUTTON") return;
            isDragging = true;
            const rect = this.popupEl.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = rect.left;
            initialTop = rect.top;
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    },

    countSelectorMatches(selector) {
        if (!selector) return 0;
        try {
            return document.querySelectorAll(selector).length;
        } catch {
            return -1;
        }
    },

    renderPopup() {
        if (!this.popupEl) return;

        const currentEl = this.getCurrentElement();
        const maxDepth = Math.max(0, this.ancestorChain.length - 1);
        const generatedSelector = currentEl
            ? generateSelectorForElement(currentEl, this.smartSelectorMode)
            : "";

        this.popupEl.innerHTML = "";

        const header = document.createElement("div");
        header.className = "vc-eh-header";

        const titleWrap = document.createElement("div");
        titleWrap.className = "vc-eh-title";
        titleWrap.innerHTML = `<span>Element Hider</span><span class="vc-eh-badge">${this.rules.length} saved</span>`;

        const closeBtn = document.createElement("button");
        closeBtn.className = "vc-eh-step-btn";
        closeBtn.textContent = "✕";
        closeBtn.title = "Close (Esc)";
        closeBtn.addEventListener("click", () => this.closePopup());

        header.appendChild(titleWrap);
        header.appendChild(closeBtn);
        this.makeHeaderDraggable(header);
        this.popupEl.appendChild(header);

        const tabs = document.createElement("div");
        tabs.className = "vc-eh-tabs";

        const pickerTabBtn = document.createElement("button");
        pickerTabBtn.className = `vc-eh-tab ${this.activeTab === "picker" ? "active" : ""}`;
        pickerTabBtn.textContent = "Element Picker";
        pickerTabBtn.addEventListener("click", () => {
            this.hoveredRuleId = null;
            this.applyPersistentRules();
            this.activeTab = "picker";
            this.renderPopup();
        });

        const managerTabBtn = document.createElement("button");
        managerTabBtn.className = `vc-eh-tab ${this.activeTab === "manager" ? "active" : ""}`;
        managerTabBtn.textContent = `Hidden Elements (${this.rules.length})`;
        managerTabBtn.addEventListener("click", () => {
            this.activeTab = "manager";
            this.applyPreviewSelector("");
            this.renderPopup();
        });

        tabs.appendChild(pickerTabBtn);
        tabs.appendChild(managerTabBtn);
        this.popupEl.appendChild(tabs);

        const body = document.createElement("div");
        body.className = "vc-eh-body";

        if (this.activeTab === "picker") {
            this.renderPickerTab(body, currentEl, maxDepth, generatedSelector);
        } else {
            this.renderManagerTab(body);
        }

        this.popupEl.appendChild(body);
        this.updateHighlightBox();
        this.applyPreviewSelector(this.currentSelectorValue || generatedSelector);
    },

    renderPickerTab(body, currentEl, maxDepth, generatedSelector) {
        if (!currentEl) {
            const empty = document.createElement("div");
            empty.className = "vc-eh-empty";
            empty.textContent = "Hold Ctrl + Right-Click on any Discord UI element to inspect and hide it.";
            body.appendChild(empty);
            return;
        }

        this.currentSelectorValue = generatedSelector;

        const targetRow = document.createElement("div");
        targetRow.className = "vc-eh-row";
        const targetLabel = document.createElement("span");
        targetLabel.className = "vc-eh-label";
        targetLabel.textContent = `Depth ${this.currentDepthIndex + 1} of ${maxDepth + 1}: ${describeElement(currentEl)}`;
        targetRow.appendChild(targetLabel);
        body.appendChild(targetRow);

        const sliderWrap = document.createElement("div");
        sliderWrap.className = "vc-eh-slider-wrap";

        const minusBtn = document.createElement("button");
        minusBtn.className = "vc-eh-step-btn";
        minusBtn.textContent = "−";
        minusBtn.title = "More specific child element";
        minusBtn.disabled = this.currentDepthIndex <= 0;

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "vc-eh-slider";
        slider.min = "0";
        slider.max = String(maxDepth);
        slider.value = String(this.currentDepthIndex);

        const plusBtn = document.createElement("button");
        plusBtn.className = "vc-eh-step-btn";
        plusBtn.textContent = "+";
        plusBtn.title = "Broader parent container";
        plusBtn.disabled = this.currentDepthIndex >= maxDepth;

        const updateDepth = nextIndex => {
            const clamped = Math.max(0, Math.min(maxDepth, nextIndex));
            if (clamped === this.currentDepthIndex) return;
            this.currentDepthIndex = clamped;
            this.renderPopup();
        };

        minusBtn.addEventListener("click", () => updateDepth(this.currentDepthIndex - 1));
        plusBtn.addEventListener("click", () => updateDepth(this.currentDepthIndex + 1));
        slider.addEventListener("input", e => {
            this.currentDepthIndex = Number(e.target.value);
            const el = this.getCurrentElement();
            const nextSel = generateSelectorForElement(el, this.smartSelectorMode);
            this.currentSelectorValue = nextSel;
            targetLabel.textContent = `Depth ${this.currentDepthIndex + 1} of ${maxDepth + 1}: ${describeElement(el)}`;
            selectorInput.value = nextSel;
            minusBtn.disabled = this.currentDepthIndex <= 0;
            plusBtn.disabled = this.currentDepthIndex >= maxDepth;
            updateMatchCounter(nextSel);
            this.updateHighlightBox();
            this.applyPreviewSelector(nextSel);
        });

        sliderWrap.appendChild(minusBtn);
        sliderWrap.appendChild(slider);
        sliderWrap.appendChild(plusBtn);
        body.appendChild(sliderWrap);

        const modeRow = document.createElement("div");
        modeRow.className = "vc-eh-row";

        const selHeader = document.createElement("span");
        selHeader.className = "vc-eh-label";
        selHeader.textContent = "CSS Filter Selector";

        const smartToggle = document.createElement("label");
        smartToggle.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;color:#b5bac1;cursor:pointer;";
        const smartCheckbox = document.createElement("input");
        smartCheckbox.type = "checkbox";
        smartCheckbox.checked = this.smartSelectorMode;
        smartCheckbox.addEventListener("change", () => {
            this.smartSelectorMode = smartCheckbox.checked;
            this.renderPopup();
        });
        smartToggle.appendChild(smartCheckbox);
        smartToggle.appendChild(document.createTextNode("Smart Discord classes"));

        modeRow.appendChild(selHeader);
        modeRow.appendChild(smartToggle);
        body.appendChild(modeRow);

        const selectorInput = document.createElement("textarea");
        selectorInput.className = "vc-eh-selector-input";
        selectorInput.value = generatedSelector;
        selectorInput.spellcheck = false;

        const metaBar = document.createElement("div");
        metaBar.className = "vc-eh-meta";
        const matchSpan = document.createElement("span");
        const contextSpan = document.createElement("span");

        let contextText = "Global UI";
        try {
            const { UserStore: userStore, SelectedChannelStore: channelStore } = getCommonStores();
            const channelId =
                channelStore && typeof channelStore.getChannelId === "function"
                    ? channelStore.getChannelId()
                    : null;
            const currentUser =
                userStore && typeof userStore.getCurrentUser === "function"
                    ? userStore.getCurrentUser()
                    : null;

            if (channelId) {
                contextText = `Channel: ${String(channelId).slice(0, 8)}…`;
            } else if (currentUser && currentUser.username) {
                contextText = `@${currentUser.username}`;
            }
        } catch {
            contextText = "Global UI";
        }
        contextSpan.textContent = contextText;

        const updateMatchCounter = sel => {
            const count = this.countSelectorMatches(sel);
            if (count < 0) {
                matchSpan.textContent = "Invalid CSS selector";
                matchSpan.style.color = "#f23f43";
            } else {
                matchSpan.textContent = `Matches ${count} element${count === 1 ? "" : "s"}`;
                matchSpan.style.color = count > 0 ? "#2dc770" : "#f0b232";
            }
        };

        updateMatchCounter(generatedSelector);

        selectorInput.addEventListener("input", () => {
            this.currentSelectorValue = selectorInput.value.trim();
            updateMatchCounter(this.currentSelectorValue);
            this.applyPreviewSelector(this.currentSelectorValue);
        });

        metaBar.appendChild(matchSpan);
        metaBar.appendChild(contextSpan);

        body.appendChild(selectorInput);
        body.appendChild(metaBar);

        const actions = document.createElement("div");
        actions.className = "vc-eh-actions";

        const previewBtn = document.createElement("button");
        previewBtn.className = `vc-eh-btn vc-eh-btn-preview ${this.isPreviewActive ? "active" : ""}`;
        previewBtn.textContent = this.isPreviewActive ? "Previewing: ON" : "Preview Hide";
        previewBtn.addEventListener("click", () => {
            this.isPreviewActive = !this.isPreviewActive;
            previewBtn.className = `vc-eh-btn vc-eh-btn-preview ${this.isPreviewActive ? "active" : ""}`;
            previewBtn.textContent = this.isPreviewActive ? "Previewing: ON" : "Preview Hide";
            this.updateHighlightBox();
            this.applyPreviewSelector(this.currentSelectorValue);
        });

        const commitBtn = document.createElement("button");
        commitBtn.className = "vc-eh-btn vc-eh-btn-primary";
        commitBtn.textContent = "Hide & Save";
        commitBtn.addEventListener("click", () => {
            const finalSelector = (this.currentSelectorValue || "").trim();
            if (!finalSelector || this.countSelectorMatches(finalSelector) < 0) {
                this.notify("Invalid CSS selector!", "FAILURE");
                return;
            }

            const existingIdx = this.rules.findIndex(r => r.selector === finalSelector);
            if (existingIdx === -1) {
                this.rules.unshift({
                    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    selector: finalSelector,
                    label: describeElement(currentEl),
                    enabled: true,
                    createdAt: new Date().toLocaleString()
                });
            } else {
                this.rules[existingIdx].enabled = true;
            }

            this.saveRules();
            this.isPreviewActive = false;
            this.applyPreviewSelector("");
            this.notify(`Hidden & Saved: ${describeElement(currentEl)}`);
            this.activeTab = "manager";
            this.renderPopup();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "vc-eh-btn vc-eh-btn-secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => this.closePopup());

        actions.appendChild(previewBtn);
        actions.appendChild(commitBtn);
        actions.appendChild(cancelBtn);
        body.appendChild(actions);
    },

    renderManagerTab(body) {
        if (this.rules.length === 0) {
            const empty = document.createElement("div");
            empty.className = "vc-eh-empty";
            empty.textContent = "No hidden elements saved yet. Hold Ctrl + Right-Click on any element to inspect and hide it.";
            body.appendChild(empty);
            return;
        }

        const topRow = document.createElement("div");
        topRow.className = "vc-eh-row";

        const infoLabel = document.createElement("span");
        infoLabel.className = "vc-eh-label";
        infoLabel.textContent = "Hover a rule to locate • Uncheck or Revert to restore";

        const revertAllBtn = document.createElement("button");
        revertAllBtn.className = "vc-eh-small-btn";
        revertAllBtn.textContent = "Revert All";
        revertAllBtn.addEventListener("click", () => {
            this.hoveredRuleId = null;
            this.rules = [];
            this.saveRules();
            this.notify("Reverted all hidden elements");
            this.renderPopup();
        });

        topRow.appendChild(infoLabel);
        topRow.appendChild(revertAllBtn);
        body.appendChild(topRow);

        const list = document.createElement("div");
        list.className = "vc-eh-rule-list";

        for (const rule of this.rules) {
            const item = document.createElement("div");
            item.className = "vc-eh-rule-item";

            item.addEventListener("mouseenter", () => {
                this.hoveredRuleId = rule.id;
                this.applyPersistentRules();
                this.updateHighlightBox();
            });
            item.addEventListener("mouseleave", () => {
                if (this.hoveredRuleId === rule.id) {
                    this.hoveredRuleId = null;
                    this.applyPersistentRules();
                    this.updateHighlightBox();
                }
            });

            const info = document.createElement("div");
            info.className = "vc-eh-rule-info";

            const label = document.createElement("div");
            label.className = "vc-eh-rule-label";
            label.textContent = rule.label || "Hidden Element";
            label.title = rule.label || "";

            const sel = document.createElement("div");
            sel.className = "vc-eh-rule-selector";
            sel.textContent = rule.selector;
            sel.title = rule.selector;

            info.appendChild(label);
            info.appendChild(sel);

            const controls = document.createElement("div");
            controls.className = "vc-eh-rule-controls";

            const toggle = document.createElement("input");
            toggle.type = "checkbox";
            toggle.checked = rule.enabled !== false;
            toggle.title = "Toggle rule on/off";
            toggle.style.cursor = "pointer";
            toggle.addEventListener("change", () => {
                rule.enabled = toggle.checked;
                this.saveRules();
            });

            const removeBtn = document.createElement("button");
            removeBtn.className = "vc-eh-small-btn";
            removeBtn.textContent = "Revert";
            removeBtn.title = "Remove rule and unhide element";
            removeBtn.addEventListener("click", () => {
                if (this.hoveredRuleId === rule.id) {
                    this.hoveredRuleId = null;
                }
                this.rules = this.rules.filter(r => r.id !== rule.id);
                this.saveRules();
                this.notify(`Restored: ${rule.label || "Element"}`);
                this.renderPopup();
            });

            controls.appendChild(toggle);
            controls.appendChild(removeBtn);

            item.appendChild(info);
            item.appendChild(controls);
            list.appendChild(item);
        }

        body.appendChild(list);
    }
});

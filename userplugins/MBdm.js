import definePlugin, { StartAt } from "@utils/types";

let observer = null;
const activeSessions = new Map();
const sessionStack = [];
let isCurrentlyDragging = false;
let pluginRunning = false;
const pendingNativeMounts = new Map();
const nativeStyleSnapshots = new Map();
const draggableHandles = new Map();
const ownedNativeProfiles = new Map();
const pendingProfileRequests = new Map();
let nativeProfileDescriptor = null;

function getReactRuntime() {
    const common = window.Vencord?.Webpack?.Common || {};
    const wp = window.Vencord?.Webpack;
    const React = common.React || wp?.findByProps?.("createElement", "useState");
    const ReactDOM = common.ReactDOM || wp?.findByProps?.("createRoot");
    const createRoot = common.createRoot || ReactDOM?.createRoot;
    return React && typeof createRoot === "function" ? { React, createRoot } : null;
}

function getElementFiber(element) {
    for (let current = element; current; current = current.parentElement) {
        const key = Object.keys(current).find(name => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
        if (key) return current[key];
    }
    return null;
}

function captureNativeProviders(element) {
    const providers = [];
    for (let fiber = getElementFiber(element); fiber; fiber = fiber.return) {
        if (fiber.tag === 10 && fiber.memoizedProps && fiber.type) providers.push({ type: fiber.type, value: fiber.memoizedProps.value });
    }
    return providers;
}

function captureNativeProfileDescriptor(outer, userId) {
    let fiber = getElementFiber(outer.querySelector('[role="dialog"]') || outer);
    let selected = null;
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props?.renderPopout && selected) break;
        if (!props || typeof props !== "object" || props.renderPopout || props.children != null) continue;
        const id = props.user?.id || props.userId;
        const type = fiber.elementType || fiber.type;
        if (String(id) === String(userId) && type && typeof type !== "string") {
            selected = fiber;
        }
    }
    if (!selected) return null;
    const providers = [];
    for (fiber = selected.return; fiber; fiber = fiber.return) {
        if (fiber.tag === 10 && fiber.memoizedProps && fiber.type) providers.push({ type: fiber.type, value: fiber.memoizedProps.value });
    }
    return { type: selected.elementType || selected.type, props: { ...selected.memoizedProps }, providers, controlledPopout: false };
}

function resolveNativeProfileDescriptor() {
    if (nativeProfileDescriptor) return nativeProfileDescriptor;
    const wp = window.Vencord?.Webpack;
    try {
            const Summary = wp?.find?.(type => typeof type === "function" && typeof type.prototype?.renderUsers === "function" && typeof type.prototype?.renderMoreUsers === "function" && typeof type.prototype?.renderIcon === "function");
            const user = getStore("UserStore", "getCurrentUser")?.getCurrentUser?.();
            if (Summary && user) {
                const summary = new Summary({ users: [user], showUserPopout: true, useFallbackUserForPopout: true, size: 24 });
                summary.state = { ...summary.state, popoutUserId: user.id };
                const element = summary.render();
                if (element?.type && typeof element.type !== "string") nativeProfileDescriptor = { type: element.type, props: {}, providers: [], controlledPopout: true };
            }
    } catch (err) {}
    if (!nativeProfileDescriptor) {
        try {
            const type = wp?.findComponentByCode?.(".getCurrentUser()", ".getUser(", "userId:", "children:");
            if (type) nativeProfileDescriptor = { type, props: {}, providers: [], controlledPopout: true };
        } catch (err) {}
    }
    return nativeProfileDescriptor;
}

function isOwnedNativeProfile(outer, record) {
    for (let fiber = getElementFiber(outer.querySelector('[role="dialog"]') || outer); fiber; fiber = fiber.return) {
        if (fiber.tag === 3 && fiber.stateNode?.containerInfo === record.host) return true;
    }
    return false;
}

function openNativeProfile(userId, options = {}, descriptor = resolveNativeProfileDescriptor()) {
    if (!pluginRunning || !userId || !descriptor) return false;
    userId = String(userId);
    if (ownedNativeProfiles.has(userId)) {
        bringToFront(userId);
        activeSessions.get(userId)?.session.ui?.querySelector("#qw-input")?.focus({ preventScroll: true });
        return true;
    }
    const runtime = getReactRuntime();
    const UserStore = getStore("UserStore", "getCurrentUser");
    const user = UserStore?.getUser?.(userId) || (String(descriptor.props.user?.id) === userId ? descriptor.props.user : null);
    if (!runtime || !user) return false;
    const host = document.createElement("div");
    host.className = "qw-native-react-root";
    host.dataset.qwNativeUser = userId;
    host.style.cssText = "position: fixed; width: 1px; height: 1px; pointer-events: none;";
    host.style.left = Math.round(window.innerWidth / 2) + "px";
    host.style.top = "80px";
    document.body.appendChild(host);
    const record = { userId, host, root: runtime.createRoot(host), descriptor, outer: null };
    ownedNativeProfiles.set(userId, record);
    const anchorRef = { current: null };
    const noop = () => {};
    const props = {
        ...descriptor.props,
        userId, user,
        currentUser: UserStore.getCurrentUser?.(),
        channelId: options.channelId || getStore("ChannelStore", "getDMFromUserId")?.getDMFromUserId?.(userId),
        guildId: options.guildId ?? descriptor.props.guildId,
        shouldShow: true,
        clickTrap: false,
        ignoreModalClicks: true,
        scrollBehavior: "none",
        fixed: true,
        position: "right",
        animation: "1",
        onRequestClose: noop,
        onClosePopout: noop,
        closePopout: noop,
        onClose: noop
    };
    if (descriptor.controlledPopout) {
        props.targetElementRef = anchorRef;
        props.children = nativeProps => runtime.React.createElement("span", { ...nativeProps, ref: anchorRef, "aria-hidden": true, style: { width: 1, height: 1, display: "block", opacity: 0 } });
    }
    let element = runtime.React.createElement(descriptor.type, props);
    let providers = descriptor.providers.length ? descriptor.providers : captureNativeProviders(options.anchor);
    if (!providers.length) {
        for (const candidate of document.querySelectorAll('[class*="layerContainer_"], main [role="textbox"], [data-list-item-id], [class*="baseLayer_"]')) {
            providers = captureNativeProviders(candidate);
            if (providers.length) break;
        }
    }
    for (const provider of providers) element = runtime.React.createElement(provider.type, { value: provider.value }, element);
    record.root.render(element);
    let preloadAttempts = 0;
    function preloadWhenCommitted() {
        if (!pluginRunning || ownedNativeProfiles.get(userId) !== record) return;
        if (!anchorRef.current?.isConnected) {
            if (++preloadAttempts < 20) record.preloadTimer = setTimeout(preloadWhenCommitted, 50);
            return;
        }
        for (let fiber = getElementFiber(anchorRef.current); fiber; fiber = fiber.return) {
            if (typeof fiber.memoizedProps?.preload === "function") {
                Promise.resolve(fiber.memoizedProps.preload()).catch(err => console.error("[MBDM] Native profile preload failed:", err));
                break;
            }
        }
    }
    if (descriptor.controlledPopout) record.preloadTimer = setTimeout(preloadWhenCommitted, 0);
    return true;
}

function destroyOwnedNativeProfile(userId) {
    const record = ownedNativeProfiles.get(String(userId));
    if (!record) return;
    ownedNativeProfiles.delete(String(userId));
    clearTimeout(record.preloadTimer);
    if (record.outer) {
        for (const binding of [...draggableHandles.values()]) {
            if (binding.outer === record.outer) binding.cleanup();
        }
        restoreNativeStyles(record.outer);
    }
    record.root.unmount();
    record.host.remove();
}

function setNativeStyle(owner, element, property, value) {
    let snapshot = nativeStyleSnapshots.get(element);
    if (!snapshot) {
        snapshot = { owner, properties: new Map() };
        nativeStyleSnapshots.set(element, snapshot);
    }
    if (!snapshot.properties.has(property)) {
        snapshot.properties.set(property, [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
    }
    element.style.setProperty(property, value, "important");
}

function restoreNativeStyles(owner) {
    for (const [element, snapshot] of nativeStyleSnapshots) {
        if (snapshot.owner !== owner) continue;
        for (const [property, [value, priority]] of snapshot.properties) {
            if (value) element.style.setProperty(property, value, priority);
            else element.style.removeProperty(property);
        }
        nativeStyleSnapshots.delete(element);
    }
}

const _definePlugin = typeof definePlugin === "function" ? definePlugin : (window.Vencord?.Plugins?.definePlugin || (p => p));
const _definePluginSettings = typeof definePluginSettings === "function" ? definePluginSettings : (window.Vencord?.Api?.Settings?.definePluginSettings || (s => ({ def: s, store: {} })));
const OptType = (typeof OptionType !== "undefined" && OptionType) || { STRING: 0, NUMBER: 1, BIGINT: 2, BOOLEAN: 3, SELECT: 4, SLIDER: 5 };

const STORAGE_KEY = "MBDM_persistent_config";

function getStoredConfig() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        }
    } catch (e) {}
    return {};
}

function saveStoredConfig(updates) {
    try {
        const current = getStoredConfig();
        const merged = Object.assign({}, current, updates);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (e) {}
}

const settings = _definePluginSettings({
    myColor: { type: OptType.STRING, description: "My Bubble Color (Hex)", default: "", onChange: value => syncSettingPreference("myColor", value) },
    theirColor: { type: OptType.STRING, description: "Their Bubble Color (Hex)", default: "", onChange: value => syncSettingPreference("theirColor", value) },
    profileWidth: { type: OptType.NUMBER, description: "Profile Width (px)", default: 600, onChange: value => syncSettingPreference("profileWidth", value) },
    showHeaders: { type: OptType.BOOLEAN, description: "Show avatar and username", default: true, onChange: value => syncSettingPreference("showHeaders", value) },
    fontSize: { type: OptType.NUMBER, description: "Message font size (px)", default: 13, onChange: value => syncSettingPreference("fontSize", value) },
    chatHeight: { type: OptType.NUMBER, description: "Chat scroller height (px)", default: 210, onChange: value => syncSettingPreference("chatHeight", value) },
    autoFocus: { type: OptType.BOOLEAN, description: "Auto-focus composer input", default: true, onChange: value => syncSettingPreference("autoFocus", value) }
});

function syncSettingPreference(key, value) {
    const next = value === undefined ? settings?.store?.[key] : value;
    if (next !== undefined) saveStoredConfig({ [key]: next });
    updateCustomStyles();
}

function getEffectiveConfig() {
    // The floating settings panel already saved these preferences locally.
    // Plugin-store defaults must not overwrite them when the plugin reloads.
    const st = Object.assign({}, window.Vencord?.Settings?.plugins?.MBDM || {}, settings?.store || {}, getStoredConfig());
    const boundedNumber = (value, fallback, min, max) => {
        const numeric = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
        return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
    };
    const color = value => typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : "";
    return {
        myColor: color(st.myColor),
        theirColor: color(st.theirColor),
        profileWidth: boundedNumber(st.profileWidth, 600, 280, 750),
        chatHeight: boundedNumber(st.chatHeight, 210, 150, 450),
        fontSize: boundedNumber(st.fontSize, 13, 11, 18),
        showHeaders: st.showHeaders !== false,
        autoFocus: st.autoFocus !== false
    };
}

function getContrastColor(hex) {
    if (!hex || typeof hex !== "string" || !hex.startsWith("#")) return "";
    let clean = hex.replace("#", "");
    if (clean.length === 3) clean = clean.split("").map(c => c + c).join("");
    if (clean.length !== 6) return "";
    const r = parseInt(clean.substring(0, 2), 16), g = parseInt(clean.substring(2, 4), 16), b = parseInt(clean.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return "";
    return ((r * 299 + g * 587 + b * 114) / 1000) >= 145 ? "#111214" : "#ffffff";
}

function getPopoutOuter(element) {
    if (!element) return null;
    const popout = element.closest('[class*="userProfileOuter"], [class*="userPopoutOuter"], [role="dialog"]');
    const popoutDiv = (popout || element).closest('div[id^="popout_"]');
    if (popoutDiv) return popoutDiv;
    if (popout) return popout;
    return element.closest('[id^="popout_"]') || element;
}

function applyPopoutDimensions(outer) {
    if (!outer) return;
    const width = Math.min(getEffectiveConfig().profileWidth, Math.max(280, window.innerWidth - 20));
    const w = width + "px";
    for (const property of ["width", "min-width", "max-width"]) setNativeStyle(outer, outer, property, w);
    // Current native profiles size their visible frame with this variable;
    // widening only the portal leaves that frame at Discord's default 300px.
    setNativeStyle(outer, outer, "--custom-user-profile-popout-width", w);
    for (const inner of outer.querySelectorAll('.user-profile-popout, [role="dialog"], [class*="userProfileOuter"], [class*="userProfileModalOuter"], [class*="userPopoutOuter"], [class*="userProfileInner_"]')) {
        setNativeStyle(outer, inner, "--custom-user-profile-popout-width", w);
        setNativeStyle(outer, inner, "box-sizing", "border-box");
        for (const property of ["width", "min-width", "max-width"]) setNativeStyle(outer, inner, property, "100%");
    }
}

function setPopoutScreenPosition(outer, left, top) {
    setNativeStyle(outer, outer, "left", left + "px");
    setNativeStyle(outer, outer, "top", top + "px");
    // A native portal can have a transformed positioning ancestor. Compensate
    // in its own coordinate space instead of moving the portal out of React.
    const rect = outer.getBoundingClientRect();
    const scaleX = outer.offsetWidth ? rect.width / outer.offsetWidth : 1;
    const scaleY = outer.offsetHeight ? rect.height / outer.offsetHeight : 1;
    if (Math.abs(rect.left - left) > 0.5) setNativeStyle(outer, outer, "left", (left + (left - rect.left) / (scaleX || 1)) + "px");
    if (Math.abs(rect.top - top) > 0.5) setNativeStyle(outer, outer, "top", (top + (top - rect.top) / (scaleY || 1)) + "px");
}

function positionOwnedOverlay(element, left, top) {
    element.style.setProperty("left", left + "px", "important");
    element.style.setProperty("top", top + "px", "important");
    const rect = element.getBoundingClientRect();
    const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    element.style.setProperty("left", (left + (left - rect.left) / (scaleX || 1)) + "px", "important");
    element.style.setProperty("top", (top + (top - rect.top) / (scaleY || 1)) + "px", "important");
}

function getNativeOverlayHost(outer) {
    return outer?.querySelector('[role="dialog"]') || outer || document.body;
}

function positionProfilePopout(outer, index = 0) {
    if (!outer) return;
    applyPopoutDimensions(outer);
    const width = Math.min(getEffectiveConfig().profileWidth, Math.max(280, window.innerWidth - 20));
    const saved = getStoredConfig().lastPosition;
    const offset = index * 24;
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, (saved?.left ?? (window.innerWidth - width) / 2) + offset));
    const top = Math.max(10, Math.min(window.innerHeight - 80, (saved?.top ?? (window.innerHeight - 500) / 2) + offset));
    for (const [property, value] of Object.entries({ position: "fixed", transform: "none", right: "auto", bottom: "auto", margin: "0", overflow: "visible", "pointer-events": "auto" })) {
        setNativeStyle(outer, outer, property, value);
    }
    setPopoutScreenPosition(outer, left, top);
}

function enforcePopoutWidth() {
    const cfg = getEffectiveConfig();
    const w = `${cfg.profileWidth}px`;
    document.documentElement.style.setProperty("--qw-profile-width", w);
    const outers = new Set([...ownedNativeProfiles.values(), ...activeSessions.values()].map(data => data.outer).filter(outer => outer?.isConnected));
    for (const outer of outers) {
        applyPopoutDimensions(outer);
    }
}

function bringToFront(userId) {
    // Discord owns portal stacking, including menus and modals opened by its
    // original profile buttons. Never raise the profile above those portals.
    const idx = sessionStack.indexOf(userId);
    if (idx !== -1) {
        sessionStack.splice(idx, 1);
        sessionStack.push(userId);
    }
    for (let i = 0; i < sessionStack.length; i++) {
        const record = ownedNativeProfiles.get(String(sessionStack[i]));
        if (record?.outer) setNativeStyle(record.outer, record.outer, "z-index", String(i - sessionStack.length));
    }
}

// Close the native popout through its own callback; never rewrite React props,
// hooks, methods, or the DOM owned by its portal.
function getNativePopoutClose(node) {
    if (!node) return null;
    const candidates = [node, node.querySelector?.('[role="dialog"]'), node.parentElement].filter(Boolean);
    for (const candidate of candidates) {
        const key = Object.keys(candidate).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
        let fiber = key ? candidate[key] : null;
        for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
            const props = fiber.memoizedProps || fiber.stateNode?.props;
            for (const name of ["onRequestClose", "closePopout", "onClose"]) {
                if (typeof props?.[name] === "function") return () => props[name]();
            }
        }
    }
    return null;
}

function cleanupNativeSession(userId, requestClose = false) {
    userId = String(userId);
    if (requestClose) pendingProfileRequests.delete(userId);
    for (const [outer, token] of pendingNativeMounts) {
        if (token.userId === userId) pendingNativeMounts.delete(outer);
    }
    const data = activeSessions.get(userId);
    if (!data) {
        if (requestClose) destroyOwnedNativeProfile(userId);
        return;
    }
    activeSessions.delete(userId);
    const idx = sessionStack.indexOf(userId);
    if (idx !== -1) sessionStack.splice(idx, 1);
    const owned = ownedNativeProfiles.get(userId);
    const nativeClose = requestClose && !owned && data.outer.isConnected ? (getNativePopoutClose(data.outer) || data.nativeClose) : null;
    if (activeDragCleanup) activeDragCleanup();
    closeFloatingSettings();
    if (activeLightboxCleanup && activeLightboxOwner === data.outer) activeLightboxCleanup();
    try { data.session.destroy(); } catch (e) {}
    if (!data.hadHostClass) data.chatHost.classList.remove("qw-chat-host");
    for (const [handle, binding] of draggableHandles) {
        if (binding.outer === data.outer) binding.cleanup();
    }
    data.outer.removeEventListener("pointerdown", data.onPointerDown, true);
    data.outer.querySelectorAll(".qw-floating-gear-btn, .qw-top-close-btn").forEach(element => element.remove());
    restoreNativeStyles(data.outer);
    for (const [name, value] of data.attributes) {
        if (value === null) data.outer.removeAttribute(name);
        else data.outer.setAttribute(name, value);
    }
    if (requestClose && owned) {
        destroyOwnedNativeProfile(userId);
    } else if (nativeClose) {
        try { nativeClose(); } catch (err) { console.error("[MBDM] Native profile close failed:", err); }
    } else if (requestClose && !owned && data.outer.isConnected) {
        data.outer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
}

function closeSession(userId) {
    cleanupNativeSession(userId, true);
}

function updateCustomStyles() {
    const cfg = getEffectiveConfig();
    enforcePopoutWidth();

    const myTextContrast = getContrastColor(cfg.myColor);
    const theirTextContrast = getContrastColor(cfg.theirColor);

    let el = document.getElementById("quick-whisper-custom-styles");
    if (!el) {
        el = document.createElement("style");
        el.id = "quick-whisper-custom-styles";
        document.head.appendChild(el);
    }

    el.textContent = `
        .qw-scroller { height: ${cfg.chatHeight}px !important; }
        .qw-msg-bubble { font-size: ${cfg.fontSize}px !important; }
        .qw-msg-header { display: ${cfg.showHeaders ? "flex" : "none"} !important; }
        ${cfg.myColor ? `
            .qw-msg-me .qw-msg-bubble { background: ${cfg.myColor} !important; }
            ${myTextContrast ? `
                .qw-msg-me .qw-msg-bubble, .qw-msg-me .qw-msg-text, .qw-msg-me .qw-reply-author, .qw-msg-me .qw-reply-text, .qw-msg-me .qw-msg-file { color: ${myTextContrast} !important; }
                .qw-msg-me .qw-msg-time { color: ${myTextContrast === "#111214" ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.7)"} !important; }
                .qw-msg-me .qw-reply-banner { border-bottom-color: ${myTextContrast === "#111214" ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.2)"} !important; }
                ${myTextContrast === "#111214" ? `
                    .qw-msg-me .qw-link {
                        color: #0369a1 !important;
                        background: rgba(3, 105, 161, 0.12) !important;
                        border-color: rgba(3, 105, 161, 0.3) !important;
                        text-decoration-color: #0369a1 !important;
                    }
                    .qw-msg-me .qw-link:hover {
                        color: #0c4a6e !important;
                        background: rgba(3, 105, 161, 0.22) !important;
                    }
                ` : `
                    .qw-msg-me .qw-link {
                        color: #a5f3fc !important;
                        background: rgba(255, 255, 255, 0.18) !important;
                        border-color: rgba(255, 255, 255, 0.3) !important;
                    }
                    .qw-msg-me .qw-link:hover {
                        color: #ffffff !important;
                        background: rgba(255, 255, 255, 0.32) !important;
                    }
                `}
            ` : ""}
        ` : `
            .qw-msg-me .qw-msg-bubble {
                background: linear-gradient(135deg, var(--profile-gradient-primary-color, var(--brand-500, #5865f2)), var(--profile-gradient-secondary-color, var(--brand-600, #4752c4))) !important;
            }
        `}
        ${cfg.theirColor ? `
            .qw-msg-them .qw-msg-bubble { background: ${cfg.theirColor} !important; }
            ${theirTextContrast ? `
                .qw-msg-them .qw-msg-bubble, .qw-msg-them .qw-msg-text, .qw-msg-them .qw-reply-author, .qw-msg-them .qw-reply-text, .qw-msg-them .qw-msg-file { color: ${theirTextContrast} !important; }
                .qw-msg-them .qw-msg-time { color: ${theirTextContrast === "#111214" ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.7)"} !important; }
                .qw-msg-them .qw-reply-banner { border-bottom-color: ${theirTextContrast === "#111214" ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.2)"} !important; }
                ${theirTextContrast === "#111214" ? `
                    .qw-msg-them .qw-link {
                        color: #0369a1 !important;
                        background: rgba(3, 105, 161, 0.12) !important;
                        border-color: rgba(3, 105, 161, 0.3) !important;
                        text-decoration-color: #0369a1 !important;
                    }
                ` : `
                    .qw-msg-them .qw-link {
                        color: #38bdf8 !important;
                        background: rgba(56, 189, 248, 0.15) !important;
                        border-color: rgba(56, 189, 248, 0.3) !important;
                    }
                `}
            ` : ""}
        ` : ""}
    `;
}

const PLUGIN_STYLES = `
:root { --qw-profile-width: 600px; }
[data-qw-managed="true"] {
    box-sizing: border-box !important;
    max-height: 94vh !important;
    --reference-position-layer-max-height: 94vh !important;
}
[data-qw-managed="true"] [role="dialog"],
[data-qw-managed="true"] .user-profile-popout,
[data-qw-managed="true"] [class*="userProfileOuter"],
[data-qw-managed="true"] [class*="userProfileModalOuter"],
[data-qw-managed="true"] [class*="userPopoutOuter"],
[data-qw-managed="true"] [class*="userProfileInner"] {
    box-sizing: border-box !important;
}
.qw-chat-host {
    display: flex !important;
    flex-direction: column !important;
    min-height: 0 !important;
}
[data-qw-managed="true"] [class*="body_"]:not(:has(.qw-root)) {
    max-height: 110px !important;
    overflow-y: auto !important;
    flex-shrink: 0 !important;
}

.qw-native-hidden { display: none !important; }

.qw-root, #quick-whisper-root, [id^="quick-whisper-root"] {
    display: flex !important;
    flex-direction: column !important;
    padding: 6px 12px 12px !important;
    background: rgba(0, 0, 0, 0.08) !important;
    backdrop-filter: blur(20px) !important;
    -webkit-backdrop-filter: blur(20px) !important;
    box-shadow: none !important;
    border-top: 1px solid var(--profile-gradient-primary-color, rgba(255, 255, 255, 0.08)) !important;
    border-bottom-left-radius: 8px !important;
    border-bottom-right-radius: 8px !important;
    box-sizing: border-box !important;
    width: 100% !important;
    min-height: 285px !important;
    z-index: 10 !important;
    position: relative !important;
}
.qw-top-close-btn {
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    min-height: 32px !important;
    border-radius: 50% !important;
    background: rgba(0, 0, 0, 0.55) !important;
    backdrop-filter: blur(8px) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    color: var(--interactive-normal, #b5bac1) !important;
    cursor: pointer !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 0 !important;
    margin: 0 !important;
    transition: transform 0.18s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35) !important;
    flex-shrink: 0 !important;
    z-index: 1000 !important;
}
.qw-top-close-btn:hover {
    color: #ffffff !important;
    background: rgba(237, 66, 69, 0.85) !important;
    border-color: rgba(237, 66, 69, 0.5) !important;
    transform: scale(1.08) !important;
}
.qw-top-close-btn svg {
    width: 15px !important;
    height: 15px !important;
    fill: currentColor !important;
    display: block !important;
}
.qw-header {
    display: none !important;
}
.qw-header-spacer {
    flex: 1;
    height: 100%;
    cursor: grab;
}
.qw-header-spacer:active {
    cursor: grabbing;
}

.qw-scroller {
    height: 210px;
    min-height: 0;
    flex: 0 0 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
    overflow-x: hidden;
    padding-right: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-auto-thumb, rgba(255, 255, 255, 0.2)) transparent;
}
.qw-scroller::-webkit-scrollbar { width: 5px; }
.qw-scroller::-webkit-scrollbar-thumb { background: var(--scrollbar-auto-thumb, rgba(255, 255, 255, 0.2)); border-radius: 4px; }
.qw-loading-banner { text-align: center; font-size: 11px; color: var(--text-muted, #949ba4); padding: 3px 0; }
.qw-messages-container { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
.qw-msg-row { display: flex; flex-direction: column; width: 100%; }
.qw-msg-row.qw-msg-has-header { margin-top: 6px; }
.qw-msg-header { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; padding: 0 2px; }
.qw-msg-me .qw-msg-header { flex-direction: row-reverse; }
.qw-author-avatar { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; }
.qw-author-name { font-size: 11px; font-weight: 700; color: var(--header-primary, #f2f3f5); }
.qw-msg-wrapper { display: flex; width: 100%; }
.qw-msg-me .qw-msg-wrapper { justify-content: flex-end; }
.qw-msg-them .qw-msg-wrapper { justify-content: flex-start; }
#quick-whisper-root,
.qw-scroller,
.qw-messages-container,
.qw-msg-row,
.qw-msg-wrapper,
.qw-msg-bubble,
.qw-msg-text,
.qw-reply-banner,
.qw-reply-author,
.qw-reply-text,
.qw-author-name {
    user-select: text !important;
    -webkit-user-select: text !important;
}
.qw-msg-bubble,
.qw-msg-text {
    cursor: text !important;
}
.qw-header,
.qw-send-btn,
.qw-author-avatar,
.qw-msg-img,
.qw-msg-time {
    user-select: none !important;
    -webkit-user-select: none !important;
}
[data-qw-managed="true"] [class*="avatar_"], [data-qw-managed="true"] [class*="banner_"], .qw-author-avatar, .qw-header-spacer {
    -webkit-user-drag: none !important;
    user-drag: none !important;
}
[data-qw-managed="true"] [class*="avatar_"] img, [data-qw-managed="true"] [class*="banner_"] img {
    -webkit-user-drag: none !important;
    user-drag: none !important;
}
.qw-msg-bubble {
    max-width: 82%;
    padding: 7px 11px;
    font-size: 13px;
    line-height: 1.42;
    word-break: break-word;
    position: relative;
    unicode-bidi: plaintext;
    text-align: start;
    box-shadow: none !important;
}
.qw-msg-them .qw-msg-bubble {
    background: color-mix(in srgb, var(--background-secondary-alt, #2b2d31) 70%, transparent) !important;
    backdrop-filter: blur(8px) !important;
    border: 1px solid rgba(255, 255, 255, 0.07) !important;
    color: var(--text-normal, #dbdee1) !important;
    border-radius: 14px 14px 14px 3px;
    box-shadow: none !important;
}
.qw-msg-me .qw-msg-bubble {
    background: linear-gradient(135deg, var(--profile-gradient-primary-color, var(--brand-500, #5865f2)), var(--profile-gradient-secondary-color, var(--brand-600, #4752c4))) !important;
    color: #ffffff !important;
    border-radius: 14px 14px 3px 14px;
    box-shadow: none !important;
}
.qw-msg-text { unicode-bidi: plaintext; text-align: start; }
.qw-msg-time { font-size: 10px; opacity: 0.7; margin-top: 3px; text-align: end; }
.qw-reply-banner { display: flex; gap: 4px; font-size: 11px; padding-bottom: 4px; margin-bottom: 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.12); opacity: 0.85; }
.qw-reply-author { font-weight: 600; }
.qw-reply-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.qw-attachments { margin-top: 4px; display: flex; flex-direction: column; gap: 4px; }
.qw-msg-img { max-width: 100%; max-height: 130px; border-radius: 6px; display: block; object-fit: cover; cursor: pointer; }
.qw-msg-file { font-size: 12px; color: inherit; text-decoration: underline; }
.qw-link {
    color: #38bdf8 !important;
    font-weight: 600 !important;
    text-decoration: underline !important;
    text-underline-offset: 3px !important;
    text-decoration-thickness: 1.5px !important;
    word-break: break-all !important;
    cursor: pointer !important;
    transition: all 0.15s ease !important;
    padding: 1px 4px !important;
    border-radius: 4px !important;
    background: rgba(56, 189, 248, 0.14) !important;
    border: 1px solid rgba(56, 189, 248, 0.25) !important;
    display: inline-block !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    line-height: 1.35 !important;
}
.qw-link:hover {
    color: #ffffff !important;
    background: rgba(56, 189, 248, 0.35) !important;
    border-color: rgba(56, 189, 248, 0.6) !important;
    text-decoration-color: #ffffff !important;
}
.qw-msg-me .qw-link {
    color: #a5f3fc !important;
    background: rgba(255, 255, 255, 0.18) !important;
    border-color: rgba(255, 255, 255, 0.3) !important;
    text-decoration-color: rgba(165, 243, 252, 0.8) !important;
}
.qw-msg-me .qw-link:hover {
    color: #ffffff !important;
    background: rgba(255, 255, 255, 0.32) !important;
    border-color: rgba(255, 255, 255, 0.5) !important;
    text-decoration-color: #ffffff !important;
}
.qw-msg-them .qw-link {
    color: #38bdf8 !important;
    background: rgba(56, 189, 248, 0.15) !important;
    border-color: rgba(56, 189, 248, 0.3) !important;
    text-decoration-color: rgba(56, 189, 248, 0.7) !important;
}
.qw-msg-them .qw-link:hover {
    color: #ffffff !important;
    background: rgba(56, 189, 248, 0.35) !important;
    border-color: rgba(56, 189, 248, 0.6) !important;
    text-decoration-color: #ffffff !important;
}
.qw-composer {
    display: flex !important;
    flex-direction: column !important;
    gap: 6px !important;
    margin-top: 8px !important;
    background: rgba(0, 0, 0, 0.22) !important;
    backdrop-filter: blur(16px) saturate(180%) !important;
    -webkit-backdrop-filter: blur(16px) saturate(180%) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 12px !important;
    padding: 6px 10px !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
    transition: all 0.2s ease !important;
    box-sizing: border-box !important;
    width: 100% !important;
}
.qw-composer:focus-within {
    background: rgba(0, 0, 0, 0.32) !important;
    border-color: var(--profile-gradient-primary-color, var(--brand-500, #5865f2)) !important;
    box-shadow: 0 0 0 1px var(--profile-gradient-primary-color, var(--brand-500, #5865f2)), 0 4px 14px rgba(0, 0, 0, 0.25) !important;
}
.qw-input-row {
    display: flex !important;
    align-items: flex-end !important;
    gap: 6px !important;
    width: 100% !important;
}
.qw-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-normal, #dbdee1);
    font-family: inherit;
    font-size: 13px;
    resize: none;
    max-height: 90px;
    line-height: 1.4;
    padding: 4px 0;
    unicode-bidi: plaintext;
    text-align: start;
    box-sizing: border-box;
}
.qw-input::placeholder { color: var(--text-muted, #949ba4); }
.qw-composer-action-btn {
    background: transparent !important;
    border: none !important;
    color: var(--interactive-normal, #b5bac1) !important;
    cursor: pointer !important;
    padding: 4px !important;
    border-radius: 50% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    flex-shrink: 0 !important;
    transition: color 0.15s ease, background 0.15s ease !important;
    margin-bottom: 2px !important;
}
.qw-composer-action-btn:hover {
    color: var(--interactive-hover, #ffffff) !important;
    background: rgba(255, 255, 255, 0.1) !important;
}
.qw-mic-btn:hover {
    color: #f23f43 !important;
}
.qw-send-btn {
    background: transparent !important;
    border: none !important;
    cursor: pointer !important;
    color: var(--profile-gradient-primary-color, var(--brand-500, #5865f2)) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 4px !important;
    border-radius: 50% !important;
    flex-shrink: 0 !important;
    transition: transform 0.15s ease, color 0.15s ease !important;
    margin-bottom: 2px !important;
}
.qw-send-btn:hover {
    color: #ffffff !important;
    transform: scale(1.1) !important;
}
.qw-attachment-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    width: 100%;
    box-sizing: border-box;
}
.qw-att-thumb-wrapper {
    position: relative;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
}
.qw-att-thumb {
    width: 44px;
    height: 44px;
    object-fit: cover;
    border-radius: 6px;
    display: block;
}
.qw-att-remove-btn {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #da373c;
    color: #fff;
    border: none;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.qw-att-info {
    font-size: 12px;
    color: var(--text-normal, #dbdee1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}
.qw-voice-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 4px 8px;
    background: rgba(242, 63, 67, 0.15);
    border: 1px solid rgba(242, 63, 67, 0.35);
    border-radius: 8px;
    box-sizing: border-box;
}
.qw-voice-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
}
.qw-voice-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #f23f43;
    display: inline-block;
    animation: qwBlink 1s infinite alternate;
}
.qw-voice-timer {
    font-size: 13px;
    font-weight: 600;
    color: #ffffff;
    font-variant-numeric: tabular-nums;
}
.qw-voice-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}
.qw-voice-cancel-btn {
    background: rgba(0, 0, 0, 0.35);
    border: none;
    color: var(--text-muted, #949ba4);
    width: 26px;
    height: 26px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
}
.qw-voice-cancel-btn:hover {
    color: #f23f43;
    background: rgba(242, 63, 67, 0.25);
}
.qw-voice-send-btn {
    background: #23a55a;
    border: none;
    color: #ffffff;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
}
.qw-voice-send-btn:hover {
    background: #208e4e;
}
@keyframes qwBlink {
    from { opacity: 0.3; }
    to { opacity: 1; }
}
.qw-voice-msg-player {
    display: flex;
    align-items: center;
    margin-top: 4px;
}
.qw-voice-msg-player audio {
    height: 32px;
    max-width: 230px;
    border-radius: 16px;
    filter: invert(0.9) hue-rotate(180deg);
}
.qw-floating-gear-btn {
    position: absolute !important;
    top: 12px !important;
    left: 12px !important;
    right: auto !important;
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    min-height: 32px !important;
    border-radius: 50% !important;
    background: rgba(0, 0, 0, 0.55) !important;
    backdrop-filter: blur(8px) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    color: var(--interactive-normal, #b5bac1) !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 1000 !important;
    transition: transform 0.25s ease, background 0.2s ease, color 0.2s ease !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35) !important;
    padding: 0 !important;
}
.qw-floating-gear-btn:hover {
    color: #ffffff !important;
    background: rgba(0, 0, 0, 0.8) !important;
    transform: rotate(45deg) scale(1.08) !important;
}
.qw-floating-gear-btn svg {
    width: 16px !important;
    height: 16px !important;
    fill: currentColor !important;
    display: block !important;
}
#qw-floating-settings {
    position: fixed !important;
    width: 310px !important;
    background: rgba(22, 23, 27, 0.94) !important;
    backdrop-filter: blur(20px) !important;
    -webkit-backdrop-filter: blur(20px) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    border-radius: 14px !important;
    padding: 14px 16px !important;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65) !important;
    z-index: 100005 !important;
    box-sizing: border-box !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 12px !important;
    color: var(--text-normal, #dbdee1) !important;
    font-family: var(--font-primary, sans-serif) !important;
}
.qw-settings-header {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding-bottom: 8px !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
}
.qw-settings-title {
    font-size: 14px !important;
    font-weight: 700 !important;
    color: #ffffff !important;
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
}
.qw-settings-close {
    background: transparent !important;
    border: none !important;
    color: var(--interactive-normal, #b5bac1) !important;
    cursor: pointer !important;
    font-size: 14px !important;
    padding: 4px 6px !important;
    border-radius: 4px !important;
}
.qw-settings-close:hover {
    color: #ffffff !important;
    background: rgba(255, 255, 255, 0.1) !important;
}
.qw-set-item {
    display: flex !important;
    flex-direction: column !important;
    gap: 6px !important;
}
.qw-set-row-inline {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
}
.qw-set-label {
    font-size: 12px !important;
    font-weight: 600 !important;
    color: var(--header-secondary, #b5bac1) !important;
}
.qw-set-val {
    font-size: 12px !important;
    font-weight: 500 !important;
    color: var(--text-muted, #949ba4) !important;
}
.qw-color-ctrl {
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
}
.qw-color-native {
    -webkit-appearance: none !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    border-radius: 6px !important;
    width: 28px !important;
    height: 24px !important;
    padding: 0 !important;
    cursor: pointer !important;
    background: transparent !important;
}
.qw-color-native::-webkit-color-swatch-wrapper { padding: 0 !important; }
.qw-color-native::-webkit-color-swatch { border: none !important; border-radius: 5px !important; }
.qw-set-reset {
    background: rgba(255, 255, 255, 0.08) !important;
    border: none !important;
    color: var(--text-normal, #dbdee1) !important;
    font-size: 11px !important;
    padding: 3px 8px !important;
    border-radius: 4px !important;
    cursor: pointer !important;
}
.qw-set-reset:hover {
    background: rgba(255, 255, 255, 0.15) !important;
    color: #ffffff !important;
}
.qw-slider {
    width: 100% !important;
    accent-color: var(--brand-500, #5865f2) !important;
    cursor: pointer !important;
}
.qw-switch {
    position: relative !important;
    display: inline-block !important;
    width: 36px !important;
    height: 20px !important;
}
.qw-switch input { opacity: 0 !important; width: 0 !important; height: 0 !important; }
.qw-switch-slider {
    position: absolute !important;
    cursor: pointer !important;
    inset: 0 !important;
    background-color: #4e5058 !important;
    transition: .2s !important;
    border-radius: 20px !important;
}
.qw-switch-slider:before {
    position: absolute !important;
    content: "" !important;
    height: 14px !important;
    width: 14px !important;
    left: 3px !important;
    bottom: 3px !important;
    background-color: white !important;
    transition: .2s !important;
    border-radius: 50% !important;
}
.qw-switch input:checked + .qw-switch-slider {
    background-color: #23a55a !important;
}
.qw-switch input:checked + .qw-switch-slider:before {
    transform: translateX(16px) !important;
}

#qw-lightbox { position: fixed !important; inset: 0 !important; z-index: 2000000 !important; display: flex !important; align-items: center !important; justify-content: center !important; }
.qw-lightbox-backdrop { position: absolute !important; inset: 0 !important; background: rgba(0, 0, 0, 0.85) !important; backdrop-filter: blur(8px) !important; cursor: zoom-out !important; }
.qw-lightbox-content { position: relative !important; z-index: 2000001 !important; display: flex !important; flex-direction: column !important; align-items: center !important; max-width: 90vw !important; max-height: 90vh !important; }
.qw-lightbox-img { max-width: 90vw !important; max-height: 80vh !important; border-radius: 8px !important; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7) !important; object-fit: contain !important; cursor: default !important; }
.qw-lightbox-actions { display: flex !important; align-items: center !important; gap: 12px !important; margin-top: 14px !important; }
.qw-lightbox-btn { background: rgba(255, 255, 255, 0.15) !important; border: 1px solid rgba(255, 255, 255, 0.25) !important; color: #fff !important; font-size: 13px !important; font-weight: 500 !important; padding: 6px 14px !important; border-radius: 6px !important; cursor: pointer !important; display: inline-flex !important; align-items: center !important; gap: 6px !important; text-decoration: none !important; transition: background 0.15s, border-color 0.15s !important; }
.qw-lightbox-btn:hover { background: rgba(255, 255, 255, 0.28) !important; border-color: rgba(255, 255, 255, 0.4) !important; }
.qw-lightbox-close { background: rgba(255, 255, 255, 0.2) !important; border: none !important; color: #fff !important; font-size: 15px !important; border-radius: 50% !important; width: 32px !important; height: 32px !important; cursor: pointer !important; display: flex !important; align-items: center !important; justify-content: center !important; transition: background 0.15s !important; }
.qw-lightbox-close:hover { background: #ed4245 !important; }
`;



function injectStyles() {
    if (!document.getElementById("quick-whisper-styles")) {
        const style = document.createElement("style");
        style.id = "quick-whisper-styles";
        style.textContent = PLUGIN_STYLES;
        document.head.appendChild(style);
    }
    updateCustomStyles();
}

function removeStyles() {
    const s1 = document.getElementById("quick-whisper-styles");
    if (s1) s1.remove();
    const s2 = document.getElementById("quick-whisper-custom-styles");
    if (s2) s2.remove();
}

function showToastNotification(text) {
    const existing = document.getElementById("qw-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "qw-toast";
    toast.style.cssText = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        background: #23a55a;
        color: #ffffff;
        font-family: sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 8px 18px;
        border-radius: 9999px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        z-index: 100005;
        pointer-events: none;
        transition: opacity 0.3s ease;
    `;
    toast.textContent = text;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}


function getStore(name, ...props) {
    const common = window.Vencord?.Webpack?.Common;
    if (common && common[name]) return common[name];
    const wp = window.Vencord?.Webpack;
    if (wp && typeof wp.findByProps === "function") return wp.findByProps(...props);
    return null;
}

function getAvatarUrl(author) {
    if (!author) return "https://cdn.discordapp.com/embed/avatars/0.png";
    if (author.avatar) {
        const isGif = author.avatar.startsWith("a_");
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${isGif ? "gif" : "webp"}?size=48`;
    }
    const defaultIndex = author.id ? Number((BigInt(author.id) >> 22n) % 6n) : 0;
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
}

async function apiRequest(method, url, data) {
    const RestAPI = getStore("RestAPI", "get", "post", "put");
    if (RestAPI && typeof RestAPI[method] === "function") {
        if (method === "get") return await RestAPI.get({ url, query: data });
        return await RestAPI.post({ url, body: data });
    }
    const tokenFinder = getStore(null, "getToken");
    const token = tokenFinder?.getToken ? tokenFinder.getToken() : "";
    let fullUrl = `https://discord.com/api/v9${url}`;
    const opts = { method: method.toUpperCase(), headers: { "Authorization": token, "Content-Type": "application/json" } };
    if (method === "get" && data) fullUrl += "?" + new URLSearchParams(data).toString();
    else if (data) opts.body = JSON.stringify(data);
    const res = await fetch(fullUrl, opts);
    return { body: await res.json() };
}

function getAuthToken() {
    try {
        const auth = getStore("AuthenticationStore", "getToken") || window.Vencord?.Webpack?.findByProps?.("getToken");
        if (typeof auth?.getToken === "function") return auth.getToken();
    } catch (e) {}
    return "";
}

async function sendMultipartMessage(channelId, text, file, isVoice = false, durationSecs = 0) {
    try {
        const nonce = (BigInt(Date.now() - 1420070400000) << 22n).toString();
        const filename = file.name || (isVoice ? "voice-message.ogg" : "image.png");
        const payload = {
            content: text || "",
            tts: false,
            nonce: nonce,
            attachments: [{
                id: 0,
                filename: filename
            }]
        };

        if (isVoice) {
            payload.flags = 8192;
            const dummyWaveform = btoa(String.fromCharCode(...new Array(64).fill(128)));
            payload.attachments[0].duration_secs = Math.max(1, Math.round(durationSecs || 1));
            payload.attachments[0].waveform = dummyWaveform;
        }

        const formData = new FormData();
        formData.append("payload_json", JSON.stringify(payload));
        formData.append("files[0]", file, filename);

        const token = getAuthToken();
        const headers = {};
        if (token) headers["Authorization"] = token;

        const res = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
            method: "POST",
            headers,
            body: formData
        });

        if (res.ok) {
            return await res.json();
        } else {
            const errText = await res.text();
            console.error("[MBDM] multipart send error status:", res.status, errText);
        }
    } catch (err) {
        console.error("[MBDM] sendMultipartMessage failed:", err);
    }
    return null;
}

let activeSettingsModal = null;

function closeFloatingSettings() {
    if (activeSettingsModal) {
        window.removeEventListener("pointerdown", handleGlobalSettingsCapture, true);
        window.removeEventListener("mousedown", handleGlobalSettingsCapture, true);
        activeSettingsModal.remove();
        activeSettingsModal = null;
    }
}

function handleGlobalSettingsCapture(e) {
    if (!activeSettingsModal) return;
    if (e.target && (e.target.id === "qw-modal-close" || e.target.closest?.("#qw-modal-close"))) {
        e.preventDefault();
        e.stopPropagation();
        closeFloatingSettings();
        return;
    }
    if (activeSettingsModal.contains(e.target) || e.target.closest?.("#qw-floating-settings, .qw-floating-gear-btn")) {
        return;
    }
    closeFloatingSettings();
}

function positionFloatingSettings(modal, popout) {
    if (!modal || !popout) return;
    const outer = getPopoutOuter(popout) || popout;
    const pRect = outer.getBoundingClientRect();
    const modalWidth = 310;
    const modalHeight = modal.offsetHeight || 420;
    const gap = 12;

    let left;
    if (window.innerWidth - pRect.right >= modalWidth + gap + 10) {
        left = pRect.right + gap;
    } else if (pRect.left >= modalWidth + gap + 10) {
        left = pRect.left - modalWidth - gap;
    } else {
        left = Math.max(10, Math.min(window.innerWidth - modalWidth - 10, pRect.left + (pRect.width - modalWidth) / 2));
    }

    let top = Math.max(15, Math.min(window.innerHeight - modalHeight - 15, pRect.top));

    modal.style.position = "fixed";
    positionOwnedOverlay(modal, Math.round(left), Math.round(top));
    modal.style.zIndex = "100005";
}

function toggleFloatingSettings(gearBtn, popout) {
    if (activeSettingsModal) {
        closeFloatingSettings();
        return;
    }

    const modal = document.createElement("div");
    modal.id = "qw-floating-settings";

    const cfg = getEffectiveConfig();
    modal.innerHTML = `
        <div class="qw-settings-header">
            <div class="qw-settings-title">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"></path>
                </svg>
                MBDM Settings
            </div>
            <button class="qw-settings-close" id="qw-modal-close" title="Close">✕</button>
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">My Bubble Color:</span>
                <div class="qw-color-ctrl">
                    <input type="color" class="qw-color-native" id="qw-my-color-picker" value="${cfg.myColor && /^#[0-9a-f]{6}$/i.test(cfg.myColor) ? cfg.myColor : '#5865f2'}" title="Color Picker" />
                    <button class="qw-set-reset" id="qw-my-color-reset" title="Reset to default">Default</button>
                </div>
            </div>
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Their Bubble Color:</span>
                <div class="qw-color-ctrl">
                    <input type="color" class="qw-color-native" id="qw-their-color-picker" value="${cfg.theirColor && /^#[0-9a-f]{6}$/i.test(cfg.theirColor) ? cfg.theirColor : '#2b2d31'}" title="Color Picker" />
                    <button class="qw-set-reset" id="qw-their-color-reset" title="Reset to default">Default</button>
                </div>
            </div>
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Profile Width:</span>
                <span class="qw-set-val" id="qw-width-val">${cfg.profileWidth}px</span>
            </div>
            <input type="range" class="qw-slider" id="qw-width-slider" min="280" max="750" step="5" value="${cfg.profileWidth}" />
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Chat Height:</span>
                <span class="qw-set-val" id="qw-height-val">${cfg.chatHeight}px</span>
            </div>
            <input type="range" class="qw-slider" id="qw-height-slider" min="150" max="450" step="10" value="${cfg.chatHeight}" />
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Font Size:</span>
                <span class="qw-set-val" id="qw-font-val">${cfg.fontSize}px</span>
            </div>
            <input type="range" class="qw-slider" id="qw-font-slider" min="11" max="18" step="1" value="${cfg.fontSize}" />
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Show Avatar & Username:</span>
                <label class="qw-switch">
                    <input type="checkbox" id="qw-headers-toggle" ${cfg.showHeaders ? "checked" : ""} />
                    <span class="qw-switch-slider"></span>
                </label>
            </div>
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Auto-focus Input:</span>
                <label class="qw-switch">
                    <input type="checkbox" id="qw-focus-toggle" ${cfg.autoFocus ? "checked" : ""} />
                    <span class="qw-switch-slider"></span>
                </label>
            </div>
        </div>
    `;

    getNativeOverlayHost(getPopoutOuter(popout)).appendChild(modal);
    activeSettingsModal = modal;
    positionFloatingSettings(modal, popout);

    const myColor = modal.querySelector("#qw-my-color-picker");
    const myReset = modal.querySelector("#qw-my-color-reset");
    const theirColor = modal.querySelector("#qw-their-color-picker");
    const theirReset = modal.querySelector("#qw-their-color-reset");
    const widthSlider = modal.querySelector("#qw-width-slider");
    const widthVal = modal.querySelector("#qw-width-val");
    const heightSlider = modal.querySelector("#qw-height-slider");
    const heightVal = modal.querySelector("#qw-height-val");
    const fontSlider = modal.querySelector("#qw-font-slider");
    const fontVal = modal.querySelector("#qw-font-val");
    const headersToggle = modal.querySelector("#qw-headers-toggle");
    const focusToggle = modal.querySelector("#qw-focus-toggle");

    function updateSetting(key, val) {
        if (settings?.store) settings.store[key] = val;
        saveStoredConfig({ [key]: val });
        updateCustomStyles();
    }

    myColor.addEventListener("input", e => updateSetting("myColor", e.target.value));
    myReset.addEventListener("click", () => {
        myColor.value = "#5865f2";
        updateSetting("myColor", "");
    });

    theirColor.addEventListener("input", e => updateSetting("theirColor", e.target.value));
    theirReset.addEventListener("click", () => {
        theirColor.value = "#2b2d31";
        updateSetting("theirColor", "");
    });

    widthSlider.addEventListener("input", e => {
        const v = parseInt(e.target.value, 10);
        widthVal.textContent = `${v}px`;
        updateSetting("profileWidth", v);
    });

    heightSlider.addEventListener("input", e => {
        const v = parseInt(e.target.value, 10);
        heightVal.textContent = `${v}px`;
        updateSetting("chatHeight", v);
    });

    fontSlider.addEventListener("input", e => {
        const v = parseInt(e.target.value, 10);
        fontVal.textContent = `${v}px`;
        updateSetting("fontSize", v);
    });

    headersToggle.addEventListener("change", e => updateSetting("showHeaders", e.target.checked));
    focusToggle.addEventListener("change", e => updateSetting("autoFocus", e.target.checked));

    modal.querySelector("#qw-modal-close").addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        closeFloatingSettings();
    });

    setTimeout(() => {
        if (!pluginRunning || activeSettingsModal !== modal || !modal.isConnected) return;
        window.addEventListener("pointerdown", handleGlobalSettingsCapture, true);
        window.addEventListener("mousedown", handleGlobalSettingsCapture, true);
    }, 50);
}

function attachFloatingGear(outer) {
    if (!outer) return;
    const target = getPopoutOuter(outer) || outer;
    if (target.querySelector(".qw-floating-gear-btn")) return;
    try {
        if (window.getComputedStyle(target).position === "static") {
            target.style.position = "relative";
        }
    } catch (e) {}
    const gearBtn = document.createElement("button");
    gearBtn.className = "qw-floating-gear-btn";
    gearBtn.title = "MBDM Settings";
    gearBtn.innerHTML = `
        <svg viewBox="0 0 24 24">
            <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"></path>
        </svg>
    `;
    gearBtn.addEventListener("pointerdown", e => e.stopPropagation());
    gearBtn.addEventListener("mousedown", e => e.stopPropagation());
    gearBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        toggleFloatingSettings(gearBtn, target);
    });
    target.appendChild(gearBtn);
}

function attachTopCloseBtn(outer, userId) {
    if (!outer || outer.querySelector(".qw-top-close-btn")) return;
    const closeBtn = document.createElement("button");
    closeBtn.className = "qw-top-close-btn";
    closeBtn.title = "Close Profile";
    closeBtn.setAttribute("aria-label", "Close Profile");
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18.4 4 12 10.4 5.6 4 4 5.6l6.4 6.4L4 18.4 5.6 20l6.4-6.4 6.4 6.4 1.6-1.6-6.4-6.4L20 5.6 18.4 4Z"></path></svg>';
    closeBtn.addEventListener("pointerdown", event => event.stopPropagation());
    closeBtn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        closeSession(userId);
    });
    // Append only the extra control; leave every native header button in place.
    const moreButton = outer.querySelector('[aria-label="More"], [aria-label^="More "], [aria-label*="المزيد"], [aria-label*="خيارات"]');
    let row = moreButton?.parentElement;
    while (row && row !== outer && row.querySelectorAll('button, [role="button"]').length < 2) row = row.parentElement;
    if (!row || row === outer || row.querySelector('[class*="banner_"]')) row = outer.querySelector('[class*="headerButtons_"]');
    if (row) row.appendChild(closeBtn);
    else {
        closeBtn.style.cssText = "position: absolute; top: 52px; left: 12px;";
        outer.appendChild(closeBtn);
    }
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function openUrl(url) {
    if (!url) return;
    try {
        if (window.DiscordNative?.shell?.openExternal) {
            window.DiscordNative.shell.openExternal(url);
            return;
        }
    } catch (e) {}
    try {
        if (window.Vencord?.Util?.openExternal) {
            window.Vencord.Util.openExternal(url);
            return;
        }
    } catch (e) {}
    try {
        window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {}
}

function formatContent(content) {
    if (!content) return "";
    const escaped = escapeHtml(content);
    const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
    return escaped.replace(urlRegex, url => {
        return `<a href="${url}" class="qw-link" title="${url}" target="_blank" rel="noreferrer">${url}</a>`;
    }).replace(/\n/g, "<br>");
}

function formatTime(timestamp) {
    if (!timestamp) return "";
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function triggerBlobDownload(blob, filename) {
    try {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename || "image.png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        showToastNotification("✅ Downloaded image!");
    } catch (err) {
        console.error("[MBDM] triggerBlobDownload error:", err);
    }
}

async function downloadImage(url, filename = "") {
    if (!url) return;
    try {
        if (!filename) {
            const clean = url.split("?")[0];
            filename = clean.substring(clean.lastIndexOf("/") + 1) || `image_${Date.now()}.png`;
            if (!filename.includes(".")) filename += ".png";
        }

        const fs = window.require?.("fs");
        const path = window.require?.("path");
        const os = window.require?.("os");

        let buffer = null;
        let blob = null;
        try {
            const res = await fetch(url);
            blob = await res.blob();
            const arrayBuf = await blob.arrayBuffer();
            const BufferClass = window.Buffer || window.require?.("buffer")?.Buffer;
            buffer = BufferClass ? BufferClass.from(arrayBuf) : new Uint8Array(arrayBuf);
        } catch (fetchErr) {
            console.warn("[MBDM] Fetch failed for download, opening browser:", fetchErr);
            openUrl(url);
            return;
        }

        if (fs && path && os && buffer) {
            const downloadsDir = path.join(os.homedir(), "Downloads");
            const targetDir = fs.existsSync(downloadsDir) ? downloadsDir : path.join(os.homedir(), "Desktop");
            const destPath = path.join(targetDir, filename);

            fs.writeFile(destPath, buffer, (err) => {
                if (!err) {
                    showToastNotification("✅ Downloaded to Downloads folder!");
                } else {
                    console.error("[MBDM] File write failed, attempting dialog:", err);
                    if (window.DiscordNative?.fileManager?.saveWithDialog) {
                        window.DiscordNative.fileManager.saveWithDialog(buffer, filename);
                        showToastNotification("✅ Saved image!");
                    } else if (blob) {
                        triggerBlobDownload(blob, filename);
                    } else {
                        openUrl(url);
                    }
                }
            });
            return;
        }

        if (window.DiscordNative?.fileManager?.saveWithDialog && buffer) {
            window.DiscordNative.fileManager.saveWithDialog(buffer, filename);
            showToastNotification("✅ Saved image!");
            return;
        }

        if (blob) {
            triggerBlobDownload(blob, filename);
            return;
        }

        openUrl(url);
    } catch (e) {
        console.error("[MBDM] downloadImage error:", e);
        openUrl(url);
    }
}

let activeLightboxCleanup = null;
let activeLightboxOwner = null;

function openLightbox(url, nativeProfile = null) {
    if (!url) return;
    if (activeLightboxCleanup) activeLightboxCleanup();

    const overlay = document.createElement("div");
    overlay.id = "qw-lightbox";
    overlay.innerHTML = `
        <div class="qw-lightbox-backdrop"></div>
        <div class="qw-lightbox-content">
            <img src="${url}" class="qw-lightbox-img" title="Click outside to close | Middle-click to open in browser" />
            <div class="qw-lightbox-actions">
                <button class="qw-lightbox-btn" id="qw-lightbox-download">📥 Download Image</button>
                <a href="${url}" target="_blank" rel="noreferrer" class="qw-lightbox-btn qw-lightbox-link">🌐 Open in Browser</a>
                <button class="qw-lightbox-close" title="Close (Esc)">✕</button>
            </div>
        </div>
    `;

    const backdrop = overlay.querySelector(".qw-lightbox-backdrop");
    const closeBtn = overlay.querySelector(".qw-lightbox-close");
    const openLink = overlay.querySelector(".qw-lightbox-link");
    const downloadBtn = overlay.querySelector("#qw-lightbox-download");
    const imgEl = overlay.querySelector(".qw-lightbox-img");

    if (downloadBtn) {
        downloadBtn.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            downloadImage(url);
        });
    }

    if (openLink) {
        openLink.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            openUrl(url);
        });
    }

    if (imgEl) {
        imgEl.addEventListener("auxclick", e => {
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                openUrl(url);
            }
        });
    }

    function cleanup() {
        window.removeEventListener("keydown", handleKey, true);
        overlay.remove();
        if (activeLightboxCleanup === cleanup) {
            activeLightboxCleanup = null;
            activeLightboxOwner = null;
        }
    }

    function handleOverlayClick(e) {
        // Let the target action run before isolating the overlay event.
        e.stopPropagation();
        if (e.target === backdrop || e.target === closeBtn || closeBtn.contains(e.target)) {
            e.preventDefault();
            cleanup();
        }
    }

    function handleKey(e) {
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            cleanup();
        }
    }

    activeLightboxCleanup = cleanup;
    activeLightboxOwner = nativeProfile;
    overlay.addEventListener("mousedown", e => e.stopPropagation());
    overlay.addEventListener("click", handleOverlayClick);
    window.addEventListener("keydown", handleKey, true);
    getNativeOverlayHost(nativeProfile).appendChild(overlay);
    overlay.style.setProperty("inset", "auto", "important");
    overlay.style.setProperty("width", window.innerWidth + "px", "important");
    overlay.style.setProperty("height", window.innerHeight + "px", "important");
    positionOwnedOverlay(overlay, 0, 0);
}

let activeDragCleanup = null;

function makeDraggable(popout, handle) {
    if (!handle || draggableHandles.has(handle)) return;
    const outer = getPopoutOuter(popout) || popout;
    const originalMarker = handle.getAttribute("data-qw-draggable");
    handle.dataset.qwDraggable = "true";
    setNativeStyle(outer, handle, "cursor", "grab");
    setNativeStyle(outer, handle, "touch-action", "none");
    const downEvent = typeof PointerEvent === "function" ? "pointerdown" : "mousedown";

    function onStart(event) {
        if (event.button !== 0 || isCurrentlyDragging) return;
        if (event.target.closest('[data-qw-draggable="true"]') !== handle) return;
        if (event.target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [aria-haspopup], [contenteditable="true"], .qw-root')) return;
        if (activeDragCleanup) activeDragCleanup();
        const startRect = outer.getBoundingClientRect();
        const startX = event.clientX, startY = event.clientY;
        const pointerId = event.pointerId;
        const focusedComposer = outer.contains(document.activeElement) && document.activeElement?.matches('.qw-input, [contenteditable="true"]') ? document.activeElement : null;
        const selection = focusedComposer && typeof focusedComposer.selectionStart === "number" ? {
            start: focusedComposer.selectionStart, end: focusedComposer.selectionEnd, direction: focusedComposer.selectionDirection
        } : null;
        let moved = false;
        let cleaned = false;
        const previousSelection = document.body.style.userSelect;
        // Header dragging should keep the current composer focused, including
        // its draft and caret. Inputs and native buttons were excluded above.
        if (focusedComposer) event.preventDefault();

        function onMove(moveEvent) {
            if (cleaned) return;
            if (pointerId !== undefined && moveEvent.pointerId !== pointerId) return;
            if (moveEvent.buttons === 0) { endDrag(); return; }
            const dx = moveEvent.clientX - startX, dy = moveEvent.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < 3) return;
            if (!moved) {
                moved = true;
                isCurrentlyDragging = true;
                setNativeStyle(outer, handle, "cursor", "grabbing");
                document.body.style.userSelect = "none";
                if (pointerId !== undefined) { try { handle.setPointerCapture(pointerId); } catch (e) {} }
            }
            moveEvent.preventDefault();
            moveEvent.stopPropagation();
            const left = Math.max(0, Math.min(window.innerWidth - startRect.width, startRect.left + dx));
            const top = Math.max(0, Math.min(window.innerHeight - 60, startRect.top + dy));
            setPopoutScreenPosition(outer, left, top);
        }

        function endDrag(upEvent) {
            if (cleaned) return;
            if (upEvent?.pointerId !== undefined && pointerId !== undefined && upEvent.pointerId !== pointerId) return;
            cleanupDrag();
            if (!moved) return;
            const rect = outer.getBoundingClientRect();
            saveStoredConfig({ lastPosition: { left: Math.round(rect.left), top: Math.round(rect.top) } });
            const suppressDragClick = clickEvent => {
                if (!handle.contains(clickEvent.target)) return;
                clickEvent.preventDefault();
                clickEvent.stopImmediatePropagation();
            };
            handle.addEventListener("click", suppressDragClick, true);
            setTimeout(() => handle.removeEventListener("click", suppressDragClick, true), 0);
            if (focusedComposer?.isConnected && document.hasFocus() && document.activeElement !== focusedComposer) {
                focusedComposer.focus({ preventScroll: true });
                if (selection) focusedComposer.setSelectionRange(selection.start, selection.end, selection.direction);
            }
        }

        function cancelDrag(cancelEvent) {
            if (cancelEvent?.pointerId !== undefined && pointerId !== undefined && cancelEvent.pointerId !== pointerId) return;
            cleanupDrag();
        }

        function cleanupDrag() {
            if (cleaned) return;
            cleaned = true;
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("mousemove", onMove, true);
            window.removeEventListener("pointerup", endDrag, true);
            window.removeEventListener("mouseup", endDrag, true);
            window.removeEventListener("pointercancel", cancelDrag, true);
            window.removeEventListener("blur", cancelDrag, true);
            handle.removeEventListener("lostpointercapture", cancelDrag, true);
            if (pointerId !== undefined) { try { handle.releasePointerCapture(pointerId); } catch (e) {} }
            document.body.style.userSelect = previousSelection;
            setNativeStyle(outer, handle, "cursor", "grab");
            isCurrentlyDragging = false;
            if (activeDragCleanup === cleanupDrag) activeDragCleanup = null;
        }
        activeDragCleanup = cleanupDrag;
        window.addEventListener(downEvent === "pointerdown" ? "pointermove" : "mousemove", onMove, true);
        window.addEventListener(downEvent === "pointerdown" ? "pointerup" : "mouseup", endDrag, true);
        window.addEventListener("pointercancel", cancelDrag, true);
        window.addEventListener("blur", cancelDrag, true);
        handle.addEventListener("lostpointercapture", cancelDrag, true);
    }

    function preventImageDrag(event) { event.preventDefault(); }
    handle.addEventListener(downEvent, onStart, true);
    handle.addEventListener("dragstart", preventImageDrag, true);
    draggableHandles.set(handle, { outer, cleanup() {
        handle.removeEventListener(downEvent, onStart, true);
        handle.removeEventListener("dragstart", preventImageDrag, true);
        if (originalMarker === null) handle.removeAttribute("data-qw-draggable");
        else handle.setAttribute("data-qw-draggable", originalMarker);
        draggableHandles.delete(handle);
    } });
}

function attachDraggables(popout) {
    if (!popout) return;
    const root = getPopoutOuter(popout) || popout;

    const headerHandles = root.querySelectorAll('[class*="bannerSVGWrapper_"], [class*="banner_"], [class*="bannerPremium_"], [class*="headerTop_"], [class*="headerNormal_"], [class*="topSection_"]');
    headerHandles.forEach(h => makeDraggable(root, h));

    const avatars = root.querySelectorAll('[class*="avatarWrapper_"], [class*="avatarPosition_"], [class*="avatarHoverTarget_"], [class*="avatar_"]');
    avatars.forEach(a => {
        if (a.closest(".qw-root")) return;
        makeDraggable(root, a);
    });
}

function createMessageElement(msg, currentUserId, prevMsg) {
    const isMe = String(msg.author?.id) === String(currentUserId);
    const isSameAuthor = prevMsg && String(prevMsg.author?.id) === String(msg.author?.id);
    const timeDiff = prevMsg ? (new Date(msg.timestamp) - new Date(prevMsg.timestamp)) : Infinity;
    const showHeader = !isSameAuthor || timeDiff > 180000;

    const row = document.createElement("div");
    row.className = `qw-msg-row ${isMe ? "qw-msg-me" : "qw-msg-them"} ${showHeader ? "qw-msg-has-header" : "qw-msg-grouped"}`;
    row.dataset.messageId = msg.id;

    let headerHtml = "";
    if (showHeader) {
        const avatarUrl = getAvatarUrl(msg.author);
        const authorName = escapeHtml(msg.author?.global_name || msg.author?.username || (isMe ? "You" : "User"));
        headerHtml = `
            <div class="qw-msg-header">
                <img src="${avatarUrl}" class="qw-author-avatar" loading="lazy" />
                <span class="qw-author-name">${authorName}</span>
            </div>
        `;
    }

    let replyHtml = "";
    if (msg.referenced_message) {
        const author = msg.referenced_message.author?.username || "User";
        const snippet = msg.referenced_message.content || "[Media]";
        replyHtml = `
            <div class="qw-reply-banner">
                <span class="qw-reply-author">${escapeHtml(author)}:</span>
                <span class="qw-reply-text">${escapeHtml(snippet)}</span>
            </div>
        `;
    }

    const timeStr = formatTime(msg.timestamp);
    const contentHtml = formatContent(msg.content);

    row.innerHTML = `
        ${headerHtml}
        <div class="qw-msg-wrapper">
            <div class="qw-msg-bubble">
                ${replyHtml}
                ${contentHtml ? `<div class="qw-msg-text">${contentHtml}</div>` : ""}
                <div class="qw-attachments"></div>
                <div class="qw-msg-time">${timeStr}</div>
            </div>
        </div>
    `;

    const attContainer = row.querySelector(".qw-attachments");
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        for (const att of msg.attachments) {
            const isImg = (att.content_type && att.content_type.startsWith("image/")) ||
                /\.(png|jpe?g|gif|webp)$/i.test(att.url || "");
            const isAudio = (att.content_type && att.content_type.startsWith("audio/")) ||
                /\.(ogg|mp3|wav|m4a|webm)$/i.test(att.url || "") || msg.flags === 8192;

            if (isImg) {
                const img = document.createElement("img");
                img.src = att.url;
                img.className = "qw-msg-img";
                img.loading = "lazy";
                img.title = "Left-click: View | Middle-click: Open in Browser";
                img.addEventListener("click", e => {
                    e.stopPropagation();
                    openLightbox(att.url, img.closest('[data-qw-managed="true"]'));
                });
                img.addEventListener("auxclick", e => {
                    if (e.button === 1) {
                        e.preventDefault();
                        e.stopPropagation();
                        openUrl(att.url);
                    }
                });
                attContainer.appendChild(img);
            } else if (isAudio) {
                const audioBox = document.createElement("div");
                audioBox.className = "qw-voice-msg-player";
                const audio = document.createElement("audio");
                audio.controls = true;
                audio.src = att.url;
                audio.preload = "metadata";
                audioBox.appendChild(audio);
                attContainer.appendChild(audioBox);
            } else {
                const link = document.createElement("a");
                link.href = att.url;
                link.target = "_blank";
                link.rel = "noreferrer";
                link.className = "qw-msg-file";
                link.textContent = `📁 ${att.filename || "File"}`;
                link.addEventListener("click", e => {
                    e.preventDefault();
                    e.stopPropagation();
                    openUrl(att.url);
                });
                attContainer.appendChild(link);
            }
        }
    } else {
        attContainer.remove();
    }

    return row;
}

function buildUI(username, onSend, onLoadOlder, userId = "") {
    const root = document.createElement("div");
    if (userId) root.id = `quick-whisper-root-${userId}`;
    root.className = "qw-root";

    root.innerHTML = `
        <div class="qw-scroller" id="qw-scroller">
            <div class="qw-loading-banner" id="qw-loading-banner" style="display: none;">Loading older...</div>
            <div class="qw-messages-container" id="qw-messages-container"></div>
        </div>
        <div class="qw-composer">
            <div class="qw-attachment-preview" id="qw-attachment-preview" style="display: none;">
                <div class="qw-att-thumb-wrapper">
                    <img class="qw-att-thumb" id="qw-att-thumb" src="" alt="preview" />
                    <button class="qw-att-remove-btn" id="qw-att-remove-btn" title="Remove image">✕</button>
                </div>
                <div class="qw-att-info" id="qw-att-info">image.png</div>
            </div>

            <div class="qw-voice-bar" id="qw-voice-bar" style="display: none;">
                <div class="qw-voice-indicator">
                    <span class="qw-voice-dot"></span>
                    <span class="qw-voice-timer" id="qw-voice-timer">0:00</span>
                </div>
                <div class="qw-voice-actions">
                    <button class="qw-voice-cancel-btn" id="qw-voice-cancel-btn" title="Cancel recording">✕</button>
                    <button class="qw-voice-send-btn" id="qw-voice-send-btn" title="Send voice note">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M6.6 10.02 14 11.4a.6.6 0 0 1 0 1.18L6.6 14l-2.94 5.87a1.48 1.48 0 0 0 1.99 1.98l17.03-8.52a1.48 1.48 0 0 0 0-2.64L5.65 2.16a1.48 1.48 0 0 0-1.99 1.98l2.94 5.88Z"></path>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="qw-input-row" id="qw-input-row">
                <input type="file" accept="image/*" id="qw-file-input" style="display: none;" />
                <button class="qw-composer-action-btn qw-upload-btn" id="qw-upload-btn" title="Upload Image">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path>
                    </svg>
                </button>
                <textarea class="qw-input" id="qw-input" placeholder="Message @${escapeHtml(username)}" rows="1"></textarea>
                <button class="qw-composer-action-btn qw-mic-btn" id="qw-mic-btn" title="Record Voice Note">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"></path>
                    </svg>
                </button>
                <button class="qw-send-btn" id="qw-send-btn" aria-label="Send" title="Send (Enter)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M6.6 10.02 14 11.4a.6.6 0 0 1 0 1.18L6.6 14l-2.94 5.87a1.48 1.48 0 0 0 1.99 1.98l17.03-8.52a1.48 1.48 0 0 0 0-2.64L5.65 2.16a1.48 1.48 0 0 0-1.99 1.98l2.94 5.88Z"></path>
                    </svg>
                </button>
            </div>
        </div>
    `;

    const input = root.querySelector("#qw-input");
    const sendBtn = root.querySelector("#qw-send-btn");
    const scroller = root.querySelector("#qw-scroller");

    const fileInput = root.querySelector("#qw-file-input");
    const uploadBtn = root.querySelector("#qw-upload-btn");
    const micBtn = root.querySelector("#qw-mic-btn");

    const attPreview = root.querySelector("#qw-attachment-preview");
    const attThumb = root.querySelector("#qw-att-thumb");
    const attInfo = root.querySelector("#qw-att-info");
    const attRemoveBtn = root.querySelector("#qw-att-remove-btn");

    const voiceBar = root.querySelector("#qw-voice-bar");
    const voiceTimer = root.querySelector("#qw-voice-timer");
    const voiceCancelBtn = root.querySelector("#qw-voice-cancel-btn");
    const voiceSendBtn = root.querySelector("#qw-voice-send-btn");
    const inputRow = root.querySelector("#qw-input-row");

    let pendingAttachment = null;
    let pendingObjectUrl = null;

    function setPendingAttachment(file) {
        if (!file) return;
        pendingAttachment = file;
        if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
        pendingObjectUrl = URL.createObjectURL(file);

        attThumb.src = pendingObjectUrl;
        const sizeKb = Math.round(file.size / 1024);
        attInfo.textContent = `${file.name || "image.png"} (${sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + " MB" : sizeKb + " KB"})`;
        attPreview.style.display = "flex";
        input.focus();
    }

    function clearAttachment() {
        pendingAttachment = null;
        if (pendingObjectUrl) {
            URL.revokeObjectURL(pendingObjectUrl);
            pendingObjectUrl = null;
        }
        attPreview.style.display = "none";
        attThumb.src = "";
        attInfo.textContent = "";
    }

    attRemoveBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        clearAttachment();
    });

    uploadBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.click();
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) {
            setPendingAttachment(fileInput.files[0]);
            fileInput.value = "";
        }
    });

    function handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type && item.type.startsWith("image/")) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    setPendingAttachment(file);
                }
                return;
            }
        }
    }

    input.addEventListener("paste", handlePaste);
    root.addEventListener("paste", handlePaste);

    setTimeout(() => {
        const outer = getPopoutOuter(root);
        if (outer) outer.addEventListener("paste", handlePaste);
    }, 150);

    let mediaRecorder = null;
    let audioStream = null;
    let recordedChunks = [];
    let recordingTimer = null;
    let recordingStartTime = 0;
    let isCancelled = false;

    async function startRecording() {
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                alert("Microphone is not available in this client.");
                return;
            }
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            let mimeType = "audio/webm;codecs=opus";
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus" : "";
            }

            mediaRecorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
            recordedChunks = [];
            isCancelled = false;

            mediaRecorder.ondataavailable = e => {
                if (e.data && e.data.size > 0) recordedChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                if (audioStream) {
                    audioStream.getTracks().forEach(t => t.stop());
                    audioStream = null;
                }
                clearInterval(recordingTimer);
                recordingTimer = null;
                voiceBar.style.display = "none";
                inputRow.style.display = "flex";

                if (!isCancelled && recordedChunks.length > 0) {
                    const duration = (Date.now() - recordingStartTime) / 1000;
                    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/ogg" });
                    const file = new File([blob], "voice-message.ogg", { type: blob.type });
                    onSend("", file, true, duration);
                }
            };

            mediaRecorder.start(100);
            recordingStartTime = Date.now();
            voiceTimer.textContent = "0:00";
            voiceBar.style.display = "flex";
            inputRow.style.display = "none";

            recordingTimer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                voiceTimer.textContent = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
            }, 500);
        } catch (err) {
            console.error("[MBDM] Mic access error:", err);
        }
    }

    micBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        startRecording();
    });

    voiceCancelBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        isCancelled = true;
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
        }
    });

    voiceSendBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        isCancelled = false;
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
        }
    });

    function executeSend() {
        const text = input.value.trim();
        const file = pendingAttachment;
        if (!text && !file) return;

        clearAttachment();
        input.value = "";
        input.style.height = "auto";
        onSend(text, file, false, 0);
    }

    input.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            executeSend();
        }
    });

    input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 90) + "px";
    });

    sendBtn.addEventListener("click", executeSend);

    scroller.addEventListener("scroll", () => {
        if (scroller.scrollTop < 25) {
            onLoadOlder();
        }
    });

    return root;
}

class WhisperSession {
    constructor(nativeFooter, userId, channelId, username) {
        this.nativeFooter = nativeFooter;
        this.userId = userId;
        this.channelId = channelId;
        this.username = username;
        this.messages = [];
        this.messageMap = new Map();
        this.isLoadingOlder = false;
        this.hasMoreOlder = true;
        this.destroyed = false;

        const UserStore = getStore("UserStore", "getCurrentUser");
        const currentUser = UserStore?.getCurrentUser ? UserStore.getCurrentUser() : null;
        this.currentUserId = currentUser ? currentUser.id : null;

        this.onFluxMessageCreate = this.onFluxMessageCreate.bind(this);
        this.onFluxMessageUpdate = this.onFluxMessageUpdate.bind(this);
        this.onFluxMessageDelete = this.onFluxMessageDelete.bind(this);

        this.init();
    }

    async init() {
        this.ui = buildUI(
            this.username,
            (text, file, isVoice, duration) => this.sendMessage(text, file, isVoice, duration),
            () => this.loadOlder(),
            this.userId
        );

        if (!this.nativeFooter) return;
        const outer = getPopoutOuter(this.nativeFooter);
        if (outer) {
            outer.querySelectorAll(".qw-root").forEach(r => {
                if (r !== this.ui) r.remove();
            });
        }

        const parent = this.nativeFooter.parentNode;
        if (!parent) return;

        parent.querySelectorAll(".qw-root").forEach(r => {
            if (r !== this.ui) r.remove();
        });

        parent.insertBefore(this.ui, this.nativeFooter);
        this.nativeFooterDisplay = [this.nativeFooter.style.getPropertyValue("display"), this.nativeFooter.style.getPropertyPriority("display")];
        this.nativeFooter.style.setProperty("display", "none", "important");
        this.nativeFooter.classList.add("qw-native-hidden");

        const cfg = getEffectiveConfig();
        const shouldFocus = cfg.autoFocus !== false;
        const input = this.ui.querySelector("#qw-input");
        if (input && shouldFocus) {
            this.focusTimer = setTimeout(() => {
                if (!this.destroyed && input.isConnected) input.focus();
            }, 80);
        }



        const closeBtn = this.ui.querySelector("#qw-close-profile-btn");
        if (closeBtn) {
            closeBtn.addEventListener("pointerdown", e => e.stopPropagation());
            closeBtn.addEventListener("mousedown", e => e.stopPropagation());
            closeBtn.addEventListener("click", e => {
                e.preventDefault();
                e.stopPropagation();
                closeSession(this.userId);
            });
        }

        this.container = this.ui.querySelector("#qw-messages-container");
        this.scroller = this.ui.querySelector("#qw-scroller");
        this.loadingBanner = this.ui.querySelector("#qw-loading-banner");

        this.container.addEventListener("click", e => {
            const link = e.target.closest("a.qw-link, a.qw-msg-file");
            if (link && link.href) {
                e.preventDefault();
                e.stopPropagation();
                openUrl(link.href);
                return;
            }

            const selection = window.getSelection();
            if (selection && selection.toString().trim().length > 0) return;

            const bubble = e.target.closest(".qw-msg-bubble");
            if (bubble) {
                const links = bubble.querySelectorAll("a.qw-link");
                if (links.length === 1 && !e.target.closest("img, button, .qw-reply-banner, .qw-msg-time")) {
                    openUrl(links[0].href);
                }
            }
        });

        this.container.addEventListener("auxclick", e => {
            if (e.button === 1) {
                const img = e.target.closest("img.qw-msg-img, img");
                if (img && img.src) {
                    e.preventDefault();
                    e.stopPropagation();
                    openUrl(img.src);
                    return;
                }
                const link = e.target.closest("a.qw-link, a.qw-msg-file");
                if (link && link.href) {
                    e.preventDefault();
                    e.stopPropagation();
                    openUrl(link.href);
                    return;
                }
            }
        });

        this.container.addEventListener("mousedown", e => {
            if (e.button === 1) {
                const img = e.target.closest("img.qw-msg-img, img");
                if (img) e.preventDefault();
            }
        });

        const FluxDispatcher = getStore("FluxDispatcher", "dispatch", "subscribe");
        if (FluxDispatcher?.subscribe) {
            FluxDispatcher.subscribe("MESSAGE_CREATE", this.onFluxMessageCreate);
            FluxDispatcher.subscribe("MESSAGE_UPDATE", this.onFluxMessageUpdate);
            FluxDispatcher.subscribe("MESSAGE_DELETE", this.onFluxMessageDelete);
        }

        await this.loadInitialMessages();
    }

    async loadInitialMessages() {
        try {
            const MessageStore = getStore("MessageStore", "getMessages");
            let cached = [];
            if (MessageStore?.getMessages) {
                const res = MessageStore.getMessages(this.channelId);
                if (res && res._array) cached = res._array;
                else if (Array.isArray(res)) cached = res;
            }

            if (cached && cached.length > 0) {
                this.messages = [...cached];
                this.messageMap.clear();
                for (const m of this.messages) this.messageMap.set(m.id, m);
                this.renderAll(true);
            }

            const res = await apiRequest("get", `/channels/${this.channelId}/messages`, { limit: 50 });
            if (this.destroyed) return;
            if (Array.isArray(res?.body)) {
                const followLatest = !cached.length || this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 40;
                const previousTop = this.scroller.scrollTop;
                this.messages = res.body.reverse();
                this.messageMap.clear();
                for (const m of this.messages) this.messageMap.set(m.id, m);
                this.renderAll(followLatest);
                if (!followLatest) this.scroller.scrollTop = previousTop;
            }
        } catch (err) {
            console.error("[MBDM] Initial load error:", err);
        }
    }

    renderAll(scrollToBottom = false) {
        if (this.destroyed || !this.container) return;
        this.container.innerHTML = "";

        let prev = null;
        for (const msg of this.messages) {
            const el = createMessageElement(msg, this.currentUserId, prev);
            this.container.appendChild(el);
            prev = msg;
        }

        if (scrollToBottom && this.scroller) {
            requestAnimationFrame(() => {
                this.scroller.scrollTop = this.scroller.scrollHeight;
            });
        }
    }

    addMessage(msg) {
        if (this.destroyed || this.messageMap.has(msg.id)) return;
        const followLatest = this.scroller && this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 40;
        this.messageMap.set(msg.id, msg);

        const prev = this.messages[this.messages.length - 1] || null;
        this.messages.push(msg);

        if (this.container) {
            const el = createMessageElement(msg, this.currentUserId, prev);
            this.container.appendChild(el);
            if (followLatest) {
                requestAnimationFrame(() => {
                    this.scroller.scrollTop = this.scroller.scrollHeight;
                });
            }
        }
    }

    async loadOlder() {
        if (this.destroyed || this.isLoadingOlder || !this.hasMoreOlder || this.messages.length === 0) return;
        this.isLoadingOlder = true;
        this.loadingBanner.style.display = "block";

        const oldestId = this.messages[0].id;
        const prevHeight = this.scroller.scrollHeight;
        const prevTop = this.scroller.scrollTop;

        try {
            const res = await apiRequest("get", `/channels/${this.channelId}/messages`, {
                before: oldestId,
                limit: 50
            });
            if (this.destroyed) return;

            if (Array.isArray(res?.body) && res.body.length > 0) {
                const older = res.body.reverse();
                const filtered = older.filter(m => !this.messageMap.has(m.id));

                if (filtered.length === 0) {
                    this.hasMoreOlder = false;
                } else {
                    for (const m of filtered) this.messageMap.set(m.id, m);
                    this.messages = [...filtered, ...this.messages];
                    this.renderAll(false);

                    requestAnimationFrame(() => {
                        const newHeight = this.scroller.scrollHeight;
                        this.scroller.scrollTop = newHeight - prevHeight + prevTop;
                    });
                }
            } else {
                this.hasMoreOlder = false;
            }
        } catch (err) {
            console.error("[MBDM] Older messages error:", err);
        } finally {
            this.isLoadingOlder = false;
            this.loadingBanner.style.display = "none";
        }
    }

    async sendMessage(content, file = null, isVoice = false, duration = 0) {
        try {
            let res;
            if (file) {
                res = await sendMultipartMessage(this.channelId, content, file, isVoice, duration);
            } else {
                const nonce = (BigInt(Date.now() - 1420070400000) << 22n).toString();
                const r = await apiRequest("post", `/channels/${this.channelId}/messages`, {
                    content: content,
                    tts: false,
                    nonce: nonce
                });
                res = r?.body;
            }

            if (res && res.id) {
                this.addMessage(res);
            }
        } catch (err) {
            console.error("[MBDM] send error:", err);
        }
    }

    onFluxMessageCreate(event) {
        const msg = event.message;
        if (!msg) return;
        const chId = event.channelId || msg.channel_id || msg.channelId;
        if (String(chId) !== String(this.channelId)) return;
        this.addMessage(msg);
    }

    onFluxMessageUpdate(event) {
        const msg = event.message;
        if (!msg) return;
        const chId = event.channelId || msg.channel_id || msg.channelId;
        if (String(chId) !== String(this.channelId)) return;

        const existing = this.messageMap.get(msg.id);
        if (!existing) return;

        const updated = Object.assign({}, existing, msg);
        this.messageMap.set(msg.id, updated);

        const idx = this.messages.findIndex(m => m.id === msg.id);
        if (idx !== -1) this.messages[idx] = updated;

        this.renderAll();
    }

    onFluxMessageDelete(event) {
        const chId = event.channelId;
        if (String(chId) !== String(this.channelId)) return;

        this.messageMap.delete(event.id);
        this.messages = this.messages.filter(m => m.id !== event.id);

        this.renderAll();
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        clearTimeout(this.focusTimer);
        const FluxDispatcher = getStore("FluxDispatcher", "dispatch", "subscribe");
        if (FluxDispatcher?.unsubscribe) {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", this.onFluxMessageCreate);
            FluxDispatcher.unsubscribe("MESSAGE_UPDATE", this.onFluxMessageUpdate);
            FluxDispatcher.unsubscribe("MESSAGE_DELETE", this.onFluxMessageDelete);
        }

        if (this.ui && this.ui.parentNode) {
            this.ui.parentNode.removeChild(this.ui);
        }

        if (this.nativeFooter) {
            const [value, priority] = this.nativeFooterDisplay || ["", ""];
            if (value) this.nativeFooter.style.setProperty("display", value, priority);
            else this.nativeFooter.style.removeProperty("display");
            this.nativeFooter.classList.remove("qw-native-hidden");
        }
    }
}

function getUserId(node) {
    if (!node) return null;

    const fiberKey = Object.keys(node).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (fiberKey) {
        let curr = node[fiberKey], depth = 0;
        while (curr && depth < 80) {
            const p = curr.memoizedProps;
            if (p) {
                if (p.user?.id) return String(p.user.id);
                if (p.userId) return String(p.userId);
                if (p.user?.userId) return String(p.user.userId);
                if (p.voiceState?.userId) return String(p.voiceState.userId);
                if (p.speaker?.id) return String(p.speaker.id);
                if (p.member?.userId) return String(p.member.userId);
                if (p.member?.user?.id) return String(p.member.user.id);
                if (p.recipient?.id) return String(p.recipient.id);
                if (p.targetUser?.id) return String(p.targetUser.id);
                if (p.userProfile?.userId) return String(p.userProfile.userId);
                if (p.channel?.recipients?.length === 1) return String(p.channel.recipients[0]);
            }
            if (curr.memoizedState) {
                const s = curr.memoizedState;
                if (s.userId) return String(s.userId);
                if (s.user?.id) return String(s.user.id);
            }
            curr = curr.return; depth++;
        }
    }

    const popout = node.closest?.('[role="dialog"], [id^="popout_"], [class*="layer_"], [class*="userProfileOuter"]');
    if (popout) {
        const popoutFiberKey = Object.keys(popout).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
        if (popoutFiberKey) {
            let curr = popout[popoutFiberKey], depth = 0;
            while (curr && depth < 80) {
                const p = curr.memoizedProps;
                if (p) {
                    if (p.user?.id) return String(p.user.id);
                    if (p.userId) return String(p.userId);
                    if (p.userProfile?.userId) return String(p.userProfile.userId);
                    if (p.currentUser?.id) return String(p.currentUser.id);
                }
                curr = curr.return; depth++;
            }
        }
        for (const img of popout.querySelectorAll('img[src*="/avatars/"]')) {
            if (img.closest('[class*="mutuals_"], [class*="avatars_"], li')) continue;
            const match = img.src.match(/\/avatars\/(\d{17,20})\//);
            if (match) return match[1];
        }
    }

    const label = (node.getAttribute?.("aria-label") || node.getAttribute?.("placeholder") || "");
    const nameMatch = label.match(/Message @(.+)/i);
    if (nameMatch && nameMatch[1]) {
        const rawName = nameMatch[1].trim().toLowerCase();
        const UserStore = getStore("UserStore", "getCurrentUser");
        if (UserStore?.getUsers) {
            const users = UserStore.getUsers();
            for (const id in users) {
                const u = users[id];
                if (u && (u.username?.toLowerCase() === rawName || u.globalName?.toLowerCase() === rawName)) {
                    return String(u.id);
                }
            }
        }
    }

    return null;
}

function handleUnreadDMItemClick(e, target, dmsContainer) {
    if (target.closest?.('[data-list-item-id="guildsnav___home"], [data-guilds-bar-home="true"], .tutorialContainer__1f388, a[href="/channels/@me"]')) {
        return;
    }

    const dmsItem = target.closest?.('#guild-list-unread-dms [class*="listItem"], #guild-list-unread-dms > div, [data-list-item-id^="guildsnav___"]') || target;

    let userId = null;
    let channelId = null;

    const navEl = dmsItem.querySelector?.('[data-list-item-id^="guildsnav___"]') ||
                  (dmsItem.getAttribute?.("data-list-item-id")?.startsWith("guildsnav___") ? dmsItem : null) ||
                  target.closest?.('[data-list-item-id^="guildsnav___"]');
    if (navEl) {
        const rawId = navEl.getAttribute("data-list-item-id");
        if (rawId && rawId !== "guildsnav___home") {
            channelId = rawId.replace("guildsnav___", "");
        }
    }

    const avatarImg = dmsItem.querySelector?.('img[src*="/avatars/"]') ||
                      (target.tagName === "IMG" && target.src?.includes("/avatars/") ? target : null);
    if (avatarImg?.src) {
        const match = avatarImg.src.match(/\/avatars\/(\d{17,20})\//);
        if (match) userId = match[1];
    }

    if (!userId && channelId) {
        const ChannelStore = getStore("ChannelStore", "getChannel");
        const ch = ChannelStore?.getChannel ? ChannelStore.getChannel(channelId) : null;
        if (ch) {
            if (typeof ch.getRecipientId === "function") userId = String(ch.getRecipientId());
            else if (ch.recipients && ch.recipients.length > 0) userId = String(ch.recipients[0]);
            else if (ch.recipientId) userId = String(ch.recipientId);
            else if (ch.rawRecipients && ch.rawRecipients.length > 0) userId = String(ch.rawRecipients[0]?.id || ch.rawRecipients[0]);
        }
    }

    if (!userId) {
        userId = getUserId(target) || getUserId(dmsItem) || (navEl ? getUserId(navEl) : null);
    }

    const UserStore = getStore("UserStore", "getCurrentUser");
    const currentUser = UserStore?.getCurrentUser ? UserStore.getCurrentUser() : null;
    if (userId && currentUser && String(userId) === String(currentUser.id)) {
        return;
    }

    if (!userId) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type !== "click") return;
    if (openNativeProfile(userId, { channelId, anchor: target })) return;
    // Bootstrap from Discord's own profile when its lazy native renderer has
    // not been seen yet. This never navigates the conversation into the DM.
    const actions = getStore("UserProfileActions", "openUserProfileModal", "closeUserProfileModal");
    actions?.openUserProfileModal?.({ userId, channelId, analyticsLocation: { page: "DM Channel", section: "Profile Popout" } });
}

function handleTriggerToggle(event) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!target?.closest || target.closest('[role="dialog"], [id^="popout_"], [role="menu"], #qw-lightbox, #qw-floating-settings')) return;
    const dmsContainer = target.closest("#guild-list-unread-dms");
    if (dmsContainer) {
        handleUnreadDMItemClick(event, target, dmsContainer);
        return;
    }
    if (event.type !== "click") return;
    const trigger = target.closest('[data-user-id], [class*="voiceUser"], [class*="member_"], [class*="username"], [class*="avatar_"], [class*="avatarWrapper_"]');
    if (!trigger) return;
    const userId = trigger.getAttribute("data-user-id") || getUserId(target) || getUserId(trigger);
    const currentUser = getStore("UserStore", "getCurrentUser")?.getCurrentUser?.();
    if (!userId || String(userId) === String(currentUser?.id)) return;
    if (!openNativeProfile(userId, { anchor: trigger })) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

async function resolveDMChannelId(userId) {
    const ChannelStore = getStore("ChannelStore", "getDMFromUserId");
    if (ChannelStore?.getDMFromUserId) {
        const channelId = ChannelStore.getDMFromUserId(userId);
        if (channelId) return channelId;
    }

    try {
        const res = await apiRequest("post", "/users/@me/channels", { recipients: [userId] });
        if (res?.body?.id) return res.body.id;
    } catch (err) {
        console.error("[MBDM] DM channel creation failed:", err);
    }

    return null;
}

async function inspectNativeTextbox(textbox) {
    if (!pluginRunning || !textbox?.isConnected || textbox._qwInspecting) return false;
    const nativeFooter = textbox.closest('[class*="footer_"], [class*="channelTextArea_"]') || textbox.parentElement;
    const outer = getPopoutOuter(nativeFooter);
    const userId = getUserId(textbox);
    if (!outer || !userId || !nativeFooter?.parentElement) return false;
    const owned = ownedNativeProfiles.get(String(userId));
    if (!owned || !isOwnedNativeProfile(outer, owned)) {
        const descriptor = captureNativeProfileDescriptor(outer, userId);
        if (descriptor) {
            nativeProfileDescriptor ||= descriptor;
            const nativeClose = getNativePopoutClose(outer);
            if (openNativeProfile(userId, { anchor: outer }, descriptor)) {
                if (nativeClose) nativeClose();
                return true;
            }
        }
        return false;
    }
    owned.outer = outer;
    if (pendingNativeMounts.has(outer)) return false;
    const existing = activeSessions.get(userId);
    if (existing?.outer === outer && existing.session.ui?.isConnected) return true;
    if (existing) cleanupNativeSession(userId);
    const token = { userId };
    pendingNativeMounts.set(outer, token);
    textbox._qwInspecting = true;
    try {
        const channelId = await resolveDMChannelId(userId);
        if (!channelId || !pluginRunning || !outer.isConnected || !nativeFooter.isConnected || pendingNativeMounts.get(outer) !== token) return false;
        const label = textbox.getAttribute("aria-label") || "";
        const user = getStore("UserStore", "getCurrentUser")?.getUser?.(userId);
        const username = user?.username || label.match(/Message @(.+)/i)?.[1] || "user";
        const attributes = new Map(["data-qw-managed", "data-qw-position-layer"].map(name => [name, outer.getAttribute(name)]));
        outer.dataset.qwManaged = "true";
        outer.dataset.qwPositionLayer = "true";
        const chatHost = nativeFooter.parentElement;
        const hadHostClass = chatHost.classList.contains("qw-chat-host");
        chatHost.classList.add("qw-chat-host");
        positionProfilePopout(outer, sessionStack.length);
        const session = new WhisperSession(nativeFooter, userId, channelId, username);
        const onPointerDown = () => bringToFront(userId);
        activeSessions.set(userId, { userId, outer, session, attributes, nativeClose: getNativePopoutClose(outer), onPointerDown, chatHost, hadHostClass });
        sessionStack.push(userId);
        outer.addEventListener("pointerdown", onPointerDown, true);
        attachDraggables(outer);
        attachFloatingGear(outer);
        attachTopCloseBtn(outer, userId);
        bringToFront(userId);
        return true;
    } catch (err) {
        console.error("[MBDM] Native profile mount failed:", err);
        return false;
    } finally {
        if (pendingNativeMounts.get(outer) === token) pendingNativeMounts.delete(outer);
        textbox._qwInspecting = false;
    }
}

function scan() {
    if (!pluginRunning) return;
    // The native profile must always have its X control, even when Discord
    // omits the message footer or the DM request is still loading.
    const candidates = document.querySelectorAll('div[id^="popout_"], [role="dialog"][class*="userProfile"], [class*="userPopoutOuter"]');
    for (const record of ownedNativeProfiles.values()) {
        if (!record.outer?.isConnected) {
            record.outer = [...candidates].find(candidate => !candidate.querySelector('[role="menu"]') && isOwnedNativeProfile(candidate, record)) || null;
        }
        if (!record.outer) continue;
        if (record.initializedOuter !== record.outer) {
            record.outer.dataset.qwManaged = "true";
            record.outer.dataset.qwPositionLayer = "true";
            positionProfilePopout(record.outer, sessionStack.length);
            record.initializedOuter = record.outer;
        }
        attachTopCloseBtn(record.outer, record.userId);
        attachDraggables(record.outer);
    }
    for (const [handle, binding] of draggableHandles) {
        if (handle.isConnected) continue;
        binding.cleanup();
        const snapshot = nativeStyleSnapshots.get(handle);
        if (snapshot) {
            for (const [property, [value, priority]] of snapshot.properties) {
                if (value) handle.style.setProperty(property, value, priority);
                else handle.style.removeProperty(property);
            }
            nativeStyleSnapshots.delete(handle);
        }
    }
    for (const [outer] of pendingNativeMounts) {
        if (!outer.isConnected) pendingNativeMounts.delete(outer);
    }
    for (const [uid, data] of [...activeSessions]) {
        if (!data.outer.isConnected || !data.session.ui?.isConnected) {
            cleanupNativeSession(uid);
            continue;
        }
        attachDraggables(data.outer);
        attachFloatingGear(data.outer);
        attachTopCloseBtn(data.outer, uid);
    }
    for (const tb of document.querySelectorAll('[role="textbox"], textarea')) {
        if (tb.closest('main, [class*="chatContent_"], .qw-root, [role="menu"], [class*="note_"], [class*="userInfoSection_"], [class*="userBio_"], [class*="customStatus_"]')) continue;
        if (tb._qwInspecting) continue;
        const isMessage = (tb.getAttribute("aria-label") || "").includes("@") ||
            (tb.getAttribute("placeholder") || "").includes("@") ||
            tb.closest('[class*="channelTextArea_"], [class*="footer_"]');
        if (!isMessage || !tb.closest('[role="dialog"], [id^="popout_"], [class*="userProfile"]')) continue;
        const outer = getPopoutOuter(tb);
        if (outer.querySelector(".qw-root") || pendingNativeMounts.has(outer)) continue;
        inspectNativeTextbox(tb).catch(err => console.error("[MBDM] Profile inspection failed:", err));
    }
}

const plugin = _definePlugin({
    name: "MBDM",
    description: "Mini DM client in user profiles",
    authors: [{ name: "MBdr", id: 0n }],
    settings,
    startAt: (typeof StartAt !== "undefined" && StartAt?.WebpackReady) ? StartAt.WebpackReady : "WebpackReady",
    enabledByDefault: true,

    start() {
        pluginRunning = true;
        injectStyles();
        enforcePopoutWidth();
        observer = new MutationObserver(() => {
            scan();
        });
        const rootNode = document.body;
        observer.observe(rootNode, { childList: true, subtree: true });
        window.addEventListener("resize", enforcePopoutWidth);
        document.addEventListener("click", handleTriggerToggle, true);
        document.addEventListener("pointerdown", handleTriggerToggle, true);
        document.addEventListener("mousedown", handleTriggerToggle, true);
        scan();
    },

    stop() {
        pluginRunning = false;
        pendingNativeMounts.clear();
        pendingProfileRequests.clear();
        window.removeEventListener("resize", enforcePopoutWidth);
        document.removeEventListener("pointerdown", handleTriggerToggle, true);
        document.removeEventListener("mousedown", handleTriggerToggle, true);
        document.removeEventListener("mouseup", handleTriggerToggle, true);
        document.removeEventListener("click", handleTriggerToggle, true);
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        for (const userId of [...activeSessions.keys()]) cleanupNativeSession(userId);
        for (const userId of [...ownedNativeProfiles.keys()]) destroyOwnedNativeProfile(userId);

        sessionStack.length = 0;
        if (activeDragCleanup) {
            activeDragCleanup();
        }
        removeStyles();
        document.querySelectorAll(".qw-native-hidden").forEach(el => {
            el.style.removeProperty("display");
            el.classList.remove("qw-native-hidden");
        });
        document.querySelectorAll(".qw-root").forEach(el => el.remove());
        document.querySelectorAll("[data-qw-inspected]").forEach(el => delete el.dataset.qwInspected);
        closeFloatingSettings();
        if (activeLightboxCleanup) activeLightboxCleanup();
        document.querySelectorAll(".qw-floating-gear-btn").forEach(el => el.remove());
        document.querySelectorAll(".qw-top-close-btn").forEach(el => el.remove());
        const fs = document.getElementById("qw-floating-settings");
        if (fs) fs.remove();
        const lb = document.getElementById("qw-lightbox");
        if (lb) lb.remove();
        const toast = document.getElementById("qw-toast");
        if (toast) toast.remove();
    }
});

if (typeof module !== "undefined" && module.exports) {
    module.exports = plugin;
    module.exports.default = plugin;
}
if (typeof exports !== "undefined") {
    exports.default = plugin;
}

export default plugin;

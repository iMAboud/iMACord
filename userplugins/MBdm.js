import definePlugin, { StartAt } from "@utils/types";

let observer = null;
const activeSessions = new Map();
const sessionStack = [];
let isCurrentlyDragging = false;
let pluginRunning = false;
const pendingNativeMounts = new Map();
const nativeStyleSnapshots = new Map();
const nativeAttributeSnapshots = new Map();
const draggableHandles = new Map();
const ownedNativeProfiles = new Map();
const pendingProfileRequests = new Map();
let nativeProfileDescriptor = null;
let focusedProfileRequest = null;
let profileFocusRequestId = 0;
let profileFocusAnimation = 0;
let profileFocusTimer = 0;
let globalFileDropTargetUserId = null;
let globalFileDropListening = false;
let voiceUnreadSyncFrame = 0;
const voiceUnreadStoreCleanups = [];
const conversationRoleStoreCleanups = [];
const routedVoiceUnreads = new Map();
const pendingVoiceUnreadAcks = new Map();
const VOICE_UNREAD_ACK_GRACE_MS = 2000;

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

function resolveNativeProfileContext(anchor, descriptor, options = {}) {
    const ChannelStore = getStore("ChannelStore", "getChannel");
    let guildId = options.guildId;
    let channelId = options.profileChannelId;
    if (!Object.prototype.hasOwnProperty.call(options, "guildId")) {
        let directMessage = false;
        for (let fiber = getElementFiber(anchor); fiber; fiber = fiber.return) {
            const props = fiber.memoizedProps;
            if (!props || typeof props !== "object") continue;
            const channel = props.channel || ChannelStore?.getChannel?.(props.channelId);
            if (props.guildId === null || (channel && !channel.guild_id && (channel.type === 1 || channel.type === 3 || channel.recipients?.length))) {
                directMessage = true;
                guildId = undefined;
                channelId = channel?.id;
                break;
            }
            guildId ??= props.guildId ?? props.guild?.id ?? props.member?.guildId ?? channel?.guild_id;
            channelId ??= channel?.id;
            if (guildId) break;
        }
        const selectedChannelId = getStore("SelectedChannelStore", "getChannelId")?.getChannelId?.();
        const selectedChannel = ChannelStore?.getChannel?.(selectedChannelId);
        if (!directMessage) guildId ??= getStore("SelectedGuildStore", "getGuildId")?.getGuildId?.() ?? selectedChannel?.guild_id;
        if (guildId && (!channelId || ChannelStore?.getChannel?.(channelId)?.guild_id !== guildId)) {
            channelId = selectedChannel?.guild_id === guildId ? selectedChannelId : undefined;
        }
    }
    return { guildId: guildId || undefined, channelId: channelId || options.channelId };
}

function makeReusableNativeDescriptor(descriptor) {
    const identityProps = new Set(["user", "userId", "currentUser", "member", "guildMember", "profile", "userProfile", "guildProfile", "guildMemberProfile", "displayProfile", "guild", "guildId", "channel", "channelId", "voiceState"]);
    return { ...descriptor, props: Object.fromEntries(Object.entries(descriptor.props).filter(([key]) => !identityProps.has(key))), providers: [] };
}

function openNativeProfile(userId, options = {}, descriptor = resolveNativeProfileDescriptor()) {
    if (!pluginRunning || !userId || !descriptor) return false;
    userId = String(userId);
    if (ownedNativeProfiles.has(userId)) {
        activateProfile(userId, true);
        const session = activeSessions.get(userId)?.session;
        session?.scrollToLatest();
        return true;
    }
    const runtime = getReactRuntime();
    const UserStore = getStore("UserStore", "getCurrentUser");
    const user = UserStore?.getUser?.(userId) || (String(descriptor.props.user?.id) === userId ? descriptor.props.user : null);
    if (!runtime || !user) return false;
    cancelPendingProfileFocus();
    focusedProfileRequest = userId;
    const host = document.createElement("div");
    host.className = "qw-native-react-root";
    host.dataset.qwNativeUser = userId;
    host.style.cssText = "position: fixed; width: 1px; height: 1px; pointer-events: none;";
    host.style.left = Math.round(window.innerWidth / 2) + "px";
    host.style.top = "80px";
    document.body.appendChild(host);
    const record = { userId, host, root: runtime.createRoot(host), descriptor, outer: null, context: null };
    ownedNativeProfiles.set(userId, record);
    const anchorRef = { current: null };
    const noop = () => {};
    const context = resolveNativeProfileContext(options.anchor, descriptor, options);
    record.context = context;
    const props = {
        ...descriptor.props,
        userId, user,
        currentUser: UserStore.getCurrentUser?.(),
        channelId: context.channelId || getStore("ChannelStore", "getDMFromUserId")?.getDMFromUserId?.(userId),
        guildId: context.guildId,
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
    let providers = options.nativeCapture ? descriptor.providers : captureNativeProviders(options.anchor);
    if (!providers.length) providers = descriptor.providers;
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
    if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== "important") {
        element.style.setProperty(property, value, "important");
    }
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
    for (const [element, snapshot] of nativeAttributeSnapshots) {
        if (snapshot.owner !== owner) continue;
        for (const [name, value] of snapshot.attributes) {
            if (value === null) element.removeAttribute(name);
            else element.setAttribute(name, value);
        }
        nativeAttributeSnapshots.delete(element);
    }
}

function setNativeAttribute(owner, element, name, value) {
    let snapshot = nativeAttributeSnapshots.get(element);
    if (!snapshot) {
        snapshot = { owner, attributes: new Map() };
        nativeAttributeSnapshots.set(element, snapshot);
    }
    if (!snapshot.attributes.has(name)) snapshot.attributes.set(name, element.getAttribute(name));
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

const _definePlugin = typeof definePlugin === "function" ? definePlugin : (window.Vencord?.Plugins?.definePlugin || (p => p));

const STORAGE_KEY = "MBDM_persistent_config";
const DEFAULT_CONFIG = { profileWidth: 260, chatWidth: 420, profileHeight: 570, fontSize: 14, showHeaders: false };
const CONFIG_KEYS = ["myColor", "theirColor", "profileWidth", "chatWidth", "profileHeight", "fontSize", "showHeaders", "lastPosition", "nativeSplitLayoutVersion", "configUpdatedAt"];
let currentConfig = null;

function getStoredConfig() {
    if (currentConfig) return currentConfig;
    let legacy = {}, saved = {};
    try { legacy = Object.assign({}, window.Vencord?.Settings?.plugins?.MBDM || {}); } catch (e) {}
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
        }
    } catch (e) {}
    currentConfig = Number(legacy.configUpdatedAt || 0) > Number(saved.configUpdatedAt || 0)
        ? Object.assign({}, saved, legacy) : Object.assign({}, legacy, saved);
    return currentConfig;
}

function saveStoredConfig(updates, persist = true) {
    // Apply first. Discord may remove localStorage after initialization, and
    // failed persistence must never turn a working slider into a label-only edit.
    currentConfig = Object.assign({}, getStoredConfig(), updates, { configUpdatedAt: Date.now() });
    if (persist) persistStoredConfig();
}

function persistStoredConfig() {
    if (!currentConfig) return;
    // Preserve the plugin manager's live enabled/favorite flags when flushing
    // pending profile settings during shutdown.
    const snapshot = Object.fromEntries(CONFIG_KEYS.filter(key => Object.prototype.hasOwnProperty.call(currentConfig, key)).map(key => [key, currentConfig[key]]));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch (e) {}
    try {
        const plugins = window.Vencord?.Settings?.plugins;
        if (plugins) {
            if (!plugins.MBDM) plugins.MBDM = {};
            for (const [key, value] of Object.entries(snapshot)) {
                if (plugins.MBDM[key] !== value) plugins.MBDM[key] = value;
            }
        }
    } catch (e) {}
}

function getEffectiveConfig() {
    // Profile settings are local to the floating panel. Retain older saved
    // plugin preferences without exposing a second settings page.
    const st = getStoredConfig();
    const boundedNumber = (value, fallback, min, max) => {
        const numeric = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
        return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
    };
    const color = value => typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : "";
    return {
        myColor: color(st.myColor),
        theirColor: color(st.theirColor),
        profileWidth: boundedNumber(st.profileWidth, DEFAULT_CONFIG.profileWidth, 180, 750),
        chatWidth: boundedNumber(st.chatWidth, DEFAULT_CONFIG.chatWidth, 240, 620),
        profileHeight: boundedNumber(st.profileHeight, DEFAULT_CONFIG.profileHeight, 320, 900),
        fontSize: boundedNumber(st.fontSize, DEFAULT_CONFIG.fontSize, 11, 18),
        showHeaders: st.showHeaders === true,
    };
}

function getContrastColor(hex) {
    if (!hex || typeof hex !== "string") return "";
    let r, g, b;
    if (hex.startsWith("#")) {
        let clean = hex.replace("#", "");
        if (clean.length === 3) clean = clean.split("").map(c => c + c).join("");
        if (clean.length !== 6 && clean.length !== 8) return "";
        r = parseInt(clean.substring(0, 2), 16);
        g = parseInt(clean.substring(2, 4), 16);
        b = parseInt(clean.substring(4, 6), 16);
    } else {
        const match = hex.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i);
        if (!match) return "";
        [, r, g, b] = match.map(Number);
    }
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

function getNativeSplitDimensions() {
    const cfg = getEffectiveConfig();
    const width = Math.min(cfg.profileWidth + cfg.chatWidth, Math.max(0, window.innerWidth - 20));
    const ratio = cfg.profileWidth / (cfg.profileWidth + cfg.chatWidth);
    return { width, detailsWidth: width * ratio, chatWidth: width * (1 - ratio), height: Math.min(cfg.profileHeight, Math.max(0, window.innerHeight - 20)) };
}

function getAttachedProfileWidth() { return getNativeSplitDimensions().width; }
function getAttachedProfileHeight() { return getNativeSplitDimensions().height; }

function getNativeProfileParts(outer) {
    const frame = getNativeProfileFrame(outer);
    const surfaces = '.user-profile-popout, [class*="userProfileOuter"], [class*="userPopoutOuter"], [class*="userProfileModalOuter"]';
    // Retain the actual native surface after sizing adds width tokens to its
    // ancestors. Otherwise a later lookup can mistake a portal for the card.
    const surface = (frame.matches('[data-qw-native-surface="true"]') ? frame : frame.querySelector('[data-qw-native-surface="true"]'))
        || (frame.matches(surfaces) ? frame : frame.querySelector(surfaces))
        || frame.querySelector('[class^="outer_"], [class*=" outer_"]')
        || frame.querySelector('[style*="--custom-user-profile-popout-width"]') || frame;
    const excluded = element => element.closest('.qw-root, [class*="profileEffects_"], [class*="profileEffect_"]');
    const banner = [...surface.querySelectorAll('[class*="bannerSVGWrapper_"], [class*="bannerPremium_"], [class*="banner_"]')].find(element => !excluded(element));
    const inner = [...surface.children].find(element => !excluded(element) && (element.matches('[class*="userProfileInner_"], [class*="userPopoutInner_"]') || [...element.classList].some(name => name.startsWith('inner_'))) && (!banner || element.contains(banner))) || surface;
    const bodies = [...surface.querySelectorAll('[class*="body_"], [class*="bodyContainer_"], [class*="profileBody_"], [class*="scroller_"]')].filter(element => !excluded(element) && !element.contains(banner));
    const body = bodies.find(element => !bodies.some(parent => parent !== element && parent.contains(element))) || null;
    return { frame, surface, inner, banner, body };
}

function applyProfilePointerRouting(outer, parts) {
    const { frame, surface } = parts;
    // Discord's portal and dialog shells can cover areas outside the painted
    // profile. Keep those shells transparent to pointer hit-testing while the
    // real card (and plugin chat below it) remains fully interactive.
    const transparentShells = new Set([outer, frame]);
    for (let parent = surface?.parentElement; parent && frame?.contains(parent); parent = parent.parentElement) {
        transparentShells.add(parent);
        if (parent === frame) break;
    }
    for (const element of transparentShells) {
        if (element && element !== surface) setNativeStyle(outer, element, "pointer-events", "none");
    }
    if (surface) setNativeStyle(outer, surface, "pointer-events", "auto");
}

function resizeNativeBanner(outer, banner, width) {
    if (!banner) return;
    setNativeStyle(outer, banner, 'width', '100%');
    setNativeStyle(outer, banner, 'max-width', 'none');
    const svg = banner.matches('svg') ? banner : banner.querySelector('svg');
    if (!svg) return;
    const viewBox = svg.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number);
    const height = parseFloat(getComputedStyle(svg).height) || viewBox?.[3] || parseFloat(getComputedStyle(banner).height) || 100;
    setNativeAttribute(outer, svg, 'width', String(width));
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) setNativeAttribute(outer, svg, 'viewBox', [viewBox[0], viewBox[1], width, viewBox[3]].join(' '));
    setNativeStyle(outer, svg, 'width', '100%');
    setNativeStyle(outer, svg, 'height', height + 'px');
    for (const element of svg.querySelectorAll('foreignObject, mask rect')) {
        // Preserve the native avatar cutout and banner height; only its
        // full-width painted area follows the shared profile width.
        if (element.tagName.toLowerCase() === 'rect' && element.getAttribute('width') === '100%') continue;
        setNativeAttribute(outer, element, 'width', String(width));
    }
}

function applyPopoutDimensions(outer) {
    if (!outer) return;
    const dimensions = getNativeSplitDimensions();
    const parts = getNativeProfileParts(outer);
    const { frame, surface, inner, banner, body } = parts;
    const width = dimensions.width + 'px', height = dimensions.height + 'px';
    setNativeAttribute(outer, frame, 'data-qw-native-split', 'true');
    setNativeAttribute(outer, surface, 'data-qw-native-surface', 'true');
    const shells = new Set([outer, frame, surface, inner]);
    for (let parent = surface.parentElement; parent && frame.contains(parent); parent = parent.parentElement) {
        shells.add(parent);
        if (parent === frame) break;
    }
    for (const element of shells) {
        const nested = element !== outer && element !== frame;
        for (const property of ['width', 'min-width', 'max-width']) setNativeStyle(outer, element, property, nested ? '100%' : width);
        for (const property of ['height', 'min-height', 'max-height']) setNativeStyle(outer, element, property, nested ? '100%' : height);
        setNativeStyle(outer, element, '--custom-user-profile-popout-width', width);
        setNativeStyle(outer, element, 'box-sizing', 'border-box');
        setNativeStyle(outer, element, 'overflow', 'visible');
        if (element !== outer && getComputedStyle(element).position === 'static') setNativeStyle(outer, element, 'position', 'relative');
    }
    applyProfilePointerRouting(outer, parts);
    // Let the native frame decoration overhang, while preserving Discord's
    // own clipping inside the effect so its intro starts within the card.
    for (const effect of frame.querySelectorAll('[class*="profileEffects_"], [class*="profileEffect_"]')) {
        if (effect.parentElement?.closest('[class*="profileEffects_"], [class*="profileEffect_"]')) continue;
        for (let parent = effect.parentElement; parent && frame.contains(parent); parent = parent.parentElement) {
            setNativeStyle(outer, parent, 'overflow', 'visible');
            if (parent === frame) break;
        }
    }
    // Constrain only siblings along the banner's ancestry. Discord retains
    // ownership of all profile content; no React nodes are moved or wrapped.
    const bannerPath = new Set();
    for (let node = banner; node && surface.contains(node); node = node.parentElement) {
        bannerPath.add(node);
        if (node === surface) break;
    }
    for (const parent of new Set([inner, ...bannerPath])) {
        if (parent === banner || parent.closest('[class*="profileEffects_"], [class*="profileEffect_"]')) continue;
        for (const child of parent.children) {
            if (bannerPath.has(child) || child.closest('.qw-root') || child.matches('[class*="profileEffects_"], [class*="profileEffect_"]') || child.matches('[data-qw-native-actions], [class*="native-actions"], [class*="headerButtons"], [class*="buttons_"], [class*="buttonsContainer"]')) continue;
            if (['absolute', 'fixed'].includes(getComputedStyle(child).position) || child.matches('[class*="avatar"]')) continue;
            const childStyle = getComputedStyle(child);
            const contentWidth = Math.max(0, dimensions.detailsWidth - (parseFloat(childStyle.marginLeft) || 0) - (parseFloat(childStyle.marginRight) || 0)) + 'px';
            setNativeStyle(outer, child, 'box-sizing', 'border-box');
            setNativeStyle(outer, child, 'width', contentWidth);
            setNativeStyle(outer, child, 'max-width', contentWidth);
            setNativeStyle(outer, child, 'min-width', '0px');
        }
    }
    resizeNativeBanner(outer, banner, Math.max(0, surface.clientWidth - parseFloat(getComputedStyle(surface).paddingLeft) - parseFloat(getComputedStyle(surface).paddingRight)));
    if (body) {
        const bodyStyle = getComputedStyle(body);
        const bodyWidth = Math.max(0, dimensions.detailsWidth - (parseFloat(bodyStyle.marginLeft) || 0) - (parseFloat(bodyStyle.marginRight) || 0)) + 'px';
        setNativeAttribute(outer, body, 'data-qw-native-details', 'true');
        setNativeStyle(outer, body, 'box-sizing', 'border-box');
        setNativeStyle(outer, body, 'width', bodyWidth);
        setNativeStyle(outer, body, 'max-width', bodyWidth);
        setNativeStyle(outer, body, 'min-height', '0px');
        setNativeStyle(outer, body, 'flex', '0 1 auto');
        setNativeStyle(outer, body, 'overflow-y', 'auto');
        setNativeStyle(outer, body, 'overflow-x', 'hidden');
        setNativeStyle(outer, body, 'scrollbar-width', 'thin');
        setNativeStyle(outer, body, 'scrollbar-color', 'rgba(127, 127, 127, 0.3) transparent');
        const rect = body.getBoundingClientRect(), card = surface.getBoundingClientRect();
        const scaleY = surface.offsetHeight ? card.height / surface.offsetHeight : 1;
        setNativeStyle(outer, body, 'max-height', Math.max(0, (card.bottom - rect.top) / (scaleY || 1) - 14) + 'px');
    }
    return parts;
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

function getOverlayScale(element, rect, style = getComputedStyle(element)) {
    let width = parseFloat(style.width), height = parseFloat(style.height);
    if (style.boxSizing !== 'border-box') {
        width += (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
        height += (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    }
    // offsetWidth/Height round fractional sizes to integers, which can make
    // transformed overlays alternate between two sizes on every frame.
    return { x: width > 0 ? rect.width / width : 1, y: height > 0 ? rect.height / height : 1 };
}

function positionOwnedOverlay(element, left, top) {
    const style = getComputedStyle(element);
    if (style.left === 'auto') element.style.setProperty('left', '0px', 'important');
    if (style.top === 'auto') element.style.setProperty('top', '0px', 'important');
    const rect = element.getBoundingClientRect();
    const { x: scaleX, y: scaleY } = getOverlayScale(element, rect, style);
    if (Math.abs(left - rect.left) > .5) element.style.setProperty("left", ((parseFloat(style.left) || 0) + (left - rect.left) / (scaleX || 1)) + "px", "important");
    if (Math.abs(top - rect.top) > .5) element.style.setProperty("top", ((parseFloat(style.top) || 0) + (top - rect.top) / (scaleY || 1)) + "px", "important");
}

function getNativeOverlayHost(outer) {
    // Use the shared positioning layer so native profile scrolling cannot
    // clip the plugin's settings or full-window image viewer.
    return outer?.parentElement || document.body;
}

function getNativeProfileFrame(outer) {
    return outer.querySelector('[role="dialog"]') || outer.querySelector(".user-profile-popout") || outer;
}

function getChatProfileOwner(element) {
    for (const data of activeSessions.values()) {
        if (data.session.ui?.contains(element)) return data.outer;
    }
    return element.closest('[data-qw-managed="true"]');
}

function syncChatTheme(frame, ui) {
    const surfaces = [...frame.querySelectorAll('[style*="--profile-gradient-"], .user-profile-popout, [class*="userProfileInner"], [class*="inner_"]')].reverse();
    surfaces.push(frame);
    let primary, secondary, text, muted, background;
    for (const surface of surfaces) {
        const style = getComputedStyle(surface);
        const validColor = value => value && CSS.supports("color", value) ? value : undefined;
        primary ||= validColor(style.getPropertyValue("--profile-gradient-primary-color").trim());
        secondary ||= validColor(style.getPropertyValue("--profile-gradient-secondary-color").trim());
        text ||= validColor(style.getPropertyValue("--text-normal").trim());
        muted ||= validColor(style.getPropertyValue("--text-muted").trim());
        if (!background && style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") background = style.backgroundColor;
    }
    const variables = {
        "--qw-profile-primary": primary || background || "#1c1d20",
        "--qw-profile-secondary": secondary || primary || background || "#1c1d20",
        "--qw-profile-text": text || "#e4e4e7",
        "--qw-profile-muted": muted || text || "#b5b6bc"
    };
    let changed = false;
    for (const [name, value] of Object.entries(variables)) {
        if (ui.style.getPropertyValue(name) !== value) {
            ui.style.setProperty(name, value);
            changed = true;
        }
    }
    return changed;
}



function findNativeChatAction(outer, action) {
    const labels = {
        call: /call|مكالمة|اتصال/i,
        video: /video|فيديو|مرئي/i,
        more: /more|المزيد|خيارات/i
    };
    return [...outer.querySelectorAll('button, [role="button"]')].find(button => {
        if (button.closest(".qw-root") || button.className?.includes?.("qw-")) return false;
        const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
        return labels[action].test(label) && (action !== "call" || !labels.video.test(label));
    });
}

function getNativeProfileActions(surface, action) {
    if (!action) return null;
    const named = action.closest('[data-qw-native-actions], [class*="native-actions"], [class*="headerButtons"], [class*="buttons_"], [class*="buttonsContainer"]');
    if (named && named !== action && surface.contains(named)) return named;
    // Native action containers have changed names between Discord versions.
    // Find their compact shared row without moving the banner or its content.
    for (let node = action.parentElement; node && node !== surface && surface.contains(node); node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 80 || rect.width > Math.max(320, surface.getBoundingClientRect().width * .7)) break;
        const buttons = [...node.querySelectorAll('button, [role="button"]')].filter(button => !button.closest('.qw-root') && button.getClientRects().length);
        if (buttons.length > 1) return node;
    }
    return null;
}

function alignNativeProfileActions(outer, actions, controls) {
    if (!actions || !controls) return;
    setNativeAttribute(outer, actions, 'data-qw-native-actions', 'true');
    setNativeStyle(outer, actions, 'width', 'max-content');
    setNativeStyle(outer, actions, 'max-width', 'none');
    setNativeStyle(outer, actions, 'flex-wrap', 'nowrap');
    setNativeStyle(outer, actions, 'flex-shrink', '0');
    let style = getComputedStyle(actions);
    if (style.position === 'static') setNativeStyle(outer, actions, 'position', 'relative');
    // Position from measured edges in the row's own coordinate space. Its
    // parent need not be the profile surface, and native transforms stay intact.
    setNativeStyle(outer, actions, 'left', 'auto');
    style = getComputedStyle(actions);
    const row = actions.getBoundingClientRect(), target = controls.getBoundingClientRect();
    const scaleX = actions.offsetWidth ? row.width / actions.offsetWidth : 1;
    const scaleY = actions.offsetHeight ? row.height / actions.offsetHeight : 1;
    const deltaX = target.left - 6 * (scaleX || 1) - row.right;
    const deltaY = target.top + target.height / 2 - row.top - row.height / 2;
    if (Math.abs(deltaX) > .5) setNativeStyle(outer, actions, 'right', ((parseFloat(style.right) || 0) - deltaX / (scaleX || 1)) + 'px');
    if (Math.abs(deltaY) > .5) setNativeStyle(outer, actions, 'top', ((parseFloat(style.top) || 0) + deltaY / (scaleY || 1)) + 'px');
}

function getNativeChatHost(parts) {
    const effects = [...parts.frame.querySelectorAll('[class*="profileEffects_"], [class*="profileEffect_"]')];
    // Share a paint context with the real effects, including versions where
    // Discord places the effect beside its themed inner surface.
    for (let host = parts.inner; host && parts.frame.contains(host); host = host.parentElement) {
        if (effects.every(effect => host.contains(effect))) return host;
        if (host === parts.frame) break;
    }
    return parts.frame;
}

function updateNativeChatLayer(parts, ui) {
    let level = 1;
    for (const effect of parts.frame.querySelectorAll('[class*="profileEffects_"], [class*="profileEffect_"]')) {
        for (const visual of [effect, ...effect.querySelectorAll('*')]) {
            const nativeLevel = parseInt(getComputedStyle(visual).zIndex, 10);
            if (Number.isFinite(nativeLevel)) level = Math.max(level, nativeLevel + 1);
        }
    }
    ui.dataset.chatLayer = String(level);
    if (ui.style.zIndex !== String(level)) ui.style.zIndex = String(level);
}

function attachChatLayout(outer, ui) {
    let parts = applyPopoutDimensions(outer);
    // Keep chat inside the actual native card so its hover effects include
    // both columns. Only plugin-owned UI is appended; native nodes stay put.
    getNativeChatHost(parts).appendChild(ui);
    ui.classList.add('qw-native-split-chat');
    let stopped = false, animation = 0, lastGeometry = '', nextThemeRead = 0, dirty = true;
    const header = ui.querySelector('.qw-header');

    function refresh(force = true) {
        if (stopped || !outer.isConnected || !ui.isConnected) return;
        const { frame, surface, banner } = getNativeProfileParts(outer);
        if (force || performance.now() >= nextThemeRead) {
            syncChatTheme(frame, ui);
            if (activeSettingsOwner === outer && activeSettingsModal) syncSettingsTheme(outer, activeSettingsModal);
            const nextParts = getNativeProfileParts(outer);
            const host = getNativeChatHost(nextParts);
            if (ui.parentElement !== host && !isCurrentlyDragging) host.appendChild(ui);
            updateNativeChatLayer(nextParts, ui);
            nextThemeRead = performance.now() + 250;
        }
        let rect = surface.getBoundingClientRect();
        let bannerRect = banner?.getBoundingClientRect();
        const controls = header.querySelector('.qw-header-controls');
        const controlsWidth = controls.getBoundingClientRect().width;
        const action = findNativeChatAction(outer, 'more') || findNativeChatAction(outer, 'call');
        const actions = getNativeProfileActions(surface, action);
        const actionsRect = actions?.getBoundingClientRect();
        const geometry = [rect.x, rect.y, rect.width, rect.height, bannerRect?.bottom, controlsWidth, actionsRect?.x, actionsRect?.y, actionsRect?.width, actionsRect?.height, window.innerWidth, window.innerHeight].join(':');
        if (!force && geometry === lastGeometry) return;
        parts = applyPopoutDimensions(outer);
        rect = surface.getBoundingClientRect();
        const targetLeft = Math.max(10, Math.min(window.innerWidth - rect.width - 10, rect.left));
        const targetTop = Math.max(10, Math.min(window.innerHeight - rect.height - 10, rect.top));
        if (Math.abs(targetLeft - rect.left) > .5 || Math.abs(targetTop - rect.top) > .5) {
            const portal = outer.getBoundingClientRect();
            setPopoutScreenPosition(outer, portal.left + targetLeft - rect.left, portal.top + targetTop - rect.top);
            rect = surface.getBoundingClientRect();
            bannerRect = banner?.getBoundingClientRect();
        }
        const dimensions = getNativeSplitDimensions();
        const nativeStyle = getComputedStyle(surface);
        const scaleX = surface.offsetWidth ? rect.width / surface.offsetWidth : 1;
        const scaleY = surface.offsetHeight ? rect.height / surface.offsetHeight : 1;
        const insetLeft = parseFloat(nativeStyle.borderLeftWidth) + parseFloat(nativeStyle.paddingLeft);
        const insetRight = parseFloat(nativeStyle.borderRightWidth) + parseFloat(nativeStyle.paddingRight);
        const insetBottom = parseFloat(nativeStyle.borderBottomWidth) + parseFloat(nativeStyle.paddingBottom);
        const leftWidth = dimensions.detailsWidth;
        const left = rect.left + (insetLeft + leftWidth) * scaleX;
        const top = Math.min(rect.bottom - 80 * scaleY, Math.max(rect.top + 46 * scaleY, bannerRect?.bottom || rect.top + 100 * scaleY));
        const width = Math.max(0, rect.right - insetRight * scaleX - left);
        const height = Math.max(0, rect.bottom - insetBottom * scaleY - top - 10 * scaleY);
        const uiRect = ui.getBoundingClientRect();
        const { x: uiScaleX, y: uiScaleY } = getOverlayScale(ui, uiRect);
        ui.style.width = width / (uiScaleX || 1) + 'px';
        ui.style.height = height / (uiScaleY || 1) + 'px';
        positionOwnedOverlay(ui, left, top);
        header.style.width = width / (uiScaleX || 1) + 'px';
        positionOwnedOverlay(header, left, rect.top + (parseFloat(nativeStyle.borderTopWidth) + 8) * scaleY);
        // Keep Discord's real native action buttons. Settings and X share
        // their row over the full-width banner instead of a second chat header.
        for (const button of header.querySelectorAll('[data-qw-native-action]')) button.hidden = true;
        if (action) {
            const actionStyle = getComputedStyle(action);
            const background = actionStyle.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'rgba(24, 22, 32, .75)' : actionStyle.backgroundColor;
            for (const [name, value] of [['--qw-native-action-background', background], ['--qw-native-action-text', actionStyle.color]]) {
                if (header.style.getPropertyValue(name) !== value) header.style.setProperty(name, value);
            }
        }
        alignNativeProfileActions(outer, actions, controls);
        // Keep the empty drag region clear of native buttons even when the
        // chat glass paints above their original stacking layer.
        const spacer = header.querySelector('.qw-header-spacer');
        spacer.style.marginRight = actions ? (actions.getBoundingClientRect().width + 6 * scaleX) / (uiScaleX || 1) + 'px' : '0px';
        if (activeSettingsOwner === outer) positionFloatingSettings(activeSettingsModal, outer);
        ui.dataset.side = 'inside';
        lastGeometry = geometry;
    }
    function trackPosition() {
        if (stopped) return;
        const force = dirty;
        dirty = false;
        refresh(force);
        animation = requestAnimationFrame(trackPosition);
    }
    const resizeObserver = new ResizeObserver(() => { dirty = true; });
    resizeObserver.observe(parts.surface);
    if (parts.banner) resizeObserver.observe(parts.banner);
    const nativeObserver = new MutationObserver(records => {
        if (records.some(record => !record.target.closest?.('.qw-root, #qw-floating-settings, #qw-lightbox'))) dirty = true;
    });
    nativeObserver.observe(parts.frame, { childList: true, attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
    refresh();
    animation = requestAnimationFrame(trackPosition);
    return { refresh, destroy() {
        stopped = true;
        cancelAnimationFrame(animation);
        resizeObserver.disconnect();
        nativeObserver.disconnect();
    } };
}

function positionProfilePopout(outer, index = 0) {
    if (!outer) return;
    const parts = applyPopoutDimensions(outer);
    const width = getAttachedProfileWidth();
    const saved = getStoredConfig().lastPosition;
    const offset = index * 24;
    const combinedWidth = width;
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, (saved?.left ?? (window.innerWidth - combinedWidth) / 2) + offset));
    const top = Math.max(10, Math.min(window.innerHeight - 80, (saved?.top ?? (window.innerHeight - getAttachedProfileHeight()) / 2) + offset));
    const positionStyles = { position: "fixed", transform: "none", right: "auto", bottom: "auto", margin: "0" };
    if (getNativeProfileFrame(outer) !== outer) positionStyles.overflow = "visible";
    for (const [property, value] of Object.entries(positionStyles)) {
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
    for (const data of activeSessions.values()) data.session.layout?.refresh();
}

function bringToFront(userId) {
    userId = String(userId);
    // Discord owns portal stacking, including menus and modals opened by its
    // original profile buttons. Never raise the profile above those portals.
    const idx = sessionStack.indexOf(userId);
    if (idx !== -1) {
        sessionStack.splice(idx, 1);
        sessionStack.push(userId);
    }
    for (let i = 0; i < sessionStack.length; i++) {
        const record = ownedNativeProfiles.get(String(sessionStack[i]));
        // Both columns and the native decoration share this portal's stack.
        const level = 10 + i;
        if (record?.outer) setNativeStyle(record.outer, record.outer, "z-index", String(level));
        const session = activeSessions.get(String(sessionStack[i]))?.session;
        // Chat paints above the native background inside its own portal.
        if (session?.ui) session.ui.style.zIndex = session.ui.dataset.chatLayer || "1";
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
    if (globalFileDropTargetUserId === userId) {
        data.outer.classList.remove("qw-file-drop-active");
        globalFileDropTargetUserId = null;
    }
    activeSessions.delete(userId);
    const idx = sessionStack.indexOf(userId);
    if (idx !== -1) sessionStack.splice(idx, 1);
    if (focusedProfileRequest === userId) {
        cancelPendingProfileFocus();
        focusedProfileRequest = sessionStack.length ? String(sessionStack[sessionStack.length - 1]) : null;
    }
    const owned = ownedNativeProfiles.get(userId);
    const nativeClose = requestClose && !owned && data.outer.isConnected ? (getNativePopoutClose(data.outer) || data.nativeClose) : null;
    if (activeDragCleanup) activeDragCleanup();
    closeFloatingSettings();
    if (activeLightboxCleanup && activeLightboxOwner === data.outer) activeLightboxCleanup();
    try { data.session.destroy(); } catch (e) {}
    for (const [handle, binding] of draggableHandles) {
        if (binding.outer === data.outer) binding.cleanup();
    }
    data.outer.removeEventListener("pointerdown", data.onPointerActivate, true);
    data.outer.removeEventListener("focusin", data.onFocusActivate, true);
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

    const myColor = cfg.myColor || "#613f45";
    const theirColor = cfg.theirColor || "#99578d";
    const myTextContrast = getContrastColor(myColor) || "#ffffff";
    const theirTextContrast = getContrastColor(theirColor) || "#ffffff";

    let el = document.getElementById("quick-whisper-custom-styles");
    if (!el) {
        el = document.createElement("style");
        el.id = "quick-whisper-custom-styles";
        document.head.appendChild(el);
    }

    el.textContent = `
        .qw-root {
            --qw-my-bubble-color: ${myColor};
            --qw-their-bubble-color: ${theirColor};
            --qw-my-bubble-text: ${myTextContrast};
            --qw-their-bubble-text: ${theirTextContrast};
        }
        .qw-msg-bubble { font-size: ${cfg.fontSize}px !important; }
        .qw-msg-header { display: ${cfg.showHeaders ? "flex" : "none"} !important; }
        .qw-msg-them .qw-msg-wrapper { padding-left: ${cfg.showHeaders ? "46px" : "0"}; }
        .qw-msg-me .qw-msg-bubble { background: var(--qw-my-bubble-color) !important; }
        .qw-msg-them .qw-msg-bubble { background: var(--qw-their-bubble-color) !important; }
        .qw-msg-me .qw-msg-bubble, .qw-msg-me .qw-msg-text, .qw-msg-me .qw-reply-author, .qw-msg-me .qw-reply-text, .qw-msg-me .qw-msg-file { color: var(--qw-my-bubble-text) !important; }
        .qw-msg-them .qw-msg-bubble, .qw-msg-them .qw-msg-text, .qw-msg-them .qw-reply-author, .qw-msg-them .qw-reply-text, .qw-msg-them .qw-msg-file { color: var(--qw-their-bubble-text) !important; }
        .qw-msg-me .qw-msg-time { color: color-mix(in srgb, var(--qw-my-bubble-text) 70%, transparent) !important; }
        .qw-msg-them .qw-msg-time { color: color-mix(in srgb, var(--qw-their-bubble-text) 70%, transparent) !important; }
        .qw-msg-me .qw-reply-banner { border-bottom-color: color-mix(in srgb, var(--qw-my-bubble-text) 20%, transparent) !important; }
        .qw-msg-them .qw-reply-banner { border-bottom-color: color-mix(in srgb, var(--qw-their-bubble-text) 20%, transparent) !important; }
    `;
    refreshAllConversationRoleColors();
}

const PLUGIN_STYLES = `
:root { --qw-profile-width: 260px; }
[data-qw-voice-unread-hidden="true"],
#guild-list-unread-dms[data-qw-voice-unread-empty="true"] {
    display: none !important;
}
.qw-voice-unread-dot {
    --qw-voice-unread-color: #f23f43;
    display: inline-block;
    width: 8px;
    height: 8px;
    min-width: 8px;
    flex: 0 0 8px;
    margin-right: 5px;
    border-radius: 50%;
    vertical-align: middle;
    background: var(--qw-voice-unread-color);
    box-shadow: 0 0 5px var(--qw-voice-unread-color), 0 0 10px color-mix(in srgb, var(--qw-voice-unread-color) 85%, transparent);
    animation: qw-voice-unread-pulse 1.35s ease-in-out infinite;
}
.qw-voice-unread-status-slot {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    flex: 0 0 auto;
    margin-left: auto;
}
@keyframes qw-voice-unread-pulse {
    0%, 100% { opacity: 0.78; box-shadow: 0 0 4px var(--qw-voice-unread-color), 0 0 8px color-mix(in srgb, var(--qw-voice-unread-color) 65%, transparent); }
    50% { opacity: 1; box-shadow: 0 0 7px var(--qw-voice-unread-color), 0 0 14px color-mix(in srgb, var(--qw-voice-unread-color) 95%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
    .qw-voice-unread-dot { animation: none; }
}
[data-qw-managed="true"] {
    box-sizing: border-box !important;
    --reference-position-layer-max-height: calc(100vh - 20px) !important;
}
[data-qw-managed="true"] [role="dialog"],
[data-qw-managed="true"] .user-profile-popout,
[data-qw-managed="true"] [class*="userProfileOuter"],
[data-qw-managed="true"] [class*="userProfileModalOuter"],
[data-qw-managed="true"] [class*="userPopoutOuter"],
[data-qw-managed="true"] [class*="userProfileInner"] {
    box-sizing: border-box !important;
}
[data-qw-managed="true"] [data-qw-native-surface="true"] {
    pointer-events: auto !important;
}

.qw-native-hidden { display: none !important; }

.qw-root, #quick-whisper-root, [id^="quick-whisper-root"] {
    display: flex !important;
    flex-direction: column !important;
    padding: 0 !important;
    background: linear-gradient(135deg, color-mix(in srgb, var(--qw-profile-primary, #1c1d20) 76%, transparent), color-mix(in srgb, var(--qw-profile-secondary, #1c1d20) 76%, transparent)) !important;
    backdrop-filter: blur(22px) saturate(1.1) !important;
    -webkit-backdrop-filter: blur(22px) saturate(1.1) !important;
    box-shadow: none !important;
    border: 1px solid color-mix(in srgb, var(--qw-profile-text, #fff) 12%, transparent) !important;
    border-radius: 0 16px 16px 0 !important;
    box-sizing: border-box !important;
    min-width: 0 !important;
    min-height: 0 !important;
    position: fixed !important;
    overflow: hidden;
    pointer-events: auto !important;
    color: var(--qw-profile-text, #e4e4e7);
    direction: ltr;
    font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
}
.qw-chat-sidecar[data-side="left"] {
    border-radius: 16px 0 0 16px !important;
}
.qw-root.qw-native-split-chat {
    background: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    border: 0 !important;
    border-left: 1px solid color-mix(in srgb, var(--qw-profile-text, #fff) 12%, transparent) !important;
    border-radius: 0 !important;
    overflow: visible !important;
    isolation: auto !important;
}
.qw-native-split-chat > .qw-chat-glass {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: linear-gradient(135deg, color-mix(in srgb, var(--qw-profile-primary, #1c1d20) 16%, transparent), color-mix(in srgb, var(--qw-profile-secondary, #1c1d20) 12%, transparent));
    backdrop-filter: blur(18px) saturate(1.1);
    -webkit-backdrop-filter: blur(18px) saturate(1.1);
}
.qw-native-split-chat .qw-scroller,
.qw-native-split-chat .qw-composer { position: relative; z-index: 1; }
.qw-native-split-chat .qw-header {
    position: fixed;
    height: 36px;
    min-height: 36px;
    padding: 0 10px;
    border: 0;
    z-index: 40;
    pointer-events: none;
}
.qw-native-split-chat .qw-header-controls,
.qw-native-split-chat .qw-header-spacer { pointer-events: auto; }
.qw-root.qw-native-split-chat .qw-scroller { padding: 16px 14px 10px !important; }
.qw-native-split-chat .qw-composer {
    margin: 8px 14px 0 !important;
    width: calc(100% - 28px) !important;
    border-radius: 12px !important;
    background: color-mix(in srgb, var(--qw-profile-text, #241b22) 22%, var(--qw-profile-primary, #1c1d20)) !important;
    border: 0 !important;
}
.qw-native-split-chat .qw-msg-them .qw-msg-bubble { background: var(--qw-their-bubble-color, #99578d) !important; color: var(--qw-their-bubble-text, #fff) !important; }
.qw-native-split-chat .qw-msg-me .qw-msg-bubble { background: var(--qw-my-bubble-color, #613f45) !important; color: var(--qw-my-bubble-text, #fff) !important; }
.qw-native-split-chat .qw-msg-header { position: static; display: flex; align-items: center; gap: 5px; margin: 8px 0 4px; }
.qw-native-split-chat .qw-author-avatar { width: 20px; height: 20px; }
.qw-native-split-chat .qw-author-name { display: inline; color: var(--qw-profile-text); font-size: 12px; }
.qw-native-split-chat .qw-msg-them .qw-msg-wrapper { padding-left: 0; }
.qw-native-split-chat .qw-msg-me .qw-msg-header { display: none !important; }
.qw-native-split-chat .qw-header-controls button {
    background: var(--qw-native-action-background, rgba(24, 22, 32, .75)) !important;
    color: var(--qw-native-action-text, #f4f3f5) !important;
    border: 0 !important;
}
.qw-top-close-btn {
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    min-height: 32px !important;
    border-radius: 50% !important;
    background: rgba(0, 0, 0, 0.55) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    color: var(--interactive-normal, #b5bac1) !important;
    cursor: pointer !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 0 !important;
    margin: 0 !important;
    transition: transform 0.18s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease !important;
    box-shadow: none !important;
    flex-shrink: 0 !important;
    z-index: 1000 !important;
}
.qw-top-close-btn:hover {
    color: #ffffff !important;
    background: #303136 !important;
    border-color: #484950 !important;
}
.qw-top-close-btn svg {
    width: 15px !important;
    height: 15px !important;
    fill: currentColor !important;
    display: block !important;
}
.qw-header {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 8px 14px;
    box-sizing: border-box;
    flex-shrink: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--qw-profile-text, #fff) 10%, transparent);
}
.qw-header-controls { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.qw-header-action { width: 32px; height: 32px; border: 0; padding: 7px; border-radius: 50%; background: color-mix(in srgb, var(--qw-profile-primary, #18191c) 70%, transparent); color: var(--qw-profile-text, #bfc0c6); cursor: pointer; }
.qw-header-action:hover { background: color-mix(in srgb, var(--qw-profile-text, #fff) 10%, transparent); }
.qw-header-action[hidden] { display: none; }
.qw-header-action svg { width: 18px; height: 18px; fill: currentColor; }
.qw-date-divider { display: flex; align-items: center; gap: 14px; margin: 2px 0 18px; font-size: 12px; color: var(--qw-profile-muted, #b5b6bc); }
.qw-date-divider::before, .qw-date-divider::after { content: ""; height: 1px; background: color-mix(in srgb, var(--qw-profile-text, #fff) 10%, transparent); flex: 1; }
.qw-chat-sidecar button:focus-visible { outline: 2px solid #b5b6bc; outline-offset: 2px; }
.qw-root.qw-chat-sidecar { isolation: isolate; }
.qw-root.qw-chat-sidecar .qw-scroller {
    height: auto;
    flex: 1 1 0;
    padding: 22px 20px 12px;
    scroll-behavior: smooth;
}
@media (prefers-reduced-motion: reduce) {
    .qw-root.qw-chat-sidecar .qw-scroller { scroll-behavior: auto; }
}
.qw-header-spacer {
    flex: 1;
    min-width: 20px;
    min-height: 34px;
    align-self: stretch;
    cursor: grab;
}
.qw-header-spacer:active {
    cursor: grabbing;
}

.qw-scroller {
    min-height: 0;
    flex: 1 1 0;
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
.qw-messages-container { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
.qw-msg-row { display: flex; position: relative; flex-direction: column; width: 100%; }
.qw-msg-row.qw-msg-has-header { margin-top: 10px; }
.qw-msg-header { display: flex; position: absolute; left: 0; top: 8px; }
.qw-msg-me .qw-msg-header { visibility: hidden; }
.qw-author-avatar { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; }
.qw-author-name { display: none; }
.qw-msg-wrapper { display: flex; width: 100%; }
.qw-msg-me .qw-msg-wrapper { justify-content: flex-end; }
.qw-msg-them .qw-msg-wrapper { justify-content: flex-start; }
.qw-msg-them .qw-msg-wrapper { padding-left: 46px; box-sizing: border-box; }
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
    max-width: 85%;
    padding: 12px 16px;
    font-size: 13px;
    line-height: 1.42;
    word-break: break-word;
    position: relative;
    unicode-bidi: plaintext;
    text-align: start;
    box-shadow: none !important;
}
.qw-msg-them .qw-msg-bubble {
    background: color-mix(in srgb, var(--qw-profile-primary, #292a2e) 88%, var(--qw-profile-text, #fff) 12%) !important;
    border: 1px solid rgba(255, 255, 255, 0.02) !important;
    color: var(--qw-profile-text, #dbdee1) !important;
    border-radius: 16px 16px 16px 5px;
    box-shadow: none !important;
}
.qw-msg-me .qw-msg-bubble {
    background: #99578d !important;
    color: #ffffff !important;
    border-radius: 16px 16px 5px 16px;
    box-shadow: none !important;
}
.qw-msg-text { unicode-bidi: plaintext; text-align: start; }
.qw-msg-time { font-size: 10px; opacity: 0.65; margin-top: 5px; text-align: start; }
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
    margin: 12px 18px 20px !important;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--qw-profile-primary, #25262a) 76%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--qw-profile-text, #fff) 12%, transparent) !important;
    border-radius: 28px !important;
    padding: 8px 10px !important;
    box-shadow: none !important;
    transition: all 0.2s ease !important;
    box-sizing: border-box !important;
    width: calc(100% - 36px) !important;
}
.qw-composer:focus-within {
    border-color: #484950 !important;
    box-shadow: none !important;
}
.qw-input-row {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    width: 100% !important;
    position: relative !important;
    z-index: 2 !important;
    pointer-events: auto !important;
}
.qw-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--qw-profile-text, #dbdee1);
    font-family: inherit;
    font-size: 13px;
    resize: none;
    max-height: 90px;
    line-height: 1.4;
    padding: 10px 6px;
    unicode-bidi: plaintext;
    text-align: start;
    box-sizing: border-box;
    pointer-events: auto !important;
}
.qw-input::placeholder { color: var(--qw-profile-muted, #949ba4); }
.qw-composer-action-btn {
    background: transparent !important;
    border: none !important;
    color: var(--qw-profile-text, #b5bac1) !important;
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
    color: var(--qw-profile-text, #b5bac1) !important;
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
    color: var(--interactive-hover, #ffffff) !important;
    transform: scale(1.1) !important;
}
.qw-attachment-preview {
    display: block;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    width: 100%;
    box-sizing: border-box;
    max-height: 150px;
    overflow-y: auto;
}
.qw-attachment-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.qw-att-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 3px 22px 3px 3px;
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.06);
}
.qw-att-thumb {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    object-fit: cover;
    border-radius: 6px;
    display: block;
}
.qw-att-file-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.1);
    color: var(--qw-profile-text, #dbdee1);
    font-size: 20px;
}
.qw-att-remove-btn {
    position: absolute;
    top: 4px;
    right: 3px;
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
.qw-att-name, .qw-att-size { display: block; overflow: hidden; text-overflow: ellipsis; }
.qw-att-size { margin-top: 2px; color: var(--qw-profile-muted, #949ba4); font-size: 10px; }
[data-qw-managed="true"].qw-file-drop-active .qw-composer {
    outline: 2px solid var(--interactive-active, #5865f2) !important;
    outline-offset: 2px !important;
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
    position: static !important;
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    min-height: 32px !important;
    border-radius: 50% !important;
    background: color-mix(in srgb, var(--qw-profile-primary, #151619) 70%, transparent) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    color: var(--interactive-normal, #b5bac1) !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 1000 !important;
    transition: transform 0.25s ease, background 0.2s ease, color 0.2s ease !important;
    box-shadow: none !important;
    padding: 0 !important;
}
.qw-header-controls .qw-top-close-btn { position: static !important; background: color-mix(in srgb, var(--qw-profile-primary, #151619) 70%, transparent) !important; }
.qw-header-controls button { color: var(--qw-profile-text, #dbdee1) !important; }
[data-qw-managed="true"] > .qw-top-close-btn { position: absolute; top: 16px; right: 14px; }
.qw-floating-gear-btn:hover {
    color: #ffffff !important;
    background: rgba(0, 0, 0, 0.8) !important;
}
.qw-floating-gear-btn svg {
    width: 16px !important;
    height: 16px !important;
    fill: currentColor !important;
    display: block !important;
}
#qw-floating-settings {
    --text-normal: var(--qw-profile-text, #dbdee1);
    --text-muted: var(--qw-profile-muted, #b5bac1);
    --header-secondary: var(--qw-profile-muted, #b5bac1);
    --interactive-normal: var(--qw-profile-text, #b5bac1);
    position: fixed !important;
    width: 310px !important;
    background: linear-gradient(135deg, color-mix(in srgb, var(--qw-profile-primary, #16171b) 94%, transparent), color-mix(in srgb, var(--qw-profile-secondary, #16171b) 94%, transparent)) !important;
    backdrop-filter: blur(20px) !important;
    -webkit-backdrop-filter: blur(20px) !important;
    border: 1px solid var(--qw-settings-border, color-mix(in srgb, var(--qw-profile-text, #fff) 16%, transparent)) !important;
    border-radius: var(--qw-settings-radius, 14px) !important;
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
    border-bottom: 1px solid color-mix(in srgb, var(--qw-profile-text, #fff) 14%, transparent) !important;
}
.qw-settings-title {
    font-size: 14px !important;
    font-weight: 700 !important;
    color: var(--text-normal, #ffffff) !important;
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
    color: var(--text-normal, #ffffff) !important;
    background: color-mix(in srgb, var(--qw-profile-text, #fff) 12%, transparent) !important;
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
    border: 1px solid color-mix(in srgb, var(--qw-profile-text, #fff) 18%, transparent) !important;
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
    background: color-mix(in srgb, var(--qw-profile-text, #fff) 9%, transparent) !important;
    border: none !important;
    color: var(--text-normal, #dbdee1) !important;
    font-size: 11px !important;
    padding: 3px 8px !important;
    border-radius: 4px !important;
    cursor: pointer !important;
}
.qw-set-reset:hover {
    background: color-mix(in srgb, var(--qw-profile-text, #fff) 16%, transparent) !important;
    color: var(--text-normal, #ffffff) !important;
}
.qw-slider {
    width: 100% !important;
    accent-color: color-mix(in srgb, var(--qw-profile-text, #5865f2) 60%, var(--qw-profile-primary, #5865f2)) !important;
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
    background-color: color-mix(in srgb, var(--qw-profile-text, #4e5058) 24%, var(--qw-profile-primary, #4e5058)) !important;
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
    background-color: var(--qw-profile-text, white) !important;
    transition: .2s !important;
    border-radius: 50% !important;
}
.qw-switch input:checked + .qw-switch-slider {
    background-color: color-mix(in srgb, var(--qw-profile-text, #23a55a) 60%, var(--qw-profile-primary, #23a55a)) !important;
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

function isUsableCssColor(value) {
    if (typeof value !== "string" || !value.trim() || value === "transparent" || value === "rgba(0, 0, 0, 0)") return false;
    return typeof window.CSS?.supports !== "function" || window.CSS.supports("color", value);
}

function getRoleDisplayColor(role) {
    const color = role?.colorString || role?.colorStrings?.primaryColor;
    return isUsableCssColor(color) ? color.trim() : "";
}

function getConversationRoleColor(guildId, userId, outer) {
    if (!userId) return "";
    let member = null;
    if (guildId) {
        const GuildMemberStore = getStore("GuildMemberStore", "getMember", "getMembers", "getNick");
        const GuildRoleStore = getStore("GuildRoleStore", "getSortedRoles", "getRole");
        member = GuildMemberStore?.getMember?.(guildId, userId);
        if (member) {
            const memberRoleIds = new Set((member.roles || []).map(String));
            const roles = (GuildRoleStore?.getSortedRoles?.(guildId) || []).filter(role => memberRoleIds.has(String(role.id)));
            const aptIndex = roles.findIndex(role => String(role.name || "").trim().toLowerCase() === "apt");
            const candidates = aptIndex >= 0 ? roles.slice(aptIndex + 1) : roles;
            for (const role of candidates) {
                const color = getRoleDisplayColor(role);
                if (color) return color;
            }
        }
    }

    const memberColor = member?.colorString || member?.colorStrings?.primaryColor;
    if (isUsableCssColor(memberColor)) return memberColor.trim();

    const nameElement = outer?.querySelector?.('[class*="nickname_"], [class^="nickname_"], [class*="username_"], [class^="username_"], [class*="userTag_"], [class^="userTag_"]');
    const displayedColor = nameElement ? getComputedStyle(nameElement).color : "";
    return isUsableCssColor(displayedColor) ? displayedColor.trim() : "";
}

function refreshAllConversationRoleColors() {
    for (const data of activeSessions.values()) data.session?.applyRoleBubbleColors?.();
}

function startConversationRoleColors() {
    const stores = new Set([
        getStore("GuildMemberStore", "getMember", "getMembers", "getNick"),
        getStore("GuildRoleStore", "getSortedRoles", "getRole")
    ].filter(Boolean));
    for (const store of stores) {
        if (typeof store.addChangeListener !== "function" || typeof store.removeChangeListener !== "function") continue;
        store.addChangeListener(refreshAllConversationRoleColors);
        conversationRoleStoreCleanups.push(() => store.removeChangeListener(refreshAllConversationRoleColors));
    }
    refreshAllConversationRoleColors();
}

function stopConversationRoleColors() {
    while (conversationRoleStoreCleanups.length) {
        try { conversationRoleStoreCleanups.pop()(); } catch (err) {}
    }
}

function cancelPendingProfileFocus() {
    profileFocusRequestId++;
    cancelAnimationFrame(profileFocusAnimation);
    clearTimeout(profileFocusTimer);
    profileFocusAnimation = 0;
    profileFocusTimer = 0;
}

function activateProfile(userId, focusComposer = false) {
    userId = String(userId || "");
    if (!userId) return;
    focusedProfileRequest = userId;
    bringToFront(userId);
    cancelPendingProfileFocus();
    if (!focusComposer) return;

    const requestId = profileFocusRequestId;
    const applyFocus = () => {
        if (!pluginRunning || requestId !== profileFocusRequestId || focusedProfileRequest !== userId) return;
        activeSessions.get(userId)?.session?.focusComposer();
    };
    applyFocus();
    profileFocusAnimation = requestAnimationFrame(() => {
        profileFocusAnimation = 0;
        applyFocus();
    });
    profileFocusTimer = setTimeout(() => {
        profileFocusTimer = 0;
        applyFocus();
    }, 80);
}

function handleProfileComposerFocus(event) {
    const input = event.target;
    if (!(input instanceof Element) || !input.matches(".qw-input")) return;

    const data = [...activeSessions.values()].find(candidate => candidate.session?.ui?.contains(input));
    if (!data) return;

    // Discord's native profile focus guard otherwise redirects focus to the
    // newest profile (often its send button). Claim this composer first, then
    // stop only this custom input's focus event before that guard can see it.
    activateProfile(data.userId, false);
    event.stopImmediatePropagation();
}

function isGlobalFileDrag(event) {
    return (event.dataTransfer?.files?.length || 0) > 0 || Array.from(event.dataTransfer?.types || []).includes("Files");
}

function getProfileDropTargetAtPoint(x, y) {
    for (let index = sessionStack.length - 1; index >= 0; index--) {
        const userId = String(sessionStack[index]);
        const data = activeSessions.get(userId);
        if (!data?.outer?.isConnected || !data.session?.ui?.isConnected) continue;
        const parts = getNativeProfileParts(data.outer);
        // Full-screen portal/dialog wrappers must not count as profile targets.
        const regions = [parts.surface, data.session.ui].filter(Boolean);
        const maxWidth = Math.min(window.innerWidth, getAttachedProfileWidth() + 160);
        const maxHeight = Math.min(window.innerHeight, getAttachedProfileHeight() + 160);
        if (regions.some(region => {
            const rect = region.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0
                && rect.width <= maxWidth && rect.height <= maxHeight
                && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        })) return data;
    }
    return null;
}

function setGlobalFileDropTarget(data) {
    const nextUserId = data?.userId ? String(data.userId) : null;
    if (globalFileDropTargetUserId === nextUserId) return;
    if (globalFileDropTargetUserId) activeSessions.get(globalFileDropTargetUserId)?.outer?.classList.remove("qw-file-drop-active");
    globalFileDropTargetUserId = nextUserId;
    if (data?.outer) data.outer.classList.add("qw-file-drop-active");
}

function handleGlobalProfileFileDrag(event) {
    if (!pluginRunning || !isGlobalFileDrag(event)) {
        if (event.type === "drop" || event.type === "dragleave") setGlobalFileDropTarget(null);
        return;
    }

    const data = getProfileDropTargetAtPoint(event.clientX, event.clientY)
        || (event.type === "drop" && globalFileDropTargetUserId ? activeSessions.get(globalFileDropTargetUserId) : null);
    if (!data) {
        setGlobalFileDropTarget(null);
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    try { event.dataTransfer.dropEffect = "copy"; } catch (err) {}
    setGlobalFileDropTarget(data);

    if (event.type !== "drop") return;
    const files = Array.from(event.dataTransfer?.files || []);
    setGlobalFileDropTarget(null);
    if (!files.length) return;
    bringToFront(data.userId);
    data.session.ui?._qwAttachmentApi?.addFiles(files, false);
}

function clearGlobalProfileFileDrag() {
    setGlobalFileDropTarget(null);
}

function startGlobalProfileFileDrop() {
    if (globalFileDropListening) return;
    globalFileDropListening = true;
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) window.addEventListener(type, handleGlobalProfileFileDrag, true);
    window.addEventListener("dragend", clearGlobalProfileFileDrag, true);
    window.addEventListener("blur", clearGlobalProfileFileDrag, true);
}

function stopGlobalProfileFileDrop() {
    if (!globalFileDropListening) return;
    globalFileDropListening = false;
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) window.removeEventListener(type, handleGlobalProfileFileDrag, true);
    window.removeEventListener("dragend", clearGlobalProfileFileDrag, true);
    window.removeEventListener("blur", clearGlobalProfileFileDrag, true);
    clearGlobalProfileFileDrag();
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
    method = String(method || "get").toLowerCase();
    const RestAPI = getStore("RestAPI", "get", "post", "put");
    if (RestAPI && typeof RestAPI[method] === "function") {
        if (method === "get") return await RestAPI.get({ url, query: data });
        const request = { url };
        if (data !== undefined) request.body = data;
        return await RestAPI[method](request);
    }
    const tokenFinder = getStore(null, "getToken");
    const token = tokenFinder?.getToken ? tokenFinder.getToken() : "";
    let fullUrl = `https://discord.com/api/v9${url}`;
    const opts = { method: method.toUpperCase(), headers: { "Authorization": token, "Content-Type": "application/json" } };
    if (method === "get" && data) fullUrl += "?" + new URLSearchParams(data).toString();
    else if (data) opts.body = JSON.stringify(data);
    const res = await fetch(fullUrl, opts);
    if (!res.ok) throw new Error(`Discord API ${method.toUpperCase()} ${url} failed (${res.status})`);
    const text = await res.text();
    return { body: text ? JSON.parse(text) : null, status: res.status };
}

function getAuthToken() {
    try {
        const auth = getStore("AuthenticationStore", "getToken") || window.Vencord?.Webpack?.findByProps?.("getToken");
        if (typeof auth?.getToken === "function") return auth.getToken();
    } catch (e) {}
    return "";
}

async function sendMultipartMessage(channelId, text, files, isVoice = false, durationSecs = 0) {
    try {
        files = (Array.isArray(files) ? files : [files]).filter(Boolean);
        if (!files.length) return null;
        if (isVoice) files = files.slice(0, 1);
        const nonce = (BigInt(Date.now() - 1420070400000) << 22n).toString();
        const payload = {
            content: text || "",
            tts: false,
            nonce: nonce,
            attachments: files.map((file, index) => ({
                id: index,
                filename: file.name || (isVoice ? "voice-message.ogg" : `file-${index + 1}`)
            }))
        };

        if (isVoice) {
            payload.flags = 8192;
            const dummyWaveform = btoa(String.fromCharCode(...new Array(64).fill(128)));
            payload.attachments[0].duration_secs = Math.max(1, Math.round(durationSecs || 1));
            payload.attachments[0].waveform = dummyWaveform;
        }

        const formData = new FormData();
        formData.append("payload_json", JSON.stringify(payload));
        files.forEach((file, index) => formData.append(`files[${index}]`, file, payload.attachments[index].filename));

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
let activeSettingsOwner = null;
let activeSettingsFlush = null;
let activeSettingsDragging = false;
let activeSettingsDragPosition = null;

function closeFloatingSettings() {
    if (activeSettingsModal) {
        const flush = activeSettingsFlush;
        activeSettingsFlush = null;
        activeSettingsDragging = false;
        activeSettingsDragPosition = null;
        flush?.();
        window.removeEventListener("pointerdown", handleGlobalSettingsCapture, true);
        window.removeEventListener("mousedown", handleGlobalSettingsCapture, true);
        activeSettingsModal.remove();
        activeSettingsModal = null;
        activeSettingsOwner = null;
    }
}

function handleGlobalSettingsCapture(e) {
    if (!activeSettingsModal) return;
    if (activeSettingsModal.contains(e.target) || e.target.closest?.("#qw-floating-settings, .qw-floating-gear-btn")) {
        return;
    }
    closeFloatingSettings();
}

function syncSettingsTheme(owner, modal) {
    const parts = getNativeProfileParts(owner);
    syncChatTheme(parts.frame, modal);
    const style = getComputedStyle(parts.surface);
    const variables = {
        "--qw-settings-radius": style.borderTopLeftRadius,
        "--qw-settings-border": parseFloat(style.borderTopWidth) > 0 && style.borderTopColor !== "rgba(0, 0, 0, 0)"
            ? style.borderTopColor : "color-mix(in srgb, var(--qw-profile-text) 16%, transparent)"
    };
    for (const [name, value] of Object.entries(variables)) {
        if (modal.style.getPropertyValue(name) !== value) modal.style.setProperty(name, value);
    }
}

function positionFloatingSettings(modal, popout) {
    if (!modal || !popout) return;
    // Keep the range under the pointer while its value resizes the profile.
    if (modal === activeSettingsModal && activeSettingsDragging) {
        if (activeSettingsDragPosition) positionOwnedOverlay(modal, activeSettingsDragPosition.left, activeSettingsDragPosition.top);
        return;
    }
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

    positionOwnedOverlay(modal, Math.round(left), Math.round(top));
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
                    <input type="color" class="qw-color-native" id="qw-my-color-picker" value="${cfg.myColor && /^#[0-9a-f]{6}$/i.test(cfg.myColor) ? cfg.myColor : '#613f45'}" title="Color Picker" />
                    <button class="qw-set-reset" id="qw-my-color-reset" title="Reset to default">Default</button>
                </div>
            </div>
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Their Bubble Color:</span>
                <div class="qw-color-ctrl">
                    <input type="color" class="qw-color-native" id="qw-their-color-picker" value="${cfg.theirColor && /^#[0-9a-f]{6}$/i.test(cfg.theirColor) ? cfg.theirColor : '#99578d'}" title="Color Picker" />
                    <button class="qw-set-reset" id="qw-their-color-reset" title="Reset to default">Default</button>
                </div>
            </div>
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Profile Width:</span>
                <span class="qw-set-val" id="qw-width-val">${cfg.profileWidth}px</span>
            </div>
            <input type="range" class="qw-slider" id="qw-width-slider" min="180" max="750" step="5" value="${cfg.profileWidth}" />
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Chat Width:</span>
                <span class="qw-set-val" id="qw-chat-width-val">${cfg.chatWidth}px</span>
            </div>
            <input type="range" class="qw-slider" id="qw-chat-width-slider" min="240" max="620" step="10" value="${cfg.chatWidth}" />
        </div>
        <div class="qw-set-item">
            <div class="qw-set-row-inline">
                <span class="qw-set-label">Profile & Chat Height:</span>
                <span class="qw-set-val" id="qw-height-val">${cfg.profileHeight}px</span>
            </div>
            <input type="range" class="qw-slider" id="qw-height-slider" min="320" max="900" step="10" value="${cfg.profileHeight}" />
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
    `;

    const owner = getPopoutOuter(popout) || popout;
    // A fixed panel can sit beside the card while remaining inside its native
    // event boundary. Its controls then count as clicks inside the profile.
    getNativeChatHost(getNativeProfileParts(owner)).appendChild(modal);
    activeSettingsModal = modal;
    activeSettingsOwner = owner;
    syncSettingsTheme(owner, modal);
    positionFloatingSettings(modal, popout);

    const myColor = modal.querySelector("#qw-my-color-picker");
    const myReset = modal.querySelector("#qw-my-color-reset");
    const theirColor = modal.querySelector("#qw-their-color-picker");
    const theirReset = modal.querySelector("#qw-their-color-reset");
    const widthSlider = modal.querySelector("#qw-width-slider");
    const widthVal = modal.querySelector("#qw-width-val");
    const chatWidthSlider = modal.querySelector("#qw-chat-width-slider");
    const chatWidthVal = modal.querySelector("#qw-chat-width-val");
    const heightSlider = modal.querySelector("#qw-height-slider");
    const heightVal = modal.querySelector("#qw-height-val");
    const fontSlider = modal.querySelector("#qw-font-slider");
    const fontVal = modal.querySelector("#qw-font-val");
    const headersToggle = modal.querySelector("#qw-headers-toggle");

    let settingsFrame = 0;
    let persistTimer = 0;
    let visualDirty = false;
    let persistPending = false;

    function applySettingChanges() {
        settingsFrame = 0;
        if (!visualDirty) return;
        visualDirty = false;
        if (!pluginRunning || !modal.isConnected) return;
        updateCustomStyles();
        positionFloatingSettings(modal, owner);
    }

    function commitSettings() {
        cancelAnimationFrame(settingsFrame);
        settingsFrame = 0;
        applySettingChanges();
        clearTimeout(persistTimer);
        persistTimer = 0;
        if (persistPending) {
            persistPending = false;
            persistStoredConfig();
        }
    }

    function finishSliderDrag() {
        if (!activeSettingsDragging) return;
        activeSettingsDragging = false;
        activeSettingsDragPosition = null;
        commitSettings();
        positionFloatingSettings(modal, owner);
    }

    function updateSetting(key, val) {
        // Input is immediate in memory; expensive layout is limited to one
        // paint and reactive/disk writes wait until the gesture is complete.
        saveStoredConfig({ [key]: val }, false);
        visualDirty = true;
        persistPending = true;
        if (!settingsFrame) settingsFrame = requestAnimationFrame(applySettingChanges);
        clearTimeout(persistTimer);
        if (!activeSettingsDragging) persistTimer = setTimeout(commitSettings, 180);
    }

    modal.addEventListener("pointerdown", event => {
        if (event.target.matches?.('input[type="range"]')) {
            activeSettingsDragging = true;
            const rect = modal.getBoundingClientRect();
            activeSettingsDragPosition = { left: rect.left, top: rect.top };
            clearTimeout(persistTimer);
        }
    });
    modal.addEventListener("change", commitSettings);
    window.addEventListener("pointerup", finishSliderDrag, true);
    window.addEventListener("pointercancel", finishSliderDrag, true);
    window.addEventListener("blur", finishSliderDrag);
    activeSettingsFlush = () => {
        commitSettings();
        window.removeEventListener("pointerup", finishSliderDrag, true);
        window.removeEventListener("pointercancel", finishSliderDrag, true);
        window.removeEventListener("blur", finishSliderDrag);
    };

    myColor.addEventListener("input", e => updateSetting("myColor", e.target.value));
    myReset.addEventListener("click", () => {
        myColor.value = "#613f45";
        updateSetting("myColor", "");
    });

    theirColor.addEventListener("input", e => updateSetting("theirColor", e.target.value));
    theirReset.addEventListener("click", () => {
        theirColor.value = "#99578d";
        updateSetting("theirColor", "");
    });

    widthSlider.addEventListener("input", e => {
        const v = parseInt(e.target.value, 10);
        widthVal.textContent = `${v}px`;
        updateSetting("profileWidth", v);
    });

    chatWidthSlider.addEventListener("input", e => {
        const v = parseInt(e.target.value, 10);
        chatWidthVal.textContent = `${v}px`;
        updateSetting("chatWidth", v);
    });

    heightSlider.addEventListener("input", e => {
        const v = parseInt(e.target.value, 10);
        heightVal.textContent = `${v}px`;
        updateSetting("profileHeight", v);
    });

    fontSlider.addEventListener("input", e => {
        const v = parseInt(e.target.value, 10);
        fontVal.textContent = `${v}px`;
        updateSetting("fontSize", v);
    });

    headersToggle.addEventListener("change", e => updateSetting("showHeaders", e.target.checked));

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
    const controls = activeSessions.get(getUserId(getNativeProfileFrame(target)))?.session.ui?.querySelector(".qw-header-controls") || target.querySelector(".qw-header-controls");
    if (!controls) return;
    const existingGear = target.querySelector(".qw-floating-gear-btn") || controls.querySelector(".qw-floating-gear-btn");
    if (existingGear) {
        if (existingGear.parentElement !== controls) controls.appendChild(existingGear);
        return;
    }
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
    controls.appendChild(gearBtn);
}

function attachTopCloseBtn(outer, userId) {
    if (!outer) return;
    const controls = activeSessions.get(String(userId))?.session.ui?.querySelector(".qw-header-controls") || outer.querySelector(".qw-header-controls");
    const existing = outer.querySelector(".qw-top-close-btn") || controls?.querySelector(".qw-top-close-btn");
    if (existing) {
        if (controls && existing.parentElement !== controls) {
            existing.style.cssText = "";
            controls.appendChild(existing);
        }
        return;
    }
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
    // Keep native profile actions in place; the pair closes from its right edge.
    (controls || outer).appendChild(closeBtn);
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
        if (event.button !== 0) return;
        if (event.target.closest('[data-qw-draggable="true"]') !== handle) return;
        const interactive = event.target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [aria-haspopup], [contenteditable="true"]');
        const avatarTarget = handle.matches('[class*="avatar"]') && interactive?.matches('[role="button"]:not(button):not(a)') && (interactive.contains(handle) || handle.contains(interactive));
        if (interactive && !avatarTarget && (interactive !== handle || handle.matches('button, a, input, textarea, select, [contenteditable="true"]'))) return;
        if (activeDragCleanup) activeDragCleanup();
        const startRect = outer.getBoundingClientRect();
        const startX = event.clientX, startY = event.clientY;
        const pointerId = event.pointerId;
        const activeData = [...activeSessions.values()].find(data => data.outer === outer);
        const chat = activeData?.session;
        if (activeData?.userId) bringToFront(activeData.userId);
        const focusedComposer = (outer.contains(document.activeElement) || chat?.ui?.contains(document.activeElement)) && document.activeElement?.matches('.qw-input, [contenteditable="true"]') ? document.activeElement : null;
        const selection = focusedComposer && typeof focusedComposer.selectionStart === "number" ? {
            start: focusedComposer.selectionStart, end: focusedComposer.selectionEnd, direction: focusedComposer.selectionDirection
        } : null;
        let moved = false;
        let cleaned = false;
        let moveFrame = 0, pendingMove = null;
        const previousSelection = document.body.style.userSelect;
        // Header dragging should keep the current composer focused, including
        // its draft and caret. Inputs and native buttons were excluded above.
        event.preventDefault();
        event.stopPropagation();
        isCurrentlyDragging = true;
        setNativeStyle(outer, handle, "cursor", "grabbing");
        document.body.style.userSelect = "none";
        if (pointerId !== undefined) { try { handle.setPointerCapture(pointerId); } catch (e) {} }

        function flushMove() {
            moveFrame = 0;
            if (cleaned || !pendingMove || !outer.isConnected) return;
            const { x, y } = pendingMove;
            pendingMove = null;
            const left = Math.max(10, Math.min(window.innerWidth - startRect.width - 10, startRect.left + x - startX));
            const top = Math.max(10, Math.min(window.innerHeight - startRect.height - 10, startRect.top + y - startY));
            setPopoutScreenPosition(outer, left, top);
            chat?.layout?.refresh(false);
        }

        function onMove(moveEvent) {
            if (cleaned) return;
            if (pointerId !== undefined && moveEvent.pointerId !== pointerId) return;
            if (moveEvent.buttons === 0) { endDrag(); return; }
            if (moveEvent.clientX !== startX || moveEvent.clientY !== startY) moved = true;
            moveEvent.preventDefault();
            moveEvent.stopPropagation();
            pendingMove = { x: moveEvent.clientX, y: moveEvent.clientY };
            if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
        }

        function endDrag(upEvent) {
            if (cleaned) return;
            if (upEvent?.pointerId !== undefined && pointerId !== undefined && upEvent.pointerId !== pointerId) return;
            if (moveFrame) cancelAnimationFrame(moveFrame);
            flushMove();
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
            if (moveFrame) cancelAnimationFrame(moveFrame);
            pendingMove = null;
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
    const session = [...activeSessions.values()].find(data => data.outer === root)?.session;
    makeDraggable(root, session?.ui?.querySelector(".qw-header"));

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
    const showHeader = !isSameAuthor || timeDiff > 180000 || !isSameMessageDay(msg, prevMsg);

    const row = document.createElement("div");
    row.className = `qw-msg-row ${isMe ? "qw-msg-me" : "qw-msg-them"} ${showHeader ? "qw-msg-has-header" : "qw-msg-grouped"}`;
    row.dataset.messageId = msg.id;

    let headerHtml = "";
    if (showHeader) {
        const avatarUrl = getAvatarUrl(msg.author);
        const nativeAuthor = getStore("UserStore", "getCurrentUser")?.getUser?.(msg.author?.id);
        const authorName = escapeHtml(msg.author?.global_name || msg.author?.globalName || nativeAuthor?.globalName || msg.author?.username || (isMe ? "You" : "User"));
        headerHtml = `
            <div class="qw-msg-header">
                <img src="${avatarUrl}" class="qw-author-avatar" loading="lazy" alt="${authorName}" title="${authorName}" />
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
                    openLightbox(att.url, getChatProfileOwner(img));
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

function isSameMessageDay(message, previous) {
    return previous && new Date(message.timestamp).toDateString() === new Date(previous.timestamp).toDateString();
}

function createMessageDateDivider(message) {
    const date = new Date(message.timestamp);
    if (!Number.isFinite(date.getTime())) return null;
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const divider = document.createElement("div");
    divider.className = "qw-date-divider";
    divider.textContent = date.toDateString() === today.toDateString() ? "Today"
        : date.toDateString() === yesterday.toDateString() ? "Yesterday"
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return divider;
}

function buildUI(username, onSend, onLoadOlder, userId = "") {
    const root = document.createElement("div");
    if (userId) root.id = `quick-whisper-root-${userId}`;
    root.className = "qw-root qw-chat-sidecar";
    root.dataset.userId = userId;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", `Private chat with ${username}`);

    root.innerHTML = `
        <div class="qw-chat-glass" aria-hidden="true"></div>
        <div class="qw-header">
            <div class="qw-header-spacer" aria-hidden="true"></div>
            <div class="qw-header-controls">
                <button class="qw-header-action" data-qw-native-action="call" aria-label="Call" title="Call" hidden><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.6 21 3 13.4 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.57 3.6a1 1 0 0 1-.24 1L6.6 10.8Z"/></svg></button>
                <button class="qw-header-action" data-qw-native-action="video" aria-label="Video call" title="Video call" hidden><svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3l6 4V6l-6 4V7a2 2 0 0 0-2-2H4Z"/></svg></button>
                <button class="qw-header-action" data-qw-native-action="more" aria-label="More options" title="More options" hidden><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
            </div>
        </div>
        <div class="qw-scroller" id="qw-scroller">
            <div class="qw-loading-banner" id="qw-loading-banner" style="display: none;">Loading older...</div>
            <div class="qw-messages-container" id="qw-messages-container"></div>
        </div>
        <div class="qw-composer">
            <div class="qw-attachment-preview" id="qw-attachment-preview" style="display: none;">
                <div class="qw-attachment-list" id="qw-attachment-list"></div>
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
                <input type="file" multiple id="qw-file-input" style="display: none;" />
                <button class="qw-composer-action-btn qw-upload-btn" id="qw-upload-btn" title="Upload Files">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path>
                    </svg>
                </button>
                <textarea class="qw-input" id="qw-input" aria-label="Message @${escapeHtml(username)}" placeholder="Message @${escapeHtml(username)}" rows="1"></textarea>
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
    for (const button of root.querySelectorAll("[data-qw-native-action]")) {
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const outer = getChatProfileOwner(button);
            if (outer) findNativeChatAction(outer, button.dataset.qwNativeAction)?.click();
        });
    }
    const sendBtn = root.querySelector("#qw-send-btn");
    const scroller = root.querySelector("#qw-scroller");

    const fileInput = root.querySelector("#qw-file-input");
    const uploadBtn = root.querySelector("#qw-upload-btn");
    const micBtn = root.querySelector("#qw-mic-btn");

    const attPreview = root.querySelector("#qw-attachment-preview");
    const attList = root.querySelector("#qw-attachment-list");

    const voiceBar = root.querySelector("#qw-voice-bar");
    const voiceTimer = root.querySelector("#qw-voice-timer");
    const voiceCancelBtn = root.querySelector("#qw-voice-cancel-btn");
    const voiceSendBtn = root.querySelector("#qw-voice-send-btn");
    const inputRow = root.querySelector("#qw-input-row");

    let attachmentSequence = 0;
    const pendingAttachments = [];

    function formatAttachmentSize(size) {
        if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
        if (size >= 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
        return `${size || 0} B`;
    }

    function renderPendingAttachments() {
        attList.replaceChildren();
        for (const attachment of pendingAttachments) {
            const item = document.createElement("div");
            item.className = "qw-att-item";
            item.dataset.attachmentId = String(attachment.id);

            if (attachment.objectUrl) {
                const thumb = document.createElement("img");
                thumb.className = "qw-att-thumb";
                thumb.src = attachment.objectUrl;
                thumb.alt = "attachment preview";
                item.appendChild(thumb);
            } else {
                const icon = document.createElement("span");
                icon.className = "qw-att-file-icon";
                icon.textContent = "📄";
                item.appendChild(icon);
            }

            const info = document.createElement("span");
            info.className = "qw-att-info";
            const name = document.createElement("span");
            name.className = "qw-att-name";
            name.textContent = attachment.file.name || "File";
            const size = document.createElement("span");
            size.className = "qw-att-size";
            size.textContent = formatAttachmentSize(attachment.file.size);
            info.append(name, size);
            item.appendChild(info);

            const remove = document.createElement("button");
            remove.className = "qw-att-remove-btn";
            remove.type = "button";
            remove.title = "Remove file";
            remove.setAttribute("aria-label", `Remove ${attachment.file.name || "file"}`);
            remove.textContent = "✕";
            remove.addEventListener("pointerdown", event => event.preventDefault());
            remove.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                removePendingAttachment(attachment.id);
                input.focus({ preventScroll: true });
            });
            item.appendChild(remove);
            attList.appendChild(item);
        }
        attPreview.style.display = pendingAttachments.length ? "block" : "none";
    }

    function addPendingAttachments(files, focusInput = true) {
        for (const file of Array.from(files || [])) {
            if (!file || typeof file.size !== "number") continue;
            const isImage = String(file.type || "").startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name || "");
            pendingAttachments.push({
                id: ++attachmentSequence,
                file,
                objectUrl: isImage ? URL.createObjectURL(file) : null
            });
        }
        renderPendingAttachments();
        if (focusInput) input.focus({ preventScroll: true });
    }

    function removePendingAttachment(id) {
        const index = pendingAttachments.findIndex(attachment => attachment.id === id);
        if (index === -1) return;
        const [attachment] = pendingAttachments.splice(index, 1);
        if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
        renderPendingAttachments();
    }

    function clearAttachments() {
        for (const attachment of pendingAttachments) {
            if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
        }
        pendingAttachments.length = 0;
        renderPendingAttachments();
    }

    root._qwAttachmentApi = { addFiles: addPendingAttachments, cleanup: clearAttachments };

    uploadBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.click();
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files?.length) {
            addPendingAttachments(fileInput.files);
            fileInput.value = "";
        }
    });

    function handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files = [];
        for (const item of items) {
            if (item.type && item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (!files.length) return;
        e.preventDefault();
        addPendingAttachments(files);
    }

    root.addEventListener("paste", handlePaste);

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
        const files = pendingAttachments.map(attachment => attachment.file);
        input.focus({ preventScroll: true });
        if (!text && !files.length) return;

        clearAttachments();
        input.value = "";
        input.style.height = "auto";
        onSend(text, files, false, 0);
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

    sendBtn.addEventListener("pointerdown", event => {
        event.preventDefault();
        input.focus({ preventScroll: true });
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
    constructor(nativeFooter, userId, channelId, username, guildId) {
        this.nativeFooter = nativeFooter;
        this.userId = userId;
        this.channelId = channelId;
        this.username = username;
        this.guildId = guildId || null;
        this.messages = [];
        this.messageMap = new Map();
        this.isLoadingOlder = false;
        this.hasMoreOlder = true;
        this.destroyed = false;
        this.followLatest = true;

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
        this.applyRoleBubbleColors();

        if (!this.nativeFooter) return;
        const outer = getPopoutOuter(this.nativeFooter);
        if (!outer || !this.nativeFooter.parentNode) return;
        this.nativeFooterDisplay = [this.nativeFooter.style.getPropertyValue("display"), this.nativeFooter.style.getPropertyPriority("display")];
        this.nativeFooter.style.setProperty("display", "none", "important");
        this.nativeFooter.classList.add("qw-native-hidden");
        this.layout = attachChatLayout(outer, this.ui);

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
        this.scroller.addEventListener("wheel", event => {
            if (event.deltaY < 0) this.followLatest = false;
        }, { passive: true });
        this.scroller.addEventListener("touchstart", () => { this.followLatest = false; }, { passive: true });
        this.scroller.addEventListener("pointerdown", event => {
            if (event.target === this.scroller) this.followLatest = false;
        });
        this.scroller.addEventListener("scroll", () => {
            if (this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 40) this.followLatest = true;
        });
        this.container.addEventListener("load", () => {
            if (this.followLatest) this.jumpToLatest();
        }, true);
        this.messageResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
            if (this.followLatest) this.jumpToLatest();
        }) : null;
        this.messageResizeObserver?.observe(this.container);
        this.messageResizeObserver?.observe(this.scroller);

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
                const followLatest = this.followLatest;
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

    focusComposer() {
        if (this.destroyed || focusedProfileRequest !== String(this.userId)) return;
        const input = this.ui?.querySelector("#qw-input");
        if (input?.isConnected) input.focus({ preventScroll: true });
    }

    applyRoleBubbleColors() {
        if (this.destroyed || !this.ui) return;
        const cfg = getEffectiveConfig();
        const outer = getPopoutOuter(this.nativeFooter);
        const theirColor = getConversationRoleColor(this.guildId, this.userId, outer) || cfg.theirColor || "#99578d";
        const myColor = getConversationRoleColor(this.guildId, this.currentUserId, null) || cfg.myColor || "#613f45";
        this.ui.style.setProperty("--qw-their-bubble-color", theirColor);
        this.ui.style.setProperty("--qw-their-bubble-text", getContrastColor(theirColor) || "#ffffff");
        this.ui.style.setProperty("--qw-my-bubble-color", myColor);
        this.ui.style.setProperty("--qw-my-bubble-text", getContrastColor(myColor) || "#ffffff");
    }

    jumpToLatest() {
        if (this.destroyed || !this.scroller?.isConnected) return;
        const style = this.scroller.style;
        const previous = [style.getPropertyValue("scroll-behavior"), style.getPropertyPriority("scroll-behavior")];
        // Open immediately at the latest message, including late-loading media.
        style.setProperty("scroll-behavior", "auto", "important");
        this.scroller.scrollTop = this.scroller.scrollHeight;
        if (previous[0]) style.setProperty("scroll-behavior", previous[0], previous[1]);
        else style.removeProperty("scroll-behavior");
    }

    scrollToLatest() {
        this.followLatest = true;
        this.jumpToLatest();
        cancelAnimationFrame(this.scrollAnimation);
        this.scrollAnimation = requestAnimationFrame(() => this.jumpToLatest());
    }

    renderAll(scrollToBottom = false) {
        if (this.destroyed || !this.container) return;
        this.container.innerHTML = "";

        let prev = null;
        for (const msg of this.messages) {
            if (!isSameMessageDay(msg, prev)) {
                const divider = createMessageDateDivider(msg);
                if (divider) this.container.appendChild(divider);
            }
            const el = createMessageElement(msg, this.currentUserId, prev);
            this.container.appendChild(el);
            prev = msg;
        }

        if (scrollToBottom && this.scroller) {
            this.scrollToLatest();
        }
    }

    addMessage(msg) {
        if (this.destroyed || this.messageMap.has(msg.id)) return;
        const followLatest = this.followLatest || (this.scroller && this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 40);
        this.messageMap.set(msg.id, msg);

        const prev = this.messages[this.messages.length - 1] || null;
        this.messages.push(msg);

        if (this.container) {
            if (!isSameMessageDay(msg, prev)) {
                const divider = createMessageDateDivider(msg);
                if (divider) this.container.appendChild(divider);
            }
            const el = createMessageElement(msg, this.currentUserId, prev);
            this.container.appendChild(el);
            if (followLatest) {
                this.scrollToLatest();
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

    async sendMessage(content, files = null, isVoice = false, duration = 0) {
        try {
            files = (Array.isArray(files) ? files : [files]).filter(Boolean);
            let res;
            if (files.length) {
                res = await sendMultipartMessage(this.channelId, content, files, isVoice, duration);
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
        if (String(msg.author?.id) === String(this.userId)) {
            acknowledgeDirectMessageForUser(this.userId, this.channelId);
        }
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
        this.ui?._qwAttachmentApi?.cleanup?.();
        cancelAnimationFrame(this.scrollAnimation);
        this.messageResizeObserver?.disconnect();
        this.layout?.destroy();
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

function getDirectMessageRecipientId(channel) {
    if (!channel || Number(channel.type) !== 1 || channel.guild_id) return null;
    if (typeof channel.getRecipientId === "function") {
        const recipientId = channel.getRecipientId();
        if (recipientId) return String(recipientId);
    }
    const recipient = channel.recipients?.[0] ?? channel.rawRecipients?.[0] ?? channel.recipientId;
    const recipientId = recipient?.id ?? recipient;
    return recipientId ? String(recipientId) : null;
}

function getCurrentVoiceChannelId() {
    const SelectedChannelStore = getStore("SelectedChannelStore", "getVoiceChannelId");
    const selectedVoiceChannelId = SelectedChannelStore?.getVoiceChannelId?.();
    if (selectedVoiceChannelId) return String(selectedVoiceChannelId);

    const currentUser = getStore("UserStore", "getCurrentUser")?.getCurrentUser?.();
    const voiceState = currentUser && getStore("VoiceStateStore", "getVoiceStateForUser")?.getVoiceStateForUser?.(currentUser.id);
    return voiceState?.channelId ? String(voiceState.channelId) : null;
}

function getVoiceUserRows() {
    const rows = new Set();
    for (const element of document.querySelectorAll('[class*="voiceUser"]')) {
        const isUserRow = [...element.classList].some(name => /voiceUser/i.test(name) && !/voiceUsers/i.test(name));
        if (isUserRow) rows.add(element);
    }
    return [...rows];
}

function getVoiceUnreadStatusPlacement(row) {
    const nameElement = row.querySelector('[class*="username_"], [class^="username_"], [class*="name_"], [class^="name_"]');
    const rowRect = row.getBoundingClientRect();
    let bestContainer = null;
    let bestScore = -Infinity;
    const candidates = row.querySelectorAll('[class*="icons_"], [class^="icons_"], [class*="iconGroup_"], [class^="iconGroup_"], [class*="status_"], [class^="status_"], [class*="actions_"], [class^="actions_"]');

    for (const candidate of candidates) {
        if (candidate.classList.contains("qw-voice-unread-status-slot") || candidate.closest(".qw-root")) continue;
        if (nameElement && (candidate === nameElement || candidate.contains(nameElement))) continue;
        const className = [...candidate.classList].join(" ");
        const rect = candidate.getBoundingClientRect();
        let score = 0;
        if (/icons?/i.test(className)) score += 8;
        if (/voice/i.test(className)) score += 3;
        if (/status|actions?/i.test(className)) score += 2;
        if (candidate.querySelector('svg, [class*="live"], [aria-label*="mute" i], [aria-label*="deaf" i]')) score += 5;
        if (rect.width > 0 && rect.width < Math.max(140, rowRect.width * 0.5)) score += 2;
        if (rowRect.width > 0 && rect.right >= rowRect.left + rowRect.width * 0.55) score += 3;
        if (candidate.querySelector("img")) score -= 6;
        if (score > bestScore) {
            bestScore = score;
            bestContainer = candidate;
        }
    }

    const content = row.querySelector('[class*="content_"], [class^="content_"]') || row.firstElementChild || row;
    if (!bestContainer || bestScore < 5) {
        const statusSignal = row.querySelector('[class*="live"], [aria-label*="mute" i], [aria-label*="deaf" i]');
        if (statusSignal && content.contains(statusSignal)) {
            let statusBranch = statusSignal;
            while (statusBranch.parentElement && statusBranch.parentElement !== content) statusBranch = statusBranch.parentElement;
            if (statusBranch.parentElement === content) return { container: content, beforeNode: statusBranch };
        }

        bestContainer = row.querySelector(":scope .qw-voice-unread-status-slot");
        if (!bestContainer) {
            bestContainer = document.createElement("span");
            bestContainer.className = "qw-voice-unread-status-slot";
            content.appendChild(bestContainer);
        }
    }

    const beforeNode = [...bestContainer.children].find(child => !child.classList.contains("qw-voice-unread-dot")) || null;
    return { container: bestContainer, beforeNode };
}

function getVoiceUnreadUserColor(row, userId, voiceChannelId) {
    const isUsableColor = value => {
        if (typeof value !== "string" || !value.trim() || value === "transparent" || value === "rgba(0, 0, 0, 0)") return false;
        return typeof window.CSS?.supports !== "function" || window.CSS.supports("color", value);
    };

    const ChannelStore = getStore("ChannelStore", "getChannel");
    const GuildMemberStore = getStore("GuildMemberStore", "getMember", "getMembers", "getNick");
    const voiceChannel = ChannelStore?.getChannel?.(voiceChannelId);
    const guildId = voiceChannel?.guild_id || voiceChannel?.guildId;
    const member = guildId && GuildMemberStore?.getMember?.(guildId, userId);
    const roleColor = member?.colorString || member?.colorStrings?.primaryColor;
    if (isUsableColor(roleColor)) return roleColor.trim();

    const nameElement = row.querySelector('[class*="username_"], [class^="username_"], [class*="name_"], [class^="name_"]');
    const displayedColor = nameElement ? getComputedStyle(nameElement).color : "";
    return isUsableColor(displayedColor) ? displayedColor.trim() : "#f23f43";
}

function clearVoiceUnreadDom() {
    document.querySelectorAll(".qw-voice-unread-dot").forEach(dot => dot.remove());
    document.querySelectorAll(".qw-voice-unread-status-slot").forEach(slot => slot.remove());
    document.querySelectorAll('[data-qw-voice-unread-hidden="true"]').forEach(element => element.removeAttribute("data-qw-voice-unread-hidden"));
    document.querySelectorAll('[data-qw-voice-unread-empty="true"]').forEach(element => element.removeAttribute("data-qw-voice-unread-empty"));
}

function syncVoiceUnreadDots(activeUnreads, currentVoiceChannelId) {
    for (const dot of document.querySelectorAll(".qw-voice-unread-dot")) {
        const userId = dot.dataset.qwUserId;
        const row = dot.closest('[class*="voiceUser"]');
        if (!userId || !activeUnreads.has(userId) || !row || String(getUserId(row)) !== userId) dot.remove();
    }

    const VoiceStateStore = getStore("VoiceStateStore", "getVoiceStateForUser");
    for (const row of getVoiceUserRows()) {
        const userId = getUserId(row);
        if (!userId || !activeUnreads.has(String(userId))) continue;
        const voiceState = VoiceStateStore?.getVoiceStateForUser?.(userId);
        if (String(voiceState?.channelId || "") !== String(currentVoiceChannelId || "")) continue;

        const existingDots = [...row.querySelectorAll(".qw-voice-unread-dot")];
        const dot = existingDots.shift() || document.createElement("span");
        existingDots.forEach(duplicate => duplicate.remove());
        dot.className = "qw-voice-unread-dot";
        if (dot.dataset.qwUserId !== String(userId)) dot.dataset.qwUserId = String(userId);
        dot.setAttribute("aria-hidden", "true");
        dot.title = "Unread direct message";
        const userColor = getVoiceUnreadUserColor(row, userId, currentVoiceChannelId);
        if (dot.style.getPropertyValue("--qw-voice-unread-color") !== userColor) dot.style.setProperty("--qw-voice-unread-color", userColor);

        const { container, beforeNode } = getVoiceUnreadStatusPlacement(row);
        if (dot.parentElement !== container || dot.nextElementSibling !== beforeNode) container.insertBefore(dot, beforeNode);
        for (const slot of row.querySelectorAll(".qw-voice-unread-status-slot")) {
            if (slot !== container && !slot.children.length) slot.remove();
        }
    }

    document.querySelectorAll(".qw-voice-unread-status-slot:empty").forEach(slot => slot.remove());
}

function clearPendingVoiceUnreadAck(channelId, queue = false) {
    channelId = String(channelId || "");
    const pending = pendingVoiceUnreadAcks.get(channelId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingVoiceUnreadAcks.delete(channelId);
    if (queue) queueVoiceUnreadSync();
}

function beginPendingVoiceUnreadAck(userId, channelId, messageId) {
    channelId = String(channelId);
    clearPendingVoiceUnreadAck(channelId);
    const pending = {
        userId: String(userId),
        channelId,
        messageId: String(messageId),
        timer: setTimeout(() => clearPendingVoiceUnreadAck(channelId, true), VOICE_UNREAD_ACK_GRACE_MS)
    };
    pendingVoiceUnreadAcks.set(channelId, pending);
}

function syncUnreadDMList(activeUnreads) {
    const container = document.getElementById("guild-list-unread-dms");
    const desiredHidden = new Set();
    const channelItems = [];
    const ChannelStore = getStore("ChannelStore", "getChannel");

    if (container && ChannelStore?.getChannel) {
        for (const navElement of container.querySelectorAll('[data-list-item-id^="guildsnav___"]')) {
            const rawId = navElement.getAttribute("data-list-item-id");
            if (!rawId || rawId === "guildsnav___home") continue;
            const channelId = rawId.replace("guildsnav___", "");
            const userId = getDirectMessageRecipientId(ChannelStore.getChannel(channelId));
            const item = navElement.closest('[class*="listItem"]') || navElement.parentElement || navElement;
            channelItems.push(item);
            const isActiveVoiceUnread = userId && activeUnreads.get(userId)?.channelId === String(channelId);
            if (isActiveVoiceUnread || pendingVoiceUnreadAcks.has(String(channelId))) desiredHidden.add(item);
        }
    }

    for (const element of document.querySelectorAll('[data-qw-voice-unread-hidden="true"]')) {
        if (!desiredHidden.has(element)) element.removeAttribute("data-qw-voice-unread-hidden");
    }
    for (const element of desiredHidden) {
        if (element.getAttribute("data-qw-voice-unread-hidden") !== "true") element.setAttribute("data-qw-voice-unread-hidden", "true");
    }

    if (container) {
        const allHidden = channelItems.length > 0 && channelItems.every(item => desiredHidden.has(item));
        if (allHidden && container.getAttribute("data-qw-voice-unread-empty") !== "true") container.setAttribute("data-qw-voice-unread-empty", "true");
        else if (!allHidden && container.hasAttribute("data-qw-voice-unread-empty")) container.removeAttribute("data-qw-voice-unread-empty");
    }
}

function syncVoiceUnreadNotifications() {
    if (!pluginRunning) return;
    const ChannelStore = getStore("ChannelStore", "getDMFromUserId", "getChannel");
    const ReadStateStore = getStore("ReadStateStore", "hasUnread", "lastMessageId");
    const VoiceStateStore = getStore("VoiceStateStore", "getVoiceStateForUser");
    const currentUser = getStore("UserStore", "getCurrentUser")?.getCurrentUser?.();
    const currentVoiceChannelId = getCurrentVoiceChannelId();
    const activeUnreads = new Map();

    if (ChannelStore && ReadStateStore && VoiceStateStore && currentUser) {
        let userIds = [];
        if (typeof ChannelStore.getDMUserIds === "function") userIds = ChannelStore.getDMUserIds() || [];
        else if (typeof ChannelStore.getMutableDMsByUserIds === "function") userIds = Object.keys(ChannelStore.getMutableDMsByUserIds() || {});

        for (const rawUserId of userIds) {
            const userId = String(rawUserId);
            if (userId === String(currentUser.id)) continue;
            const channelId = ChannelStore.getDMFromUserId?.(userId);
            const channel = channelId && ChannelStore.getChannel?.(channelId);
            if (!channelId || !getDirectMessageRecipientId(channel)) continue;
            const messageId = ReadStateStore.lastMessageId?.(channelId) || channel.lastMessageId || channel.last_message_id || null;
            const pendingAck = pendingVoiceUnreadAcks.get(String(channelId));
            if (pendingAck && messageId && String(messageId) !== pendingAck.messageId) clearPendingVoiceUnreadAck(channelId);
            if (!ReadStateStore.hasUnread?.(channelId)) continue;
            if (pendingVoiceUnreadAcks.has(String(channelId))) continue;
            const voiceState = VoiceStateStore.getVoiceStateForUser?.(userId);
            if (!currentVoiceChannelId || String(voiceState?.channelId || "") !== currentVoiceChannelId) continue;
            activeUnreads.set(userId, {
                channelId: String(channelId),
                messageId
            });
        }
    }

    routedVoiceUnreads.clear();
    for (const [userId, unread] of activeUnreads) routedVoiceUnreads.set(userId, unread);
    syncVoiceUnreadDots(activeUnreads, currentVoiceChannelId);
    syncUnreadDMList(activeUnreads);
}

function queueVoiceUnreadSync() {
    if (!pluginRunning || voiceUnreadSyncFrame) return;
    voiceUnreadSyncFrame = requestAnimationFrame(() => {
        voiceUnreadSyncFrame = 0;
        try { syncVoiceUnreadNotifications(); }
        catch (err) { console.error("[MBDM] Voice unread sync failed:", err); }
    });
}

function startVoiceUnreadNotifications() {
    const stores = new Set([
        getStore("ChannelStore", "getDMFromUserId", "getChannel"),
        getStore("ReadStateStore", "hasUnread", "lastMessageId"),
        getStore("VoiceStateStore", "getVoiceStateForUser"),
        getStore("GuildMemberStore", "getMember", "getMembers", "getNick"),
        getStore("SelectedChannelStore", "getVoiceChannelId")
    ].filter(Boolean));

    for (const store of stores) {
        if (typeof store.addChangeListener !== "function" || typeof store.removeChangeListener !== "function") continue;
        store.addChangeListener(queueVoiceUnreadSync);
        voiceUnreadStoreCleanups.push(() => store.removeChangeListener(queueVoiceUnreadSync));
    }
    queueVoiceUnreadSync();
}

function stopVoiceUnreadNotifications() {
    cancelAnimationFrame(voiceUnreadSyncFrame);
    voiceUnreadSyncFrame = 0;
    while (voiceUnreadStoreCleanups.length) {
        try { voiceUnreadStoreCleanups.pop()(); } catch (err) {}
    }
    for (const channelId of [...pendingVoiceUnreadAcks.keys()]) clearPendingVoiceUnreadAck(channelId);
    routedVoiceUnreads.clear();
    clearVoiceUnreadDom();
}

function acknowledgeDirectMessageForUser(userId, preferredChannelId = null) {
    userId = String(userId || "");
    if (!userId) return false;

    const ChannelStore = getStore("ChannelStore", "getDMFromUserId", "getChannel");
    const ReadStateStore = getStore("ReadStateStore", "hasUnread", "lastMessageId");
    const unread = routedVoiceUnreads.get(userId);
    const directChannelId = ChannelStore?.getDMFromUserId?.(userId);
    let channelId = String(preferredChannelId || unread?.channelId || directChannelId || "");
    let channel = channelId && ChannelStore?.getChannel?.(channelId);

    if (!channelId || (channel && getDirectMessageRecipientId(channel) !== userId)) {
        channelId = String(directChannelId || "");
        channel = channelId && ChannelStore?.getChannel?.(channelId);
    }
    if (!channelId || (channel && getDirectMessageRecipientId(channel) !== userId)) return false;

    const messageId = ReadStateStore?.lastMessageId?.(channelId)
        || channel?.lastMessageId
        || channel?.last_message_id
        || (unread?.channelId === channelId ? unread.messageId : null);
    const FluxDispatcher = getStore("FluxDispatcher", "dispatch", "subscribe");
    if (!messageId || !FluxDispatcher?.dispatch) return false;

    beginPendingVoiceUnreadAck(userId, channelId, messageId);
    try {
        FluxDispatcher.dispatch({
            type: "BULK_ACK",
            context: "APP",
            channels: [{ channelId, messageId, readStateType: 0 }]
        });
    } catch (err) {
        clearPendingVoiceUnreadAck(channelId, true);
        console.error("[MBDM] Failed to acknowledge unread DM:", err);
        return false;
    }
    routedVoiceUnreads.delete(userId);
    document.querySelectorAll(`.qw-voice-unread-dot[data-qw-user-id="${userId}"]`).forEach(dot => dot.remove());
    queueVoiceUnreadSync();
    return true;
}

function acknowledgeVoiceUnreadForUser(userId) {
    userId = String(userId || "");
    const unread = routedVoiceUnreads.get(userId);
    return unread ? acknowledgeDirectMessageForUser(userId, unread.channelId) : false;
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
    acknowledgeDirectMessageForUser(userId, channelId);
    if (openNativeProfile(userId, { channelId, guildId: null, anchor: target })) return;
    // Bootstrap from Discord's own profile when its lazy native renderer has
    // not been seen yet. This never navigates the conversation into the DM.
    const actions = getStore("UserProfileActions", "openUserProfileModal", "closeUserProfileModal");
    actions?.openUserProfileModal?.({ userId, channelId, analyticsLocation: { page: "DM Channel", section: "Profile Popout" } });
}

function handleTriggerToggle(event) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!target?.closest || target.closest('[role="dialog"], [id^="popout_"], .qw-chat-sidecar, [role="menu"], #qw-lightbox, #qw-floating-settings')) return;
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
    acknowledgeVoiceUnreadForUser(userId);
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
            nativeProfileDescriptor ||= makeReusableNativeDescriptor(descriptor);
            const nativeClose = getNativePopoutClose(outer);
            const captureOptions = { anchor: outer, nativeCapture: true, profileChannelId: descriptor.props.channelId };
            if (Object.prototype.hasOwnProperty.call(descriptor.props, "guildId")) captureOptions.guildId = descriptor.props.guildId;
            if (openNativeProfile(userId, captureOptions, descriptor)) {
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
        const attributes = new Map(["data-qw-managed", "data-qw-position-layer", "data-qw-chat-side"].map(name => [name, outer.getAttribute(name)]));
        outer.dataset.qwManaged = "true";
        outer.dataset.qwPositionLayer = "true";
        positionProfilePopout(outer, sessionStack.length);
        acknowledgeDirectMessageForUser(userId, channelId);
        const shouldActivateWhenReady = !focusedProfileRequest || focusedProfileRequest === String(userId);
        const session = new WhisperSession(nativeFooter, userId, channelId, username, owned.context?.guildId);
        const onPointerActivate = event => {
            // Switch ownership before the browser resolves focus so a pending
            // request from another profile cannot pull the caret away.
            activateProfile(userId, false);
            const input = event.target?.closest?.(".qw-input");
            if (input && session.ui?.contains(input) && document.activeElement !== input) {
                input.focus({ preventScroll: true });
            }
        };
        const onFocusActivate = () => activateProfile(userId, false);
        activeSessions.set(userId, { userId, outer, session, attributes, nativeClose: getNativePopoutClose(outer), onPointerActivate, onFocusActivate });
        sessionStack.push(userId);
        outer.addEventListener("pointerdown", onPointerActivate, true);
        outer.addEventListener("focusin", onFocusActivate, true);
        attachDraggables(outer);
        attachFloatingGear(outer);
        attachTopCloseBtn(outer, userId);
        if (shouldActivateWhenReady) activateProfile(userId, true);
        else bringToFront(userId);
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
        if (!data.outer.isConnected || !data.session.ui?.isConnected || !data.session.nativeFooter?.isConnected) {
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
    queueVoiceUnreadSync();
}

const plugin = _definePlugin({
    name: "MBDM",
    description: "Mini DM client in user profiles",
    authors: [{ name: "MBdr", id: 0n }],
    startAt: (typeof StartAt !== "undefined" && StartAt?.WebpackReady) ? StartAt.WebpackReady : "WebpackReady",
    enabledByDefault: true,

    start() {
        pluginRunning = true;
        window.addEventListener("focusin", handleProfileComposerFocus, true);
        if (getStoredConfig().nativeSplitLayoutVersion !== 1) {
            saveStoredConfig({ nativeSplitLayoutVersion: 1, ...DEFAULT_CONFIG });
        }
        injectStyles();
        enforcePopoutWidth();
        startVoiceUnreadNotifications();
        startConversationRoleColors();
        startGlobalProfileFileDrop();
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
        window.removeEventListener("focusin", handleProfileComposerFocus, true);
        stopVoiceUnreadNotifications();
        stopConversationRoleColors();
        stopGlobalProfileFileDrop();
        cancelPendingProfileFocus();
        focusedProfileRequest = null;
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

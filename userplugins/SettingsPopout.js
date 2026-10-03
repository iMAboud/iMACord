import { definePlugin } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/options";

const settings = definePluginSettings({
    defaultWidth: {
        type: OptionType.NUMBER,
        description: "Default floating window width (px)",
        default: 980
    },
    defaultHeight: {
        type: OptionType.NUMBER,
        description: "Default floating window height (px)",
        default: 720
    },
    rememberGeometry: {
        type: OptionType.BOOLEAN,
        description: "Remember last position and size",
        default: true
    },
    dimBackground: {
        type: OptionType.BOOLEAN,
        description: "Dim Discord behind the floating settings window",
        default: false
    },
    showCustomTitlebar: {
        type: OptionType.BOOLEAN,
        description: "Show enhanced window titlebar with controls",
        default: true
    },
    savedX: {
        type: OptionType.NUMBER,
        description: "Saved X position",
        default: -1
    },
    savedY: {
        type: OptionType.NUMBER,
        description: "Saved Y position",
        default: -1
    },
    savedW: {
        type: OptionType.NUMBER,
        description: "Saved width",
        default: 980
    },
    savedH: {
        type: OptionType.NUMBER,
        description: "Saved height",
        default: 720
    }
});

let observer = null;
let currentModal = null;
let dockPill = null;
let styleElement = null;
let dragOverlay = null;

// Tracked geometry to prevent layout thrashing
let currentX = -1;
let currentY = -1;
let currentWidth = 980;
let currentHeight = 720;

const STYLE_ID = "vc-settings-popout-styles";

const CSS_CONTENT = `
/* Allow clicks through to Discord background when settings is floating */
.vc-settings-floating-active [class*="scrim_"] {
    opacity: 0 !important;
    pointer-events: none !important;
    background: transparent !important;
    transition: opacity 0.15s ease !important;
}

.vc-settings-floating-active.vc-dim-bg [class*="scrim_"] {
    opacity: 0.45 !important;
    pointer-events: none !important;
    background: rgba(0, 0, 0, 0.6) !important;
}

.vc-settings-floating-active[class*="layerContainer_"],
.vc-settings-floating-active [class*="layerContainer_"],
[class*="layerContainer_"]:has(.vc-settings-window) {
    pointer-events: none !important;
}

.vc-settings-floating-active[class*="layer_"],
.vc-settings-floating-active [class*="layer_"],
[class*="layer_"]:has(.vc-settings-window) {
    pointer-events: none !important;
}

.vc-settings-passthrough {
    pointer-events: none !important;
    background: transparent !important;
}

/* Floating settings window container - GPU hardware layer */
.vc-settings-window {
    pointer-events: auto !important;
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    margin: 0 !important;
    z-index: 1001 !important;
    display: flex !important;
    flex-direction: column !important;
    background: var(--background-floating, #1e1f22) !important;
    border-radius: 12px !important;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.8), 0 0 0 1px var(--border-subtle, rgba(255, 255, 255, 0.12)) !important;
    overflow: hidden !important;
    min-width: 580px !important;
    min-height: 400px !important;
    box-sizing: border-box !important;
    will-change: transform !important;
}

/* Zero transition / ultra-smooth hardware compositing during drag/resize */
.vc-settings-window.vc-dragging,
.vc-settings-window.vc-resizing {
    user-select: none !important;
    transition: none !important;
}

.vc-settings-window.vc-dragging {
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.95), 0 0 0 1px var(--brand-500, #5865f2) !important;
}

/* Fullscreen drag overlay prevents style invalidation storms on child elements */
.vc-drag-glass-overlay {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    z-index: 999999 !important;
    user-select: none !important;
    pointer-events: auto !important;
    background: transparent !important;
}

/* Stretch inner Discord modal components */
.vc-settings-window [class*="modal_"],
.vc-settings-window [class*="outerContainer_"],
.vc-settings-window [class*="modalContent_"],
.vc-settings-window [class*="modalContentInner_"],
.vc-settings-window [class*="container_abd9a8"] {
    width: 100% !important;
    height: 100% !important;
    max-width: 100% !important;
    max-height: 100% !important;
    flex: 1 1 auto !important;
}

/* Titlebar */
.vc-settings-titlebar {
    height: 38px;
    min-height: 38px;
    background: var(--background-secondary, #2b2d31);
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    user-select: none;
    cursor: grab;
    z-index: 10;
}

.vc-settings-titlebar:active {
    cursor: grabbing;
}

.vc-st-left {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 13px;
    color: var(--header-primary, #ffffff);
    pointer-events: none;
}

.vc-st-left svg {
    color: var(--brand-500, #5865f2);
}

.vc-st-drag-center {
    flex: 1;
    height: 100%;
    cursor: grab;
}

.vc-st-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: default;
}

.vc-st-btn {
    background: transparent;
    border: none;
    outline: none;
    color: var(--interactive-normal, #b5bac1);
    border-radius: 6px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease, transform 0.08s ease;
}

.vc-st-btn:hover {
    background: var(--background-modifier-hover, rgba(255, 255, 255, 0.08));
    color: var(--interactive-hover, #ffffff);
}

.vc-st-btn:active {
    transform: scale(0.92);
}

.vc-st-btn.close:hover {
    background: var(--button-danger-background, #da373c);
    color: #ffffff;
}

/* Breadcrumb / Content Header also draggable */
.vc-settings-window [class*="contentHeader_"] {
    cursor: grab;
}

/* Resize Handles */
.vc-resize-handle {
    position: absolute;
    z-index: 99;
}

.vc-resize-handle.r-se {
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    padding: 3px;
}

.vc-resize-handle.r-se::after {
    content: "";
    width: 9px;
    height: 9px;
    border-right: 2px solid var(--interactive-muted, rgba(255, 255, 255, 0.35));
    border-bottom: 2px solid var(--interactive-muted, rgba(255, 255, 255, 0.35));
}

.vc-resize-handle.r-e {
    right: 0;
    top: 38px;
    bottom: 18px;
    width: 8px;
    cursor: ew-resize;
}

.vc-resize-handle.r-s {
    bottom: 0;
    left: 18px;
    right: 18px;
    height: 8px;
    cursor: ns-resize;
}

.vc-resize-handle.r-w {
    left: 0;
    top: 38px;
    bottom: 18px;
    width: 8px;
    cursor: ew-resize;
}

.vc-resize-handle.r-n {
    top: 0;
    left: 18px;
    right: 18px;
    height: 6px;
    cursor: ns-resize;
}

.vc-resize-handle.r-sw {
    left: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nesw-resize;
}

.vc-resize-handle.r-ne {
    right: 0;
    top: 0;
    width: 18px;
    height: 18px;
    cursor: nesw-resize;
}

.vc-resize-handle.r-nw {
    left: 0;
    top: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
}

/* Floating Dock Pill (when minimized) */
.vc-settings-dock-pill {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 10000;
    background: var(--background-secondary, #2b2d31);
    border: 1px solid var(--brand-500, #5865f2);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    border-radius: 24px;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    color: var(--header-primary, #ffffff);
    transition: transform 0.18s cubic-bezier(0.18, 0.89, 0.32, 1.28), box-shadow 0.18s ease;
}

.vc-settings-dock-pill:hover {
    transform: translateY(-2px) scale(1.04);
    box-shadow: 0 12px 32px rgba(88, 101, 242, 0.45);
}

.vc-settings-dock-pill svg {
    color: var(--brand-500, #5865f2);
}
`;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    styleElement = document.createElement("style");
    styleElement.id = STYLE_ID;
    styleElement.textContent = CSS_CONTENT;
    document.head.appendChild(styleElement);
}

function removeStyles() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
}

function findSettingsModal(root = document) {
    const sidebar = root.querySelector('[data-list-id="settings-sidebar"]')
        || root.querySelector('[class*="sidebar_"] [data-settings-sidebar-item]');
    if (!sidebar) return null;

    const modal = sidebar.closest('[data-mana-component="layer-modal"]')
        || sidebar.closest('[class*="outerContainer_"]')
        || sidebar.closest('[class*="modal_"]')
        || sidebar.closest('[role="dialog"]');

    return modal;
}

function getSettingsLayerContainer(modal) {
    return modal.closest('[class*="layerContainer_"]') || modal.closest('[class*="layer_"]')?.parentElement;
}

function setupFloatingWindow(modal) {
    if (!modal || modal.classList.contains("vc-settings-window")) return;

    const layerContainer = getSettingsLayerContainer(modal);
    if (layerContainer) {
        layerContainer.classList.add("vc-settings-floating-active");
        if (settings.store.dimBackground) {
            layerContainer.classList.add("vc-dim-bg");
        }
    }

    // Set passthrough on ancestor wrappers
    let p = modal.parentElement;
    while (p && p !== layerContainer && p !== document.body) {
        p.classList.add("vc-settings-passthrough");
        p = p.parentElement;
    }

    const dialog = modal.closest('[role="dialog"]') || modal;
    dialog.setAttribute("aria-modal", "false");

    modal.classList.add("vc-settings-window");
    currentModal = modal;

    applyWindowGeometry(modal);

    if (settings.store.showCustomTitlebar) {
        attachTitlebar(modal);
    }

    attachResizeHandles(modal);
    attachHeaderDrag(modal);
}

function applyWindowGeometry(modal) {
    const { rememberGeometry, savedX, savedY, savedW, savedH, defaultWidth, defaultHeight } = settings.store;

    let width = defaultWidth;
    let height = defaultHeight;
    let x = -1;
    let y = -1;

    if (rememberGeometry && savedW > 300 && savedH > 200) {
        width = savedW;
        height = savedH;
        x = savedX;
        y = savedY;
    }

    const maxW = window.innerWidth - 20;
    const maxH = window.innerHeight - 20;
    width = Math.min(width, maxW);
    height = Math.min(height, maxH);

    if (x < 0 || y < 0 || x > window.innerWidth - 100 || y > window.innerHeight - 100) {
        x = Math.max(10, Math.floor((window.innerWidth - width) / 2));
        y = Math.max(10, Math.floor((window.innerHeight - height) / 2));
    }

    currentX = x;
    currentY = y;
    currentWidth = width;
    currentHeight = height;

    modal.style.position = "fixed";
    modal.style.left = "0px";
    modal.style.top = "0px";
    modal.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    modal.style.width = `${currentWidth}px`;
    modal.style.height = `${currentHeight}px`;
    modal.style.margin = "0";
}

function saveWindowGeometry() {
    if (!settings.store.rememberGeometry) return;
    settings.store.savedX = Math.round(currentX);
    settings.store.savedY = Math.round(currentY);
    settings.store.savedW = Math.round(currentWidth);
    settings.store.savedH = Math.round(currentHeight);
}

function createDragOverlay(cursorStyle = "grabbing") {
    if (dragOverlay) dragOverlay.remove();
    dragOverlay = document.createElement("div");
    dragOverlay.className = "vc-drag-glass-overlay";
    dragOverlay.style.cursor = cursorStyle;
    document.body.appendChild(dragOverlay);
    return dragOverlay;
}

function removeDragOverlay() {
    if (dragOverlay) {
        dragOverlay.remove();
        dragOverlay = null;
    }
}

function attachTitlebar(modal) {
    if (modal.querySelector(".vc-settings-titlebar")) return;

    const titlebar = document.createElement("div");
    titlebar.className = "vc-settings-titlebar";
    titlebar.innerHTML = `
        <div class="vc-st-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66Z"/>
            </svg>
            <span>Discord Settings</span>
        </div>
        <div class="vc-st-drag-center"></div>
        <div class="vc-st-actions">
            <button class="vc-st-btn center" title="Center Window">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="12" cy="12" r="3"></circle>
                </svg>
            </button>
            <button class="vc-st-btn minimize" title="Minimize to floating dock">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="11" width="16" height="2" rx="1"></rect>
                </svg>
            </button>
            <button class="vc-st-btn close" title="Close Settings (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        </div>
    `;

    modal.insertBefore(titlebar, modal.firstChild);

    const centerBtn = titlebar.querySelector(".vc-st-btn.center");
    centerBtn?.addEventListener("pointerdown", e => e.stopPropagation());
    centerBtn?.addEventListener("click", e => {
        e.stopPropagation();
        centerFloatingWindow(modal);
    });

    const minBtn = titlebar.querySelector(".vc-st-btn.minimize");
    minBtn?.addEventListener("pointerdown", e => e.stopPropagation());
    minBtn?.addEventListener("click", e => {
        e.stopPropagation();
        minimizeToDock(modal);
    });

    const closeBtn = titlebar.querySelector(".vc-st-btn.close");
    closeBtn?.addEventListener("pointerdown", e => e.stopPropagation());
    closeBtn?.addEventListener("click", e => {
        e.stopPropagation();
        closeSettingsModal(modal);
    });

    makeDraggable(titlebar, modal);
}

function centerFloatingWindow(modal) {
    currentX = Math.max(10, Math.floor((window.innerWidth - currentWidth) / 2));
    currentY = Math.max(10, Math.floor((window.innerHeight - currentHeight) / 2));
    modal.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    saveWindowGeometry();
}

function closeSettingsModal(modal) {
    const closeBtn = modal.querySelector('button[aria-label="Close"]')
        || modal.querySelector('[class*="contentHeader_"] button');
    if (closeBtn) {
        closeBtn.click();
    } else {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
}

function minimizeToDock(modal) {
    modal.style.display = "none";

    if (dockPill) dockPill.remove();

    dockPill = document.createElement("div");
    dockPill.className = "vc-settings-dock-pill";
    dockPill.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66Z"/>
        </svg>
        <span>Discord Settings (Click to restore)</span>
    `;

    dockPill.addEventListener("click", () => {
        modal.style.display = "";
        dockPill?.remove();
        dockPill = null;
    });

    document.body.appendChild(dockPill);
}

function attachHeaderDrag(modal) {
    const contentHeader = modal.querySelector('[class*="contentHeader_"]');
    if (!contentHeader || contentHeader.dataset.vcDragAttached) return;
    contentHeader.dataset.vcDragAttached = "true";
    makeDraggable(contentHeader, modal);
}

// Ultra-smooth GPU hardware dragging: zero layout reflow, glass capture overlay
function makeDraggable(handleElement, modal) {
    let startPointerX = 0;
    let startPointerY = 0;
    let startX = 0;
    let startY = 0;
    let isDragging = false;
    let rafId = null;

    const onPointerMove = e => {
        if (!isDragging) return;
        const dx = e.clientX - startPointerX;
        const dy = e.clientY - startPointerY;

        const maxLeft = window.innerWidth - 80;
        const maxTop = window.innerHeight - 50;
        currentX = Math.max(-currentWidth + 100, Math.min(startX + dx, maxLeft));
        currentY = Math.max(0, Math.min(startY + dy, maxTop));

        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (!isDragging) return;
                modal.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
            });
        }
    };

    const onPointerUp = () => {
        if (!isDragging) return;
        isDragging = false;

        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        modal.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        modal.classList.remove("vc-dragging");
        removeDragOverlay();

        window.removeEventListener("pointermove", onPointerMove, { capture: true });
        window.removeEventListener("pointerup", onPointerUp, { capture: true });
        window.removeEventListener("pointercancel", onPointerUp, { capture: true });

        saveWindowGeometry();
    };

    handleElement.addEventListener("pointerdown", e => {
        if (e.target.closest("button") || e.target.closest("input") || e.target.closest("a") || e.target.closest('[role="button"]')) return;
        
        isDragging = true;
        startPointerX = e.clientX;
        startPointerY = e.clientY;
        startX = currentX;
        startY = currentY;

        createDragOverlay("grabbing");
        modal.classList.add("vc-dragging");

        window.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
        window.addEventListener("pointerup", onPointerUp, { capture: true });
        window.addEventListener("pointercancel", onPointerUp, { capture: true });
    });
}

function attachResizeHandles(modal) {
    if (modal.querySelector(".vc-resize-handle")) return;

    const directions = ["se", "e", "s", "w", "n", "sw", "ne", "nw"];
    directions.forEach(dir => {
        const handle = document.createElement("div");
        handle.className = `vc-resize-handle r-${dir}`;
        makeResizable(handle, modal, dir);
        modal.appendChild(handle);
    });
}

// Ultra-smooth GPU hardware resizing with glass overlay
function makeResizable(handle, modal, direction) {
    let startPointerX = 0;
    let startPointerY = 0;
    let startW = 0;
    let startH = 0;
    let startX = 0;
    let startY = 0;
    let isResizing = false;
    let rafId = null;

    const cursorMap = {
        se: "nwse-resize",
        nw: "nwse-resize",
        ne: "nesw-resize",
        sw: "nesw-resize",
        e: "ew-resize",
        w: "ew-resize",
        s: "ns-resize",
        n: "ns-resize"
    };

    const onPointerMove = e => {
        if (!isResizing) return;
        const dx = e.clientX - startPointerX;
        const dy = e.clientY - startPointerY;

        let newW = startW;
        let newH = startH;
        let newX = startX;
        let newY = startY;

        if (direction.includes("e")) {
            newW = Math.max(520, startW + dx);
        }
        if (direction.includes("s")) {
            newH = Math.max(380, startH + dy);
        }
        if (direction.includes("w")) {
            const potentialW = startW - dx;
            if (potentialW >= 520) {
                newW = potentialW;
                newX = startX + dx;
            }
        }
        if (direction.includes("n")) {
            const potentialH = startH - dy;
            if (potentialH >= 380) {
                newH = potentialH;
                newY = startY + dy;
            }
        }

        currentWidth = newW;
        currentHeight = newH;
        currentX = newX;
        currentY = newY;

        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (!isResizing) return;
                modal.style.width = `${currentWidth}px`;
                modal.style.height = `${currentHeight}px`;
                modal.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
            });
        }
    };

    const onPointerUp = () => {
        if (!isResizing) return;
        isResizing = false;

        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        modal.style.width = `${currentWidth}px`;
        modal.style.height = `${currentHeight}px`;
        modal.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        modal.classList.remove("vc-resizing");
        removeDragOverlay();

        window.removeEventListener("pointermove", onPointerMove, { capture: true });
        window.removeEventListener("pointerup", onPointerUp, { capture: true });
        window.removeEventListener("pointercancel", onPointerUp, { capture: true });

        saveWindowGeometry();
    };

    handle.addEventListener("pointerdown", e => {
        e.stopPropagation();
        e.preventDefault();
        isResizing = true;
        startPointerX = e.clientX;
        startPointerY = e.clientY;
        startW = currentWidth;
        startH = currentHeight;
        startX = currentX;
        startY = currentY;

        createDragOverlay(cursorMap[direction] || "default");
        modal.classList.add("vc-resizing");

        window.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
        window.addEventListener("pointerup", onPointerUp, { capture: true });
        window.addEventListener("pointercancel", onPointerUp, { capture: true });
    });
}

export default definePlugin({
    name: "SettingsPopout",
    description: "Makes the Discord settings modal draggable, resizable, and floating within Discord 🗗✨",
    authors: [{ name: "iMAboud" }],
    settings,

    start() {
        injectStyles();

        // Check if settings is already open
        const existing = findSettingsModal();
        if (existing) {
            setupFloatingWindow(existing);
        }

        // Observe DOM for settings opening/closing
        observer = new MutationObserver(() => {
            const modal = findSettingsModal();
            if (modal && modal !== currentModal) {
                setupFloatingWindow(modal);
            } else if (!modal && currentModal) {
                currentModal = null;
                if (dockPill) {
                    dockPill.remove();
                    dockPill = null;
                }
            }
        });

        const mount = document.getElementById("app-mount") || document.body;
        observer.observe(mount, {
            childList: true,
            subtree: true
        });
    },

    stop() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }

        if (dockPill) {
            dockPill.remove();
            dockPill = null;
        }

        removeDragOverlay();

        const modal = findSettingsModal() || currentModal;
        if (modal) {
            modal.classList.remove("vc-settings-window", "vc-dragging", "vc-resizing");
            modal.style.position = "";
            modal.style.left = "";
            modal.style.top = "";
            modal.style.transform = "";
            modal.style.width = "";
            modal.style.height = "";
            modal.style.margin = "";
            modal.querySelector(".vc-settings-titlebar")?.remove();
            modal.querySelectorAll(".vc-resize-handle").forEach(h => h.remove());

            const layerContainer = getSettingsLayerContainer(modal);
            layerContainer?.classList.remove("vc-settings-floating-active", "vc-dim-bg");
        }

        removeStyles();
        currentModal = null;
    }
});

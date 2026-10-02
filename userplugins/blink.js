import { definePlugin } from "@utils/types";

let observer = null;
let targetVideoElement = null;

function showToastNotification(text) {
    const existing = document.getElementById("stream-ss-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "stream-ss-toast";
    toast.style.cssText = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        background: #23a55a;
        color: #ffffff;
        font-family: sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 8px 16px;
        border-radius: 9999px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        z-index: 100000;
        pointer-events: none;
        transition: opacity 0.3s ease;
    `;
    toast.textContent = text;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

function captureFullResScreenshot(video) {
    if (!video) return;

    const width = video.videoWidth || video.clientWidth;
    const height = video.videoHeight || video.clientHeight;

    if (!width || !height) return;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);

    const base64Data = canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    const fileName = `Stream_Capture_${Date.now()}.png`;

    const fs = window.require?.("fs");
    const path = window.require?.("path");
    const os = window.require?.("os");

    if (fs && path && os) {
        const desktopPath = path.join(os.homedir(), "Desktop", fileName);
        fs.writeFile(desktopPath, base64Data, "base64", (err) => {
            if (!err) showToastNotification("=  Saved to Desktop!");
        });
    } else {
        const a = document.createElement("a");
        a.href = `data:image/png;base64,${base64Data}`;
        a.download = fileName;
        a.click();
        showToastNotification("=  Screenshot Downloaded!");
    }
}

function createMenuItem(onClick) {
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    group.className = "custom-stream-ss-group";

    const item = document.createElement("div");
    item.className = "item_c1e9c4 text-sm/medium_c1e9c4 labelContainer_c1e9c4 row_a4ac84 colorDefault_c1e9c4";
    item.setAttribute("role", "menuitem");
    item.setAttribute("tabindex", "-1");
    item.setAttribute("data-menu-item", "true");
    item.style.cursor = "pointer";

    item.innerHTML = `
        <div class="iconContainerLeft_c1e9c4 iconContainer_c1e9c4">
            <svg class="icon_c1e9c4" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 4h3l2-2h6l2 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>
            </svg>
        </div>
        <div class="label_c1e9c4">
            <div class="container_a4ac84">
                <span class="text-sm/medium_cf4812 text_a4ac84" data-text-variant="text-sm/medium">Screenshot</span>
            </div>
        </div>
    `;

    item.addEventListener("mouseenter", () => item.classList.add("focused_c1e9c4"));
    item.addEventListener("mouseleave", () => item.classList.remove("focused_c1e9c4"));

    item.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    group.appendChild(item);
    return group;
}

function processMenu() {
    const scrollers = document.querySelectorAll('div[role="menu"] div[class*="scroller_"]:not([data-ss-injected="true"])');

    for (const scroller of scrollers) {
        if (!targetVideoElement) continue;

        scroller.setAttribute("data-ss-injected", "true");

        const sep = document.createElement("div");
        sep.setAttribute("role", "separator");
        sep.className = "separator_c1e9c4";
        sep.style.cssText = "--custom-menu-separator-margin: 8px 0;";

        const capturedRef = targetVideoElement;
        const item = createMenuItem(() => captureFullResScreenshot(capturedRef));

        scroller.prepend(sep);
        scroller.prepend(item);
    }
}

export default definePlugin({
    name: "StreamScreenshot",
    description: "Instantly captures a full-res PNG screenshot of the right-clicked stream straight to Desktop.",
    authors: [{ name: "Custom" }],

    start() {
        this.onContextMenu = (e) => {
            const tile = e.target.closest('[class*="video_"], [class*="wrapper_"], [class*="tile_"]');
            const video = e.target.closest("video") || tile?.querySelector("video");

            if (video && video.readyState >= 2) {
                targetVideoElement = video;
            } else {
                targetVideoElement = null;
            }
        };

        window.addEventListener("contextmenu", this.onContextMenu, true);

        observer = new MutationObserver(processMenu);
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        if (this.onContextMenu) {
            window.removeEventListener("contextmenu", this.onContextMenu, true);
        }
        observer?.disconnect();
        observer = null;

        targetVideoElement = null;
        document.querySelectorAll("[data-ss-injected]").forEach(el => el.removeAttribute("data-ss-injected"));
        document.querySelectorAll(".custom-stream-ss-group").forEach(el => el.remove());
        document.getElementById("stream-ss-toast")?.remove();
    }
});
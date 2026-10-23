import definePlugin, { StartAt } from "@utils/types";

const activeSessions = new Map(), sessionStack = [], fetchedChannels = new Set(), resolvedDmChannels = new Map(), pendingQueue = new Map(), ackTimers = new Map(), sentTxtMap = new Map(), cleanups = [];
let pluginRunning = false, requestChain = Promise.resolve(), lastNetAt = 0, lastClickAt = 0, voiceSyncFrame = 0, activeSettings = null, activeLightbox = null, dropTargetId = null, muteSoundUntil = 0;
const STORAGE_KEY = "MBDM_persistent_config";
const DEFAULT_CFG = { myColorV2: "", theirColorV2: "", chatWidth: 420, chatHeight: 570, fontSize: 14, blur: 24, darkness: 88, showHeaders: false, lastPosition: null };
let currentConfig = null;

const _definePlugin = typeof definePlugin === "function" ? definePlugin : (window.Vencord?.Plugins?.definePlugin || (p => p));
const makeNonce = () => (BigInt(Date.now() - 1420070400000) << 22n).toString();
const escapeHtml = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COPY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function getStore(name, ...props) {
    const wp = window.Vencord?.Webpack;
    return wp?.Common?.[name] || wp?.findStore?.(name) || (props.length ? wp?.findByProps?.(...props) : null) || null;
}

function enqueueNet(key, fn) {
    if (key && pendingQueue.has(key)) return pendingQueue.get(key);
    const run = requestChain.then(async () => {
        if (!pluginRunning) return null;
        const wait = Math.max(0, 2000 + Math.floor(Math.random() * 400) - (Date.now() - lastNetAt));
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        if (!pluginRunning) return null;
        lastNetAt = Date.now();
        try { return await fn(); } finally { lastNetAt = Date.now(); }
    });
    requestChain = run.catch(() => {});
    if (key) { pendingQueue.set(key, run); run.finally(() => pendingQueue.get(key) === run && pendingQueue.delete(key)); }
    return run;
}

function getConfig() {
    if (!currentConfig) {
        try { currentConfig = Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); }
        catch { currentConfig = { ...DEFAULT_CFG }; }
    }
    return currentConfig;
}

function saveConfig(updates) {
    currentConfig = Object.assign({}, getConfig(), updates);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(currentConfig)); } catch {}
    updateCustomStyles();
}

function toHex(color, fallback = "#613f45") {
    if (!color || typeof color !== "string") return fallback;
    const c = color.trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    const m = c.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/i);
    if (m) return "#" + [m[1], m[2], m[3]].map(x => Math.min(255, Math.max(0, parseInt(x, 10))).toString(16).padStart(2, "0")).join("");
    return fallback;
}

function getContrast(color) {
    const hex = toHex(color, "#613f45").replace("#", "");
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    return ((r * 299 + g * 587 + b * 114) / 1000) >= 145 ? "#111214" : "#ffffff";
}

function isValidColor(c) {
    if (!c || typeof c !== "string") return false;
    const v = c.trim().toLowerCase();
    return v !== "" && v !== "transparent" && v !== "#000000" && v !== "rgb(0, 0, 0)" && v !== "rgba(0, 0, 0, 0)";
}

function getActiveGuildId(hintGuildId = null) {
    if (hintGuildId) return String(hintGuildId);
    const sgs = getStore("SelectedGuildStore");
    const scs = getStore("SelectedChannelStore");
    const cs = getStore("ChannelStore");
    return sgs?.getGuildId?.()
        || cs?.getChannel?.(scs?.getChannelId?.())?.guild_id
        || cs?.getChannel?.(scs?.getVoiceChannelId?.())?.guild_id
        || sgs?.getLastSelectedGuildId?.()
        || null;
}

function getMemberRoleColor(gms, grs, guildId, userId) {
    if (!guildId || !gms?.getMember) return "";
    const member = gms.getMember(String(guildId), String(userId));
    if (!member) return "";
    const direct = member.colorString || member.colorStrings?.primaryColor;
    if (isValidColor(direct)) return toHex(direct, "");
    if (Array.isArray(member.roles) && member.roles.length && grs) {
        const roleSet = new Set(member.roles.map(String));
        const roles = grs.getSortedRoles?.(String(guildId)) || Object.values(grs.getRolesSnapshot?.(String(guildId)) || {});
        for (const role of roles) {
            if (!roleSet.has(String(role?.id))) continue;
            const rc = role?.colorString || role?.colorStrings?.primaryColor || (typeof role?.color === "number" && role.color > 0 ? "#" + role.color.toString(16).padStart(6, "0") : "");
            if (isValidColor(rc)) return toHex(rc, "");
        }
    }
    return "";
}

function getRoleColor(guildId, userId, anchor = null) {
    if (!userId) return "";
    userId = String(userId);
    const gms = getStore("GuildMemberStore");
    const grs = getStore("GuildRoleStore");
    const gs = getStore("GuildStore");

    const activeGid = getActiveGuildId(guildId);
    const activeColor = getMemberRoleColor(gms, grs, activeGid, userId);
    if (activeColor) return activeColor;

    if (anchor?.closest) {
        const row = anchor.closest('[class*="member"], [class*="message"], [class*="voiceUser"], [data-list-item-id]');
        const nameEl = row?.querySelector?.('[class*="username"], [class*="name_"], [style*="color"]') || (anchor.style?.color ? anchor : null);
        if (nameEl) {
            const col = nameEl.style?.color || getComputedStyle(nameEl).color;
            const hex = toHex(col, "");
            if (isValidColor(hex) && !["#ffffff", "#f2f3f5", "#dbdee1", "#b5bac1", "#949ba4"].includes(hex.toLowerCase())) return hex;
        }
    }

    for (const g of Object.values(gs?.getGuilds?.() || {})) {
        if (String(g?.id) === String(activeGid)) continue;
        const c = getMemberRoleColor(gms, grs, g.id, userId);
        if (c) return c;
    }

    const ups = getStore("UserProfileStore");
    const profile = ups?.getUserProfile?.(userId);
    const themeNum = profile?.themeColors?.[0] ?? profile?.accentColor ?? profile?.accent_color;
    if (themeNum) {
        const hex = typeof themeNum === "number" ? "#" + themeNum.toString(16).padStart(6, "0") : toHex(String(themeNum), "");
        if (isValidColor(hex)) return hex;
    }

    const user = getStore("UserStore")?.getUser?.(userId);
    const acc = user?.accentColor ?? user?.accent_color;
    if (acc) {
        const hex = typeof acc === "number" ? "#" + acc.toString(16).padStart(6, "0") : toHex(String(acc), "");
        if (isValidColor(hex)) return hex;
    }
    return "";
}

function isAllowedImg(url) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return true;
    try {
        const h = new URL(url).hostname.toLowerCase();
        return ["cdn.discordapp.com", "media.discordapp.net", "i.imgur.com", "i.ibb.co", "i.pinimg.com", "files.catbox.moe", "raw.githubusercontent.com"].includes(h)
            || [".discordapp.net", ".discordapp.com", ".discord.com", ".tenor.com", ".tenor.co"].some(d => h.endsWith(d));
    } catch { return false; }
}

function openUrl(url) {
    if (!url) return;
    try { if (window.DiscordNative?.shell?.openExternal) return window.DiscordNative.shell.openExternal(url); } catch {}
    try { if (window.Vencord?.Util?.openExternal) return window.Vencord.Util.openExternal(url); } catch {}
    window.open(url, "_blank", "noopener,noreferrer");
}

function updateCustomStyles() {
    const cfg = getConfig();
    const myC = cfg.myColorV2 || "#613f45", theirC = cfg.theirColorV2 || "#99578d";
    let el = document.getElementById("qw-styles");
    if (!el) { el = document.createElement("style"); el.id = "qw-styles"; document.head.appendChild(el); }
    el.textContent = `
        :root, #qw-floating-settings {
            --qw-my-bg: ${myC}; --qw-their-bg: ${theirC};
            --qw-my-txt: ${getContrast(myC)}; --qw-their-txt: ${getContrast(theirC)};
            --qw-blur: ${cfg.blur}px; --qw-bg: rgba(20,21,26,${cfg.darkness / 100});
        }
        [data-qw-voice-unread-hidden="true"], #guild-list-unread-dms[data-qw-voice-unread-empty="true"] { display:none!important; }
        .qw-voice-unread-dot { width:8px; height:8px; margin-right:5px; border-radius:50%; background:var(--qw-dot,#f23f43); box-shadow:0 0 6px var(--qw-dot,#f23f43); display:inline-block; }
        .qw-root { position:fixed!important; display:flex!important; flex-direction:column!important; width:${cfg.chatWidth}px!important; height:${cfg.chatHeight}px!important; border-radius:16px!important; border:1px solid rgba(255,255,255,.14)!important; background:var(--qw-bg)!important; backdrop-filter:blur(var(--qw-blur)) saturate(1.2)!important; box-shadow:0 16px 48px rgba(0,0,0,.65)!important; color:#e4e4e7; font-family:var(--font-primary,sans-serif); overflow:hidden!important; z-index:100000; direction:ltr; }
        .qw-root.qw-drop .qw-composer { outline:2px solid #5865f2!important; }
        .qw-header { display:flex; align-items:center; justify-content:space-between; height:46px; padding:0 12px; border-bottom:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.03); cursor:grab; user-select:none; flex-shrink:0; }
        .qw-header-left { display:flex; align-items:center; gap:8px; min-width:0; flex:1; font-weight:650; font-size:14px; color:#fff; }
        .qw-avatar { width:28px; height:28px; border-radius:50%; object-fit:cover; flex-shrink:0; }
        .qw-btn { width:28px; height:28px; border-radius:8px; border:none; background:rgba(255,255,255,.08); color:#e4e4e7; cursor:pointer; display:inline-grid; place-items:center; }
        .qw-btn:hover { background:rgba(255,255,255,.18); color:#fff; }
        .qw-btn.close:hover { background:#ef4444; }
        .qw-scroller { flex:1; padding:8px 10px; overflow-y:auto; display:flex; flex-direction:column; gap:3px; scrollbar-width:none; user-select:text!important; }
        .qw-scroller::-webkit-scrollbar { display:none; }
        .qw-msg-row { display:flex; flex-direction:column; position:relative; margin:1px 0; }
        .qw-msg-header { display:${cfg.showHeaders ? "flex" : "none"}; position:absolute; left:0; top:2px; }
        .qw-msg-me .qw-msg-header { display:none; }
        .qw-msg-header img { width:32px; height:32px; border-radius:50%; object-fit:cover; }
        .qw-msg-wrap { display:flex; align-items:center; gap:5px; width:100%; box-sizing:border-box; }
        .qw-msg-me .qw-msg-wrap { flex-direction:row-reverse; justify-content:flex-start; }
        .qw-msg-them .qw-msg-wrap { justify-content:flex-start; padding-left:${cfg.showHeaders ? "40px" : "0"}; }
        .qw-msg-bubble { max-width:82%; padding:5px 9px; font-size:${cfg.fontSize}px!important; line-height:1.3; word-break:break-word; unicode-bidi:plaintext; text-align:start; }
        .qw-msg-me .qw-msg-bubble { background:var(--qw-my-bg)!important; color:var(--qw-my-txt)!important; border-radius:12px 12px 4px 12px; }
        .qw-msg-them .qw-msg-bubble { background:var(--qw-their-bg)!important; color:var(--qw-their-txt)!important; border-radius:12px 12px 12px 4px; }
        .qw-copy-btn, .qw-txt-copy { width:26px; height:26px; padding:0; border-radius:8px; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.08); backdrop-filter:blur(8px); color:inherit; cursor:pointer; display:inline-grid; place-items:center; flex-shrink:0; transition:all .15s ease; }
        .qw-copy-btn { opacity:0; color:#e4e4e7; background:rgba(255,255,255,.06); }
        .qw-msg-row:hover .qw-copy-btn { opacity:1; }
        .qw-copy-btn:hover, .qw-txt-copy:hover { background:rgba(255,255,255,.2); border-color:rgba(255,255,255,.32); transform:translateY(-1px); color:#fff; }
        .qw-copy-btn:active, .qw-txt-copy:active { transform:scale(.92); }
        .qw-file-row { display:flex; align-items:center; gap:5px; margin-top:3px; }
        .qw-file-card { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 9px; border-radius:8px; background:rgba(0,0,0,.22); border:1px solid rgba(255,255,255,.15); color:inherit!important; text-decoration:none!important; font-size:12px; font-weight:600; box-sizing:border-box; }
        .qw-file-card:hover { background:rgba(255,255,255,.14); }
        .qw-msg-time { font-size:9px; opacity:.65; margin-top:2px; }
        .qw-reply { font-size:11px; opacity:.8; border-bottom:1px solid rgba(255,255,255,.15); margin-bottom:3px; padding-bottom:2px; }
        .qw-msg-img { max-width:100%; max-height:140px; border-radius:6px; cursor:pointer; display:block; margin-top:3px; }
        .qw-msg-video { max-width:100%; max-height:200px; border-radius:6px; margin-top:3px; }
        .qw-audio { width:200px; height:30px; margin-top:3px; filter:invert(.9) hue-rotate(180deg); }
        .qw-link { color:#7dd3fc!important; text-decoration:underline; }
        .qw-composer { margin:0 10px 10px; border-radius:12px; background:rgba(0,0,0,.3); border:1px solid rgba(255,255,255,.1); padding:6px 8px; display:flex; flex-direction:column; gap:5px; }
        .qw-input-row { display:flex; align-items:center; gap:6px; }
        .qw-input { flex:1; background:transparent; border:none; outline:none; color:#dbdee1; font-size:13px; resize:none; max-height:80px; unicode-bidi:plaintext; }
        .qw-att-list { display:flex; gap:6px; flex-wrap:wrap; }
        .qw-att-chip { background:rgba(255,255,255,.08); padding:2px 6px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:4px; }
        #qw-floating-settings { position:fixed; width:280px; background:rgba(22,23,27,.96); backdrop-filter:blur(20px); border:1px solid rgba(255,255,255,.16); border-radius:14px; padding:12px 14px; z-index:100100; display:flex; flex-direction:column; gap:10px; color:#dbdee1; box-shadow:0 16px 48px rgba(0,0,0,.65); font-size:12px; }
        .qw-set-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        #qw-lightbox { position:fixed; inset:0; z-index:2000000; background:rgba(0,0,0,.85); backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; }
        #qw-lightbox img { max-width:92vw; max-height:90vh; border-radius:8px; transition:transform .1s; }
    `;
    for (const s of activeSessions.values()) s.applyColors?.();
}

function openLightbox(url) {
    if (!isAllowedImg(url)) return openUrl(url);
    activeLightbox?.remove();
    const box = document.createElement("div");
    box.id = "qw-lightbox";
    box.innerHTML = `<img src="${escapeHtml(url)}" draggable="false" />`;
    const img = box.querySelector("img");
    let scale = 1;
    img.addEventListener("wheel", e => {
        e.preventDefault();
        scale = Math.min(5, Math.max(0.5, scale + (e.deltaY < 0 ? 0.15 : -0.15)));
        img.style.transform = `scale(${scale})`;
    }, { passive: false });
    img.addEventListener("auxclick", e => e.button === 1 && openUrl(url));
    box.addEventListener("click", e => e.target === box && box.remove());
    document.body.appendChild(box);
    activeLightbox = box;
}

function toggleSettings(anchor, session) {
    if (activeSettings) { activeSettings.remove(); activeSettings = null; return; }
    const cfg = getConfig(), rect = anchor.getBoundingClientRect();
    const autoMy = getRoleColor(session?.guildId, session?.myId) || "#613f45";
    const autoTheir = getRoleColor(session?.guildId, session?.userId, session?.anchor) || "#99578d";
    const modal = document.createElement("div");
    modal.id = "qw-floating-settings";
    modal.style.left = `${Math.max(10, Math.min(window.innerWidth - 295, rect.right + 10))}px`;
    modal.style.top = `${Math.max(10, Math.min(window.innerHeight - 360, rect.top))}px`;
    modal.innerHTML = `
        <div class="qw-set-row"><b>MBDM Settings</b><button class="qw-btn close" id="qw-s-close">✕</button></div>
        <div class="qw-set-row"><span>My Color</span><input type="color" id="qw-s-myc" value="${toHex(cfg.myColorV2 || autoMy, "#613f45")}"><button class="qw-btn" id="qw-s-myr" title="Auto Role Color">↺</button></div>
        <div class="qw-set-row"><span>Their Color</span><input type="color" id="qw-s-thc" value="${toHex(cfg.theirColorV2 || autoTheir, "#99578d")}"><button class="qw-btn" id="qw-s-thr" title="Auto Role Color">↺</button></div>
        <div class="qw-set-row"><span>Width (${cfg.chatWidth})</span><input type="range" id="qw-s-w" min="260" max="800" step="10" value="${cfg.chatWidth}"></div>
        <div class="qw-set-row"><span>Height (${cfg.chatHeight})</span><input type="range" id="qw-s-h" min="320" max="900" step="10" value="${cfg.chatHeight}"></div>
        <div class="qw-set-row"><span>Font (${cfg.fontSize}px)</span><input type="range" id="qw-s-f" min="11" max="18" value="${cfg.fontSize}"></div>
        <div class="qw-set-row"><span>Blur (${cfg.blur}px)</span><input type="range" id="qw-s-b" min="0" max="50" value="${cfg.blur}"></div>
        <div class="qw-set-row"><span>Darkness (${cfg.darkness}%)</span><input type="range" id="qw-s-d" min="20" max="100" value="${cfg.darkness}"></div>
        <div class="qw-set-row"><span>Show Avatar</span><input type="checkbox" id="qw-s-av" ${cfg.showHeaders ? "checked" : ""}></div>
    `;
    modal.querySelector("#qw-s-close").onclick = () => { modal.remove(); activeSettings = null; };
    modal.querySelector("#qw-s-myc").oninput = e => saveConfig({ myColorV2: e.target.value });
    modal.querySelector("#qw-s-myr").onclick = () => { modal.querySelector("#qw-s-myc").value = toHex(autoMy, "#613f45"); saveConfig({ myColorV2: "" }); };
    modal.querySelector("#qw-s-thc").oninput = e => saveConfig({ theirColorV2: e.target.value });
    modal.querySelector("#qw-s-thr").onclick = () => { modal.querySelector("#qw-s-thc").value = toHex(autoTheir, "#99578d"); saveConfig({ theirColorV2: "" }); };
    modal.querySelector("#qw-s-w").oninput = e => saveConfig({ chatWidth: Number(e.target.value) });
    modal.querySelector("#qw-s-h").oninput = e => saveConfig({ chatHeight: Number(e.target.value) });
    modal.querySelector("#qw-s-f").oninput = e => saveConfig({ fontSize: Number(e.target.value) });
    modal.querySelector("#qw-s-b").oninput = e => saveConfig({ blur: Number(e.target.value) });
    modal.querySelector("#qw-s-d").oninput = e => saveConfig({ darkness: Number(e.target.value) });
    modal.querySelector("#qw-s-av").onchange = e => saveConfig({ showHeaders: e.target.checked });
    document.body.appendChild(modal);
    activeSettings = modal;
}

async function uploadNative(channelId, text, files) {
    const wp = window.Vencord?.Webpack;
    const CloudUpload = wp?.find?.(m => m?.prototype?.uploadFileToCloud && m?.prototype?.upload) || wp?.find?.(m => m?.prototype?.trackUploadFinished);
    const RestAPI = getStore("RestAPI", "post");
    if (CloudUpload && RestAPI?.post) {
        const uploaded = [];
        for (let i = 0; i < files.length; i++) {
            const u = new CloudUpload({ file: files[i], isClip: false, isThumbnail: false, platform: 1 }, channelId, false, i);
            await new Promise((res, rej) => { u.on("complete", res); u.on("error", rej); u.upload(); });
            if (u.uploadedFilename) uploaded.push({ id: String(i), filename: files[i].name || `file-${i}`, uploaded_filename: u.uploadedFilename });
        }
        if (uploaded.length) {
            const r = await RestAPI.post({ url: `/channels/${channelId}/messages`, body: { content: text || "", nonce: makeNonce(), tts: false, attachments: uploaded } });
            return r?.body || null;
        }
    }
    return null;
}

async function copyToClipboard(text, btn) {
    try {
        if (!text) throw new Error("empty");
        if (window.DiscordNative?.clipboard?.copy) window.DiscordNative.clipboard.copy(text);
        else await navigator.clipboard.writeText(text);
        btn.innerHTML = CHECK_SVG;
        setTimeout(() => { btn.innerHTML = COPY_SVG; }, 1400);
    } catch {
        btn.style.borderColor = "#f87171";
        setTimeout(() => { btn.style.borderColor = ""; btn.innerHTML = COPY_SVG; }, 1400);
    }
}

function getAvatar(u) {
    const def = "https://cdn.discordapp.com/embed/avatars/0.png";
    if (!u) return def;
    const live = (u.id && getStore("UserStore")?.getUser?.(String(u.id))) || u;
    try {
        if (typeof live?.getAvatarURL === "function") {
            const url = live.getAvatarURL(null, 48, true);
            if (url) return url;
        }
    } catch {}
    const av = live?.avatar || u.avatar;
    if (av && /^(?:a_)?[0-9a-f]{16,64}$/i.test(String(av))) {
        return `https://cdn.discordapp.com/avatars/${live.id || u.id}/${av}.${String(av).startsWith("a_") ? "gif" : "webp"}?size=48`;
    }
    const idStr = String(live?.id || u.id || "");
    return /^\d{17,20}$/.test(idStr) ? `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(idStr) >> 22n) % 6n)}.png` : def;
}

function renderMessage(msg, myId) {
    const isMe = String(msg.author?.id) === String(myId);
    const row = document.createElement("div");
    row.className = `qw-msg-row ${isMe ? "qw-msg-me" : "qw-msg-them"}`;
    row.dataset.messageId = msg.id;

    const textHtml = escapeHtml(msg.content || "").replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" class="qw-link">${u}</a>`).replace(/\n/g, "<br>");
    const reply = msg.referenced_message ? `<div class="qw-reply"><b>${escapeHtml(msg.referenced_message.author?.username)}:</b> ${escapeHtml(msg.referenced_message.content || "[Media]")}</div>` : "";
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const defAv = "https://cdn.discordapp.com/embed/avatars/0.png";

    row.innerHTML = `
        <div class="qw-msg-header"><img src="${getAvatar(msg.author)}" onerror="this.onerror=null;this.src='${defAv}'" /></div>
        <div class="qw-msg-wrap">
            <div class="qw-msg-bubble">
                ${reply}
                ${textHtml ? `<div class="qw-msg-text">${textHtml}</div>` : ""}
                <div class="qw-atts"></div>
                <div class="qw-msg-time">${time}</div>
            </div>
        </div>
    `;

    const wrap = row.querySelector(".qw-msg-wrap");
    if (msg.content) {
        const cBtn = document.createElement("button");
        cBtn.type = "button";
        cBtn.className = "qw-copy-btn";
        cBtn.title = "Copy message";
        cBtn.innerHTML = COPY_SVG;
        cBtn.onclick = e => { e.stopPropagation(); copyToClipboard(msg.content, cBtn); };
        wrap.appendChild(cBtn);
    }

    const atts = row.querySelector(".qw-atts");
    for (const a of msg.attachments || []) {
        const ct = String(a.content_type || a.contentType || "").toLowerCase();
        const fname = String(a.filename || "File");
        const isSvg = ct.includes("svg") || /\.svg(?:$|\?)/i.test(a.url || "");
        const isTxt = ct.startsWith("text/") || /\.(txt|md|log|json|csv|xml|js|ts|py|html|css)(?:$|\?)/i.test(fname) || /\.(txt|md|log|json)(?:$|\?)/i.test(a.url || "");
        const src = a.proxy_url || a.url;
        if (!isSvg && (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp)(?:$|\?)/i.test(a.url || ""))) {
            if (isAllowedImg(src)) {
                const img = document.createElement("img");
                img.className = "qw-msg-img";
                img.src = src;
                img.onclick = () => openLightbox(isAllowedImg(a.url) ? a.url : src);
                atts.appendChild(img);
            }
        } else if (msg.flags === 8192 || ct.startsWith("audio/") || /\.(ogg|mp3|wav|m4a)(?:$|\?)/i.test(a.url || "")) {
            const aud = document.createElement("audio");
            aud.className = "qw-audio";
            aud.controls = true;
            aud.src = a.url || src;
            atts.appendChild(aud);
        } else if (ct.startsWith("video/") || /\.(mp4|webm|mov)(?:$|\?)/i.test(a.url || "")) {
            const vid = document.createElement("video");
            vid.className = "qw-msg-video";
            vid.controls = true;
            vid.src = src;
            atts.appendChild(vid);
        } else {
            const fRow = document.createElement("div");
            fRow.className = "qw-file-row";
            const link = document.createElement("a");
            link.href = a.url || src;
            link.className = "qw-file-card qw-link";
            link.textContent = `📄 ${fname}`;
            fRow.appendChild(link);
            if (isTxt) {
                const tBtn = document.createElement("button");
                tBtn.type = "button";
                tBtn.className = "qw-txt-copy";
                tBtn.title = "Copy file content";
                tBtn.innerHTML = COPY_SVG;
                tBtn.onclick = async e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const cached = sentTxtMap.get(String(msg.id)) || sentTxtMap.get(String(a.size));
                    if (cached) return copyToClipboard(cached, tBtn);
                    for (const u of [a.url, a.proxy_url].filter(Boolean)) {
                        try {
                            const r = await fetch(u);
                            if (r.ok) return copyToClipboard(await r.text(), tBtn);
                        } catch {}
                    }
                    copyToClipboard("", tBtn);
                };
                fRow.appendChild(tBtn);
            }
            atts.appendChild(fRow);
        }
    }
    for (const emb of msg.embeds || []) {
        const imgUrl = [emb?.image?.proxy_url, emb?.thumbnail?.proxy_url, emb?.image?.url, emb?.thumbnail?.url].find(isAllowedImg);
        if (imgUrl && !/\.svg(?:$|\?)/i.test(imgUrl)) {
            const img = document.createElement("img");
            img.className = "qw-msg-img";
            img.src = imgUrl;
            img.onclick = () => openLightbox(imgUrl);
            atts.appendChild(img);
        }
    }
    return row;
}

class WhisperSession {
    constructor(userId, channelId, user, guildId, anchor) {
        this.userId = String(userId);
        this.channelId = String(channelId);
        this.guildId = guildId;
        this.anchor = anchor || null;
        this.myId = getStore("UserStore")?.getCurrentUser?.()?.id;
        this.messages = [];
        this.messageMap = new Map();
        this.hasMore = true;
        this.loadingOlder = false;
        this.lastFetch = 0;
        this.files = [];

        this.onMsgCreate = e => !e.optimistic && (e.channelId || e.message?.channel_id) === this.channelId && this.addMessage(e.message, true);
        this.onMsgUpdate = e => (e.channelId || e.message?.channel_id) === this.channelId && this.syncStore();
        this.onMsgDelete = e => e.channelId === this.channelId && this.syncStore();

        this.mountUI(user, anchor);
        this.initData();
    }

    mountUI(user, anchor) {
        const name = user?.globalName || user?.username || "User";
        const defAv = "https://cdn.discordapp.com/embed/avatars/0.png";
        const ui = document.createElement("div");
        ui.className = "qw-root";
        ui.innerHTML = `
            <div class="qw-header">
                <div class="qw-header-left"><img class="qw-avatar" src="${getAvatar(user || { id: this.userId })}" onerror="this.onerror=null;this.src='${defAv}'"><span>${escapeHtml(name)}</span></div>
                <div><button class="qw-btn gear">⚙</button> <button class="qw-btn close">✕</button></div>
            </div>
            <div class="qw-scroller"><div class="qw-msgs"></div></div>
            <div class="qw-composer">
                <div class="qw-att-list"></div>
                <div class="qw-input-row">
                    <input type="file" multiple style="display:none" class="qw-file-in">
                    <button class="qw-btn up">＋</button>
                    <textarea class="qw-input" rows="1" placeholder="Message @${escapeHtml(name)}"></textarea>
                    <button class="qw-btn send">➤</button>
                </div>
            </div>
        `;
        this.ui = ui;
        this.scroller = ui.querySelector(".qw-scroller");
        this.msgBox = ui.querySelector(".qw-msgs");
        this.input = ui.querySelector(".qw-input");
        this.attBox = ui.querySelector(".qw-att-list");
        const fileIn = ui.querySelector(".qw-file-in");

        const cfg = getConfig(), w = cfg.chatWidth, h = cfg.chatHeight, idx = sessionStack.length * 22;
        const r = anchor?.getBoundingClientRect?.();
        const left = cfg.lastPosition?.left ? cfg.lastPosition.left + idx : (r ? Math.min(window.innerWidth - w - 15, Math.max(10, r.right + 12)) : 200 + idx);
        const top = cfg.lastPosition?.top ? cfg.lastPosition.top + idx : (r ? Math.min(window.innerHeight - h - 15, Math.max(10, r.top)) : 120 + idx);
        ui.style.left = `${left}px`;
        ui.style.top = `${top}px`;

        const header = ui.querySelector(".qw-header");
        header.onpointerdown = e => {
            if (e.button !== 0 || e.target.closest("button")) return;
            bringToFront(this.userId);
            const sx = e.clientX, sy = e.clientY, sr = ui.getBoundingClientRect();
            header.setPointerCapture(e.pointerId);
            const move = ev => {
                ui.style.left = `${Math.max(10, Math.min(window.innerWidth - sr.width - 10, sr.left + ev.clientX - sx))}px`;
                ui.style.top = `${Math.max(10, Math.min(window.innerHeight - sr.height - 10, sr.top + ev.clientY - sy))}px`;
            };
            const up = () => {
                header.releasePointerCapture(e.pointerId);
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                const br = ui.getBoundingClientRect();
                saveConfig({ lastPosition: { left: Math.round(br.left), top: Math.round(br.top) } });
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        };

        ui.onpointerdown = () => bringToFront(this.userId);
        ui.querySelector(".close").onclick = () => closeSession(this.userId);
        ui.querySelector(".gear").onclick = () => toggleSettings(ui, this);
        ui.querySelector(".up").onclick = () => fileIn.click();
        fileIn.onchange = () => { this.addFiles(fileIn.files); fileIn.value = ""; };
        ui.onpaste = e => {
            const pasted = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean);
            if (pasted.length) { e.preventDefault(); this.addFiles(pasted); }
        };

        this.input.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); } };
        ui.querySelector(".send").onclick = () => this.send();
        this.scroller.addEventListener("wheel", e => { if (e.deltaY < 0 && this.scroller.scrollTop < 25) this.loadOlder(); }, { passive: true });
        this.msgBox.onclick = e => {
            const a = e.target.closest("a.qw-link");
            if (a?.href) { e.preventDefault(); openUrl(a.href); }
        };

        this.applyColors();
        document.body.appendChild(ui);
        setTimeout(() => this.input.focus(), 50);
    }

    applyColors() {
        const cfg = getConfig();
        const th = cfg.theirColorV2 || getRoleColor(this.guildId, this.userId, this.anchor) || "#99578d";
        const my = cfg.myColorV2 || getRoleColor(this.guildId, this.myId) || "#613f45";
        this.ui.style.setProperty("--qw-their-bg", th, "important");
        this.ui.style.setProperty("--qw-their-txt", getContrast(th), "important");
        this.ui.style.setProperty("--qw-my-bg", my, "important");
        this.ui.style.setProperty("--qw-my-txt", getContrast(my), "important");
    }

    addFiles(list) {
        for (const f of Array.from(list || [])) if (f) this.files.push(f);
        this.attBox.innerHTML = this.files.map((f, i) => `<span class="qw-att-chip">${escapeHtml(f.name)} <b data-idx="${i}" style="cursor:pointer">✕</b></span>`).join("");
        this.attBox.querySelectorAll("b[data-idx]").forEach(b => b.onclick = () => { this.files.splice(Number(b.dataset.idx), 1); this.addFiles([]); });
    }

    syncStore(scrollBottom = false) {
        const res = getStore("MessageStore")?.getMessages?.(this.channelId);
        const arr = res?._array || (Array.isArray(res) ? res : []);
        if (res?.hasMoreBefore === false) this.hasMore = false;
        if (!arr.length) return 0;
        this.messages = [...arr];
        this.messageMap.clear();
        this.msgBox.innerHTML = "";
        for (const m of this.messages) {
            this.messageMap.set(m.id, m);
            if (m.nonce) this.messageMap.set(m.nonce, m);
            this.msgBox.appendChild(renderMessage(m, this.myId));
        }
        if (scrollBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
        return arr.length;
    }

    async initData() {
        const Flux = getStore("FluxDispatcher", "subscribe");
        Flux?.subscribe?.("MESSAGE_CREATE", this.onMsgCreate);
        Flux?.subscribe?.("MESSAGE_UPDATE", this.onMsgUpdate);
        Flux?.subscribe?.("MESSAGE_DELETE", this.onMsgDelete);

        if (this.syncStore(true) > 0 || fetchedChannels.has(this.channelId)) {
            ackChannel(this.channelId, this.messages[this.messages.length - 1]?.id);
            return;
        }
        const MessageActions = getStore("MessageActions", "fetchMessages");
        if (typeof MessageActions?.fetchMessages === "function") {
            fetchedChannels.add(this.channelId);
            this.lastFetch = Date.now();
            await enqueueNet(`init:${this.channelId}`, () => MessageActions.fetchMessages({ channelId: this.channelId, limit: 50 }));
            if (!this.syncStore(true)) this.hasMore = false;
            ackChannel(this.channelId, this.messages[this.messages.length - 1]?.id);
        }
    }

    addMessage(msg, fromFlux = false) {
        if (!msg?.id || this.messageMap.has(msg.id) || (msg.nonce && this.messageMap.has(msg.nonce))) return;
        this.messageMap.set(msg.id, msg);
        if (msg.nonce) this.messageMap.set(msg.nonce, msg);
        this.messages.push(msg);
        this.msgBox.appendChild(renderMessage(msg, this.myId));
        this.scroller.scrollTop = this.scroller.scrollHeight;
        if (fromFlux) ackChannel(this.channelId, msg.id);
    }

    async loadOlder() {
        if (this.loadingOlder || !this.hasMore || !this.messages.length || Date.now() - this.lastFetch < 4000) return;
        const MessageActions = getStore("MessageActions", "fetchMessages");
        if (typeof MessageActions?.fetchMessages !== "function") return;
        this.loadingOlder = true;
        this.lastFetch = Date.now();
        const oldestId = this.messages[0].id, prevH = this.scroller.scrollHeight, prevCount = this.messages.length;
        try {
            await enqueueNet(`old:${this.channelId}:${oldestId}`, () => MessageActions.fetchMessages({ channelId: this.channelId, before: oldestId, limit: 50 }));
            this.syncStore(false);
            if (this.messages.length <= prevCount) this.hasMore = false;
            else this.scroller.scrollTop = this.scroller.scrollHeight - prevH;
        } finally { this.loadingOlder = false; }
    }

    async send() {
        let content = this.input.value.trim();
        const files = [...this.files];
        if (!content && !files.length) return;
        this.input.value = "";
        this.files = [];
        this.addFiles([]);
        let rawLongText = "";
        const maxLen = getStore("UserStore")?.getCurrentUser?.()?.premiumType === 2 ? 4000 : 2000;
        if (content.length > maxLen) {
            rawLongText = content;
            const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
            sentTxtMap.set(String(blob.size), content);
            files.push(new File([blob], "message.txt", { type: "text/plain" }));
            content = "";
        }
        try {
            if (files.length) {
                const res = await enqueueNet(null, () => uploadNative(this.channelId, content, files));
                if (res?.id) {
                    if (rawLongText) sentTxtMap.set(String(res.id), rawLongText);
                    this.addMessage(res);
                }
            } else {
                const MessageActions = getStore("MessageActions", "sendMessage");
                if (typeof MessageActions?.sendMessage === "function") {
                    const nonce = makeNonce();
                    const res = await enqueueNet(null, () => MessageActions.sendMessage(
                        this.channelId,
                        { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [], nonce },
                        true,
                        { nonce }
                    ));
                    if (res?.body?.id) this.addMessage(res.body);
                }
            }
        } catch (err) { console.error("[MBDM] send error:", err); }
    }

    destroy() {
        const Flux = getStore("FluxDispatcher", "unsubscribe");
        Flux?.unsubscribe?.("MESSAGE_CREATE", this.onMsgCreate);
        Flux?.unsubscribe?.("MESSAGE_UPDATE", this.onMsgUpdate);
        Flux?.unsubscribe?.("MESSAGE_DELETE", this.onMsgDelete);
        this.ui.remove();
    }
}

function isOpenChannel(channelId) {
    if (!channelId) return false;
    channelId = String(channelId);
    for (const s of activeSessions.values()) if (s.channelId === channelId) return true;
    return false;
}

function bringToFront(userId) {
    userId = String(userId);
    const idx = sessionStack.indexOf(userId);
    if (idx !== -1) { sessionStack.splice(idx, 1); sessionStack.push(userId); }
    sessionStack.forEach((id, i) => activeSessions.get(id)?.ui?.style.setProperty("z-index", String(100000 + i), "important"));
}

function closeSession(userId) {
    userId = String(userId);
    const s = activeSessions.get(userId);
    if (!s) return;
    activeSessions.delete(userId);
    const i = sessionStack.indexOf(userId);
    if (i !== -1) sessionStack.splice(i, 1);
    s.destroy();
    queueVoiceSync();
}

function getElementFiber(el) {
    for (let c = el; c; c = c.parentElement) {
        const k = Object.keys(c).find(n => n.startsWith("__reactFiber$") || n.startsWith("__reactInternalInstance$"));
        if (k) return c[k];
    }
    return null;
}

function getUserId(node) {
    if (!node) return null;
    const attr = node.closest?.("[data-user-id],[data-mention-id]")?.getAttribute("data-user-id") || node.closest?.("[data-mention-id]")?.getAttribute("data-mention-id");
    if (attr && /^\d{17,20}$/.test(attr)) return attr;
    const img = node.matches?.('img[src*="/avatars/"]') ? node : node.querySelector?.('img[src*="/avatars/"]');
    const m = img?.src?.match(/\/avatars\/(\d{17,20})\//);
    if (m) return m[1];
    let cur = getElementFiber(node), d = 0;
    while (cur && d++ < 70) {
        const p = cur.memoizedProps;
        const id = p?.user?.id || p?.userId || p?.message?.author?.id || p?.author?.id || p?.voiceState?.userId || p?.member?.userId || p?.recipient?.id;
        if (id && /^\d{17,20}$/.test(String(id))) return String(id);
        cur = cur.return;
    }
    return null;
}

function ackChannel(channelId, msgId = null) {
    if (!channelId) return;
    channelId = String(channelId);
    setTimeout(() => {
        const RS = getStore("ReadStateStore");
        const CS = getStore("ChannelStore");
        const ch = CS?.getChannel?.(channelId);
        const messageId = String(msgId || RS?.lastMessageId?.(channelId) || ch?.lastMessageId || ch?.last_message_id || "");
        const Flux = getStore("FluxDispatcher", "dispatch");
        if (messageId && Flux?.dispatch) {
            try { Flux.dispatch({ type: "BULK_ACK", context: "APP", channels: [{ channelId, messageId, readStateType: 0 }] }); } catch {}
        }
        queueVoiceSync();
    }, 25);
}

function setupNotificationGuard() {
    const Flux = getStore("FluxDispatcher", "dispatch", "subscribe");
    const myId = () => String(getStore("UserStore")?.getCurrentUser?.()?.id || "");
    const onPreMsg = e => {
        const cid = String(e.channelId || e.message?.channel_id || "");
        const uid = String(e.message?.author?.id || "");
        if (uid && uid !== myId() && (isOpenChannel(cid) || activeSessions.has(uid))) {
            muteSoundUntil = Date.now() + 800;
            ackChannel(cid, e.message?.id);
        }
    };

    if (Array.isArray(Flux?._interceptors)) {
        const interceptor = payload => {
            if (payload?.type === "MESSAGE_CREATE") onPreMsg(payload);
            return false;
        };
        Flux._interceptors.unshift(interceptor);
        cleanups.push(() => {
            const i = Flux._interceptors.indexOf(interceptor);
            if (i !== -1) Flux._interceptors.splice(i, 1);
        });
    } else if (Flux?.subscribe) {
        Flux.subscribe("MESSAGE_CREATE", onPreMsg);
        cleanups.push(() => Flux.unsubscribe("MESSAGE_CREATE", onPreMsg));
    }

    const UGS = getStore("UserGuildSettingsStore");
    if (UGS && typeof UGS.isChannelMuted === "function") {
        const origMuted = UGS.isChannelMuted.bind(UGS);
        UGS.isChannelMuted = (gid, cid) => isOpenChannel(cid) ? true : origMuted(gid, cid);
        cleanups.push(() => { UGS.isChannelMuted = origMuted; });
    }

    if (typeof AudioBufferSourceNode !== "undefined" && AudioBufferSourceNode.prototype?.start) {
        const origStart = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
            if (Date.now() < muteSoundUntil) return;
            return origStart.apply(this, args);
        };
        cleanups.push(() => { AudioBufferSourceNode.prototype.start = origStart; });
    }
}

function queueVoiceSync() {
    if (!pluginRunning || voiceSyncFrame) return;
    voiceSyncFrame = requestAnimationFrame(() => {
        voiceSyncFrame = 0;
        const CS = getStore("ChannelStore"), RS = getStore("ReadStateStore"), VS = getStore("VoiceStateStore");
        const myId = getStore("UserStore")?.getCurrentUser?.()?.id;
        const myVoiceId = getStore("SelectedChannelStore")?.getVoiceChannelId?.() || (myId && VS?.getVoiceStateForUser?.(myId)?.channelId);
        const unreads = new Set();

        if (CS && RS && VS && myVoiceId) {
            const ids = CS.getDMUserIds?.() || Object.keys(CS.getMutableDMsByUserIds?.() || {});
            for (const uid of ids) {
                if (activeSessions.has(String(uid))) continue;
                const cid = CS.getDMFromUserId?.(uid);
                if (cid && RS.hasUnread?.(cid) && String(VS.getVoiceStateForUser?.(uid)?.channelId || "") === String(myVoiceId)) unreads.add(String(uid));
            }
        }
        document.querySelectorAll(".qw-voice-unread-dot").forEach(d => !unreads.has(d.dataset.uid) && d.remove());
        for (const row of document.querySelectorAll('[class*="voiceUser"]')) {
            const uid = getUserId(row);
            if (!uid || !unreads.has(uid) || row.querySelector(".qw-voice-unread-dot")) continue;
            const dot = document.createElement("span");
            dot.className = "qw-voice-unread-dot";
            dot.dataset.uid = uid;
            row.querySelector('[class*="content_"], [class^="content_"]')?.appendChild(dot);
        }

        const dmList = document.getElementById("guild-list-unread-dms");
        if (dmList && CS) {
            const items = [], hidden = new Set();
            for (const nav of dmList.querySelectorAll('[data-list-item-id^="guildsnav___"]')) {
                const cid = (nav.getAttribute("data-list-item-id") || "").replace("guildsnav___", "");
                if (!cid || cid === "home") continue;
                const ch = CS.getChannel?.(cid);
                const uid = String(ch?.recipients?.[0] || ch?.rawRecipients?.[0]?.id || "");
                const item = nav.closest('[class*="listItem"]') || nav.parentElement || nav;
                items.push(item);
                if (isOpenChannel(cid) || activeSessions.has(uid) || unreads.has(uid)) hidden.add(item);
            }
            document.querySelectorAll('[data-qw-voice-unread-hidden="true"]').forEach(el => !hidden.has(el) && el.removeAttribute("data-qw-voice-unread-hidden"));
            hidden.forEach(el => el.setAttribute("data-qw-voice-unread-hidden", "true"));
            if (items.length && items.every(i => hidden.has(i))) dmList.setAttribute("data-qw-voice-unread-empty", "true");
            else dmList.removeAttribute("data-qw-voice-unread-empty");
        }
    });
}

async function openChat(userId, anchor, channelId = null) {
    userId = String(userId);
    if (activeSessions.has(userId)) return bringToFront(userId);

    const CS = getStore("ChannelStore");
    let cid = channelId || resolvedDmChannels.get(userId) || CS?.getDMFromUserId?.(userId);
    if (!cid) {
        const PCA = getStore("PrivateChannelActions", "ensurePrivateChannel");
        if (typeof PCA?.ensurePrivateChannel === "function") {
            cid = await enqueueNet(`dm:${userId}`, () => PCA.ensurePrivateChannel(userId));
        }
    }
    if (!cid || !pluginRunning) return;
    resolvedDmChannels.set(userId, String(cid));
    if (activeSessions.has(userId)) return bringToFront(userId);

    const user = getStore("UserStore")?.getUser?.(userId);
    const gid = getActiveGuildId();
    const session = new WhisperSession(userId, cid, user, gid, anchor);
    activeSessions.set(userId, session);
    sessionStack.push(userId);
    bringToFront(userId);
    ackChannel(cid);
}

function onMouseDown(e) {
    if (e.button === 1 && !e.target.closest?.(".qw-root, #qw-lightbox, #qw-floating-settings") && getUserId(e.target)) e.preventDefault();
}

function onAuxClick(e) {
    if (e.button !== 1 || e.target.closest?.(".qw-root, #qw-lightbox, #qw-floating-settings")) return;
    const uid = getUserId(e.target);
    const myId = getStore("UserStore")?.getCurrentUser?.()?.id;
    if (!uid || String(uid) === String(myId) || Date.now() - lastClickAt < 1000) return;
    lastClickAt = Date.now();
    e.preventDefault();
    e.stopImmediatePropagation();
    openChat(uid, e.target);
}

function onGlobalDrag(e) {
    if (!pluginRunning || !Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    const hit = [...sessionStack].reverse().map(id => activeSessions.get(id)).find(s => {
        const r = s?.ui?.getBoundingClientRect();
        return r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (dropTargetId && dropTargetId !== hit?.userId) activeSessions.get(dropTargetId)?.ui?.classList.remove("qw-drop");
    dropTargetId = hit?.userId || null;
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    hit.ui.classList.add("qw-drop");
    if (e.type === "drop") {
        hit.ui.classList.remove("qw-drop");
        dropTargetId = null;
        hit.addFiles(e.dataTransfer?.files);
    }
}

const plugin = _definePlugin({
    name: "MBDM",
    description: "Mini DM client on middle-click",
    authors: [{ name: "MBdr", id: 0n }],
    startAt: StartAt?.WebpackReady || "WebpackReady",
    enabledByDefault: true,

    start() {
        pluginRunning = true;
        updateCustomStyles();
        setupNotificationGuard();
        const refreshColors = () => { for (const s of activeSessions.values()) s.applyColors?.(); };
        for (const s of ["ChannelStore", "ReadStateStore", "VoiceStateStore", "SelectedChannelStore"].map(n => getStore(n)).filter(Boolean)) {
            if (s.addChangeListener) { s.addChangeListener(queueVoiceSync); cleanups.push(() => s.removeChangeListener(queueVoiceSync)); }
        }
        for (const s of ["GuildMemberStore", "GuildRoleStore", "UserProfileStore", "SelectedGuildStore"].map(n => getStore(n)).filter(Boolean)) {
            if (s.addChangeListener) { s.addChangeListener(refreshColors); cleanups.push(() => s.removeChangeListener(refreshColors)); }
        }
        queueVoiceSync();
        document.addEventListener("mousedown", onMouseDown, true);
        document.addEventListener("auxclick", onAuxClick, true);
        for (const t of ["dragenter", "dragover", "drop"]) window.addEventListener(t, onGlobalDrag, true);
    },

    stop() {
        pluginRunning = false;
        while (cleanups.length) cleanups.pop()();
        for (const t of ackTimers.values()) clearTimeout(t);
        ackTimers.clear();
        document.removeEventListener("mousedown", onMouseDown, true);
        document.removeEventListener("auxclick", onAuxClick, true);
        for (const t of ["dragenter", "dragover", "drop"]) window.removeEventListener(t, onGlobalDrag, true);
        for (const id of [...activeSessions.keys()]) closeSession(id);
        document.querySelectorAll("#qw-styles, .qw-root, #qw-floating-settings, #qw-lightbox, .qw-voice-unread-dot").forEach(el => el.remove());
    }
});

export default plugin;

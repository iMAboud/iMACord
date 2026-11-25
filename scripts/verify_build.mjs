#!/usr/bin/env node
import { execFile, execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import http from "http";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import vm from "vm";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const vencordDir = path.join(rootDir, "Vencord-main");
const distDir = path.join(vencordDir, "dist");
const userpluginsDir = path.join(rootDir, "userplugins");

const args = new Set(process.argv.slice(2));
const verifyRelease = args.has("--verify-release") || args.has("--only-release");
const onlyRelease = args.has("--only-release");
const skipWeb = args.has("--skip-web");

function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex").toLowerCase();
}

function assert(cond, msg) {
    if (!cond) throw new Error(`[VERIFY FAILED] ${msg}`);
}

function step(title) {
    console.log(`\n=== [Verify] ${title} ===`);
}

function verifyTypeScriptContracts() {
    step("1. Core TypeScript & Native/Stub Interface Contracts");
    const vcRequire = createRequire(path.join(vencordDir, "package.json"));
    const ts = vcRequire("typescript");

    const cfgPath = path.join(vencordDir, "tsconfig.json");
    const cfgFile = ts.readConfigFile(cfgPath, ts.sys.readFile);
    assert(!cfgFile.error, `Failed to read tsconfig.json: ${cfgFile.error?.messageText}`);

    const parsed = ts.parseJsonConfigFileContent(
        {
            ...cfgFile.config,
            exclude: ["src/equicordplugins/**/*", "src/plugins/iMAMenu/**/*"]
        },
        ts.sys,
        vencordDir
    );

    const prog = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    const corePrefixes = [
        "src/main/",
        "src/preload.ts",
        "src/vencordnative.ts",
        "src/shared/",
        "src/utils/updater.ts",
        "src/vencord.ts",
        "src/components/settings/tabs/updater/",
        "browser/"
    ];

    const diags = ts.getPreEmitDiagnostics(prog).filter(d => {
        if (!d.file) return true;
        const rel = path.relative(vencordDir, d.file.fileName).replace(/\\/g, "/").toLowerCase();
        return corePrefixes.some(p => rel.startsWith(p));
    });

    if (diags.length > 0) {
        const formatted = diags.map(d => {
            if (!d.file) return ts.flattenDiagnosticMessageText(d.messageText, "\n");
            const pos = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
            const rel = path.relative(rootDir, d.file.fileName).replace(/\\/g, "/");
            return `  ${rel}:${pos.line + 1}:${pos.character + 1} - TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
        }).join("\n");
        throw new Error(`TypeScript contract errors in core modules:\n${formatted}`);
    }

    // Check VencordNative <-> VencordNativeStub namespace & method parity
    function extractObjectShape(filePath, findRootObj) {
        const src = fs.readFileSync(filePath, "utf8");
        const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
        const rootObj = findRootObj(ts, sf);
        assert(rootObj, `Could not locate VencordNative object literal in ${filePath}`);
        const shape = new Map();
        for (const prop of rootObj.properties) {
            if (!prop.name) continue;
            const ns = prop.name.getText(sf);
            const methods = new Set();
            const init = prop.initializer;
            if (init && ts.isAsExpression(init)) {
                shape.set(ns, null);
                continue;
            }
            if (init && ts.isObjectLiteralExpression(init)) {
                for (const sub of init.properties) {
                    if (sub.name) methods.add(sub.name.getText(sf));
                }
            }
            shape.set(ns, methods);
        }
        return shape;
    }

    const nativeShape = extractObjectShape(
        path.join(vencordDir, "src", "VencordNative.ts"),
        (tsMod, sf) => {
            let found = null;
            sf.forEachChild(node => {
                if (tsMod.isExportAssignment(node) && tsMod.isObjectLiteralExpression(node.expression)) {
                    found = node.expression;
                }
            });
            return found;
        }
    );

    const stubShape = extractObjectShape(
        path.join(vencordDir, "browser", "VencordNativeStub.ts"),
        (tsMod, sf) => {
            let found = null;
            function visit(node) {
                if (
                    tsMod.isBinaryExpression(node) &&
                    node.left.getText(sf) === "window.VencordNative" &&
                    tsMod.isObjectLiteralExpression(node.right)
                ) {
                    found = node.right;
                }
                node.forEachChild(visit);
            }
            visit(sf);
            return found;
        }
    );

    for (const [ns, methods] of nativeShape.entries()) {
        assert(stubShape.has(ns), `VencordNativeStub is missing namespace '${ns}'`);
        const stubMethods = stubShape.get(ns);
        if (methods && stubMethods) {
            for (const m of methods) {
                assert(stubMethods.has(m), `VencordNativeStub.${ns} is missing method '${m}'`);
            }
        }
    }

    console.log(`  [OK] Core TypeScript diagnostics: 0 errors; VencordNative <-> Stub parity verified.`);
}

function verifyBundlesAndSyntax() {
    step("2. Bundle Presence & VM Syntax Validation");
    const requiredDesktop = [
        "patcher.js",
        "preload.js",
        "renderer.js",
        "renderer.css",
        "vencordDesktopMain.js",
        "vencordDesktopPreload.js",
        "vencordDesktopRenderer.js",
        "vencordDesktopRenderer.css"
    ];
    const requiredWeb = skipWeb ? [] : ["browser.js", "extension.js", "Vencord.user.js"];

    for (const file of [...requiredDesktop, ...requiredWeb]) {
        const full = path.join(distDir, file);
        assert(fs.existsSync(full), `Missing build artifact: Vencord-main/dist/${file}`);
        const size = fs.statSync(full).size;
        assert(size > 32, `Build artifact is unexpectedly empty (${size}B): ${file}`);
        if (file.endsWith(".js")) {
            const code = fs.readFileSync(full, "utf8");
            new vm.Script(code, { filename: file });
        }
    }

    if (fs.existsSync(userpluginsDir)) {
        const vcRequire = createRequire(path.join(vencordDir, "package.json"));
        const ts = vcRequire("typescript");
        for (const file of fs.readdirSync(userpluginsDir)) {
            if (!file.endsWith(".js")) continue;
            const full = path.join(userpluginsDir, file);
            const code = fs.readFileSync(full, "utf8");
            const res = ts.transpileModule(code, {
                fileName: `userplugins/${file}`,
                reportDiagnostics: true,
                compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }
            });
            const synErrs = (res.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
            assert(synErrs.length === 0, `Syntax error in userplugins/${file}: ${synErrs[0]?.messageText}`);
        }
    }

    console.log(`  [OK] All desktop${skipWeb ? "" : "/web"} bundles & userplugins compiled cleanly.`);
}

function runIsolatedNodeScript(label, scriptSource, envOverrides = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "imcord-verify-"));
    const scriptPath = path.join(tmpDir, "harness.cjs");
    fs.writeFileSync(scriptPath, scriptSource, "utf8");
    try {
        const out = execFileSync(process.execPath, [scriptPath], {
            cwd: rootDir,
            env: { ...process.env, ...envOverrides },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 45_000
        });
        if (out.trim()) {
            for (const line of out.trim().split(/\r?\n/)) {
                console.log(`  [${label}] ${line}`);
            }
        }
    } catch (err) {
        const stdout = err.stdout ? String(err.stdout) : "";
        const stderr = err.stderr ? String(err.stderr) : "";
        throw new Error(`[${label}] Runtime verification failed:\n${stdout}\n${stderr}\n${err.message}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function verifyMainPreloadRendererAndUpdater() {
    step("3. Full Patched Main + Preload + Renderer + Self-Updater E2E Simulation");

    const harness = `
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const vm = require("vm");

const srcDistDir = ${JSON.stringify(distDir)};
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "imcord-e2e-runtime-"));
const vencordDataDir = path.join(sandboxRoot, "VencordData");
const sandboxDistDir = path.join(vencordDataDir, "dist");
const sandboxPluginsDir = path.join(vencordDataDir, "userplugins");
fs.mkdirSync(sandboxDistDir, { recursive: true });
fs.mkdirSync(sandboxPluginsDir, { recursive: true });

for (const f of ["patcher.js", "preload.js", "renderer.js", "renderer.css"]) {
    fs.copyFileSync(path.join(srcDistDir, f), path.join(sandboxDistDir, f));
}

// Seed an obsolete plugin to verify updater removal
fs.writeFileSync(path.join(sandboxPluginsDir, "ObsoleteVerifyPlugin.js"), "// obsolete", "utf8");

// Setup mock Discord app/_app.asar layout
const discordResDir = path.join(sandboxRoot, "Discord", "app-1.0.9999", "resources");
const stockAsarDir = path.join(discordResDir, "_app.asar");
const injectorDir = path.join(discordResDir, "app.asar");
fs.mkdirSync(stockAsarDir, { recursive: true });
fs.mkdirSync(injectorDir, { recursive: true });
fs.writeFileSync(path.join(stockAsarDir, "package.json"), JSON.stringify({ name: "discord", main: "main.js" }));
fs.writeFileSync(path.join(stockAsarDir, "main.js"), "global.__discordStockMainLoaded = true; module.exports = {};");
fs.writeFileSync(path.join(injectorDir, "index.js"), "");

process.env.VENCORD_USER_DATA_DIR = vencordDataDir;

let unhandledError = null;
process.on("uncaughtException", err => {
    unhandledError = err;
    console.error("UNCAUGHT EXCEPTION:", err);
    process.exit(1);
});
process.on("unhandledRejection", err => {
    unhandledError = err;
    console.error("UNHANDLED REJECTION:", err);
    process.exit(1);
});

const ipcInvokeHandlers = new Map();
const ipcSyncHandlers = new Map();
const readyCallbacks = [];
const protocolHandlers = new Map();
const dialogCalls = [];
let headersReceivedCb = null;
let exposedInMainWorld = {};
let executedRendererJs = "";
let discordPreloadLoaded = false;

const stockDiscordPreload = path.join(sandboxRoot, "discord_stock_preload.js");
fs.writeFileSync(stockDiscordPreload, "global.__discordStockPreloadLoaded = true;", "utf8");

class MockBrowserWindow {
    constructor(opts) {
        this.opts = opts;
        this.webContents = {
            on: () => {},
            once: () => {},
            setWindowOpenHandler: () => {},
            session: {}
        };
    }
    loadURL() { return Promise.resolve(); }
    on() {}
    focus() {}
    isDestroyed() { return false; }
    setMinimumSize() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
}

const electronMock = {
    app: {
        getPath: () => path.join(sandboxRoot, "DiscordUserData"),
        setAppPath: p => { global.__setAppPath = p; },
        whenReady: () => ({
            then: cb => { readyCallbacks.push(cb); return Promise.resolve(); }
        }),
        on: () => {},
        commandLine: { appendSwitch: () => {} },
        relaunch: () => { global.__appRelaunched = true; },
        exit: () => { global.__appExited = true; },
        quit: () => {}
    },
    ipcMain: {
        handle: (channel, fn) => {
            assert.strictEqual(typeof channel, "string", "ipcMain.handle channel must be string, got: " + String(channel));
            assert(channel.length > 0, "ipcMain.handle channel cannot be empty");
            assert(!ipcInvokeHandlers.has(channel), "Duplicate ipcMain.handle registration for: " + channel);
            assert.strictEqual(typeof fn, "function", "ipcMain.handle handler must be function for: " + channel);
            ipcInvokeHandlers.set(channel, fn);
        },
        on: (channel, fn) => {
            assert.strictEqual(typeof channel, "string", "ipcMain.on channel must be string, got: " + String(channel));
            assert(channel.length > 0, "ipcMain.on channel cannot be empty");
            assert.strictEqual(typeof fn, "function", "ipcMain.on listener must be function for: " + channel);
            ipcSyncHandlers.set(channel, fn);
        }
    },
    BrowserWindow: MockBrowserWindow,
    Menu: {
        buildFromTemplate: template => ({ template })
    },
    protocol: {
        handle: (scheme, fn) => { protocolHandlers.set(scheme, fn); }
    },
    session: {
        defaultSession: {
            webRequest: {
                onHeadersReceived: cb => { headersReceivedCb = cb; }
            }
        }
    },
    net: {
        fetch: global.fetch
    },
    dialog: {
        showMessageBox: async (... callArgs) => {
            const opts = callArgs.length > 1 ? callArgs[1] : callArgs[0];
            dialogCalls.push(opts);
            return { response: 0 };
        },
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true })
    },
    shell: {
        openExternal: async () => {},
        openPath: async () => "",
        showItemInFolder: () => {}
    },
    nativeTheme: { shouldUseDarkColors: true },
    systemPreferences: { getAccentColor: () => "ff00aa" },
    webFrameMain: { fromId: () => null }
};

const electronRendererMock = {
    ipcRenderer: {
        invoke: async (channel, ...callArgs) => {
            assert(ipcInvokeHandlers.has(channel), "Renderer invoked unregistered IPC channel: " + String(channel));
            const fakeEvent = {
                sender: {
                    postMessage: () => {},
                    once: () => {},
                    isDestroyed: () => false,
                    isDevToolsOpened: () => false,
                    openDevTools: () => {},
                    downloadURL: () => {},
                    executeJavaScript: async () => {},
                    mainFrame: { origin: "https://discord.com" }
                },
                senderFrame: { origin: "https://discord.com" }
            };
            return await ipcInvokeHandlers.get(channel)(fakeEvent, ...callArgs);
        },
        sendSync: (channel, ...callArgs) => {
            assert(ipcSyncHandlers.has(channel), "Renderer sendSync on unregistered IPC channel: " + String(channel));
            const fakeEvent = { returnValue: undefined };
            ipcSyncHandlers.get(channel)(fakeEvent, ...callArgs);
            return fakeEvent.returnValue;
        },
        on: () => {}
    },
    contextBridge: {
        exposeInMainWorld: (key, val) => { exposedInMainWorld[key] = val; }
    },
    webFrame: {
        executeJavaScript: code => { executedRendererJs = code; }
    }
};

const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "electron" || request === "electron/main") {
        const resolved = require.cache["__mock_electron__"];
        return resolved ? resolved.exports : electronMock;
    }
    if (request === "electron/renderer") return electronRendererMock;
    if (request === "original-fs") return fs;
    return origLoad.apply(this, arguments);
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === "electron" || request === "electron/main") return "__mock_electron__";
    if (request === "electron/renderer") return "__mock_electron_renderer__";
    if (request === "original-fs") return "__mock_original_fs__";
    return origResolve.apply(this, arguments);
};
require.cache["__mock_electron__"] = { id: "__mock_electron__", filename: "__mock_electron__", loaded: true, exports: electronMock };

// Configure require.main to mimic Discord's patched app.asar/index.js
require.main.filename = path.join(injectorDir, "index.js");
require.main.path = injectorDir;

// 1. Boot full non-vanilla patcher.js
require(path.join(sandboxDistDir, "patcher.js"));

assert.strictEqual(global.__discordStockMainLoaded, true, "patcher.js did not chain-load stock Discord _app.asar");
assert.strictEqual(global.__setAppPath, stockAsarDir, "patcher.js did not setAppPath to _app.asar");

// Verify BrowserWindow subclass injection
const PatchedElectron = require("electron");
const testWin = new PatchedElectron.BrowserWindow({
    title: "Discord",
    webPreferences: { preload: stockDiscordPreload }
});
assert.strictEqual(
    testWin.opts.webPreferences.preload,
    path.join(sandboxDistDir, "preload.js"),
    "Patched BrowserWindow did not inject Vencord preload.js"
);
assert.strictEqual(process.env.DISCORD_PRELOAD, stockDiscordPreload, "DISCORD_PRELOAD env was not preserved");

// Verify Tray Menu patching
const builtMenu = PatchedElectron.Menu.buildFromTemplate([
    { label: "Discord" },
    { type: "separator" },
    { role: "quit" }
]);
const vencordMenu = builtMenu.template.find(i => i.id === "vencord");
assert(vencordMenu && Array.isArray(vencordMenu.submenu), "Tray menu was not patched with Vencord submenu");

(async () => {
    // Flush app.whenReady() callbacks (protocol + CSP registration)
    for (const cb of readyCallbacks) await cb();
    assert(protocolHandlers.has("vencord"), "vencord:// protocol handler was not registered");
    assert.strictEqual(typeof headersReceivedCb, "function", "CSP onHeadersReceived handler was not registered");

    let cspResult = null;
    headersReceivedCb(
        {
            resourceType: "mainFrame",
            url: "https://discord.com/app",
            responseHeaders: { "content-security-policy": ["default-src 'self'; style-src 'self'"] }
        },
        res => { cspResult = res; }
    );
    assert(cspResult && cspResult.responseHeaders["content-security-policy"][0].includes("vencord:"), "CSP rewrite failed");

    // 2. Boot preload.js wired to live ipcMain
    global.location = { href: "https://discord.com/channels/@me" };
    require(path.join(sandboxDistDir, "preload.js"));

    assert(exposedInMainWorld.VencordNative, "preload.js did not expose VencordNative");
    assert.strictEqual(global.__discordStockPreloadLoaded, true, "preload.js did not chain-load DISCORD_PRELOAD");
    assert(executedRendererJs.length > 100000, "preload.js did not fetch & execute renderer.js via IPC");

    const VN = exposedInMainWorld.VencordNative;

    // 3. Test core IPC endpoints through VencordNative
    const repoRes = await VN.updater.getRepo();
    assert.deepStrictEqual(repoRes, { ok: true, value: "https://github.com/iMAboud/iMACord" });

    const plainSettings = VN.settings.get();
    assert.strictEqual(typeof plainSettings, "object");
    await VN.settings.set({ ...plainSettings, useQuickCss: true });

    const quickCss = await VN.quickCss.get();
    assert(quickCss.includes('div[role="separator"]'), "QuickCSS default separator rule missing");

    const themes = await VN.themes.getThemesList();
    assert(Array.isArray(themes));

    const sysValues = await VN.themes.getSystemValues();
    assert.strictEqual(typeof sysValues["os-accent-color"], "string");

    const userPlugins = await VN.userPlugins.getList();
    assert(Array.isArray(userPlugins));

    const rendererCss = await VN.native.getRendererCss();
    assert(rendererCss.length > 1000, "getRendererCss returned empty CSS");

    // 4. Mock GitHub manifest & test full self-update roundtrip + renderer.js initialization
    const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex").toLowerCase();
    const updatedCssBuf = Buffer.from(rendererCss + "\\n/* verified-update */\\n", "utf8");
    const newPluginBuf = Buffer.from("export default { name: 'VerifiedPlugin', description: 'test' };", "utf8");

    const mockManifest = {
        version: "v99.0.0-verify",
        updatedAt: new Date().toISOString(),
        dist: {
            "patcher.js": { hash: sha256(fs.readFileSync(path.join(sandboxDistDir, "patcher.js"))) },
            "preload.js": { hash: sha256(fs.readFileSync(path.join(sandboxDistDir, "preload.js"))) },
            "renderer.js": { hash: sha256(fs.readFileSync(path.join(sandboxDistDir, "renderer.js"))) },
            "renderer.css": {
                hash: sha256(updatedCssBuf),
                url: "https://github.com/iMAboud/iMACord/releases/latest/download/renderer.css"
            }
        },
        plugins: {
            "VerifiedPlugin.js": {
                hash: sha256(newPluginBuf),
                author: "iMAboud",
                commit: "abcdef1",
                message: "feat: verify updater",
                url: "https://raw.githubusercontent.com/iMAboud/iMACord/main/userplugins/VerifiedPlugin.js"
            }
        },
        removedPlugins: ["ObsoleteVerifyPlugin.js"]
    };

    const origFetch = global.fetch;
    global.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/manifest.json")) {
            return new Response(JSON.stringify(mockManifest), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/renderer.css")) {
            return new Response(updatedCssBuf, { status: 200 });
        }
        if (url.includes("/VerifiedPlugin.js")) {
            return new Response(newPluginBuf, { status: 200 });
        }
        return origFetch(input, init);
    };

    // 5. Boot renderer.js in a VM browser environment wired to live VencordNative
    const noop = () => {};
    const dummyEl = () => ({
        style: new Proxy({}, { get: () => "", set: () => true }),
        dataset: {},
        children: [],
        childNodes: [],
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        appendChild: el => el,
        append: noop,
        prepend: noop,
        insertBefore: el => el,
        replaceChildren: noop,
        removeChild: noop,
        remove: noop,
        contains: () => false,
        matches: () => false,
        closest: () => null,
        setAttribute: noop,
        removeAttribute: noop,
        getAttribute: () => null,
        hasAttribute: () => false,
        addEventListener: noop,
        removeEventListener: noop,
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementsByClassName: () => [],
        getElementsByTagName: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        attachShadow: () => dummyEl(),
        cloneNode: () => dummyEl(),
        getContext: () => ({
            fillRect: noop,
            clearRect: noop,
            drawImage: noop,
            fillText: noop,
            measureText: () => ({ width: 0 }),
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
            putImageData: noop,
            createLinearGradient: () => ({ addColorStop: noop }),
            beginPath: noop,
            arc: noop,
            fill: noop,
            stroke: noop,
            save: noop,
            restore: noop,
            scale: noop,
            translate: noop
        }),
        toDataURL: () => "data:image/png;base64,",
        sheet: { insertRule: () => 0, deleteRule: noop, cssRules: [] },
        textContent: "",
        innerHTML: ""
    });

    const storageMap = new Map();
    const localStorageMock = {
        getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: k => storageMap.delete(k),
        clear: () => storageMap.clear()
    };

    class MockIDBRequest {
        constructor(resultValue) {
            this.result = resultValue;
            this.error = null;
            this.readyState = "done";
            this._listeners = {};
            Promise.resolve().then(() => {
                const ev = { target: this };
                if (typeof this.onsuccess === "function") this.onsuccess(ev);
                for (const fn of this._listeners.success || []) fn(ev);
            });
        }
        addEventListener(type, fn) {
            (this._listeners[type] ||= []).push(fn);
        }
        removeEventListener() {}
    }

    const mockStore = {
        get: () => new MockIDBRequest(undefined),
        put: () => new MockIDBRequest(undefined),
        delete: () => new MockIDBRequest(undefined),
        clear: () => new MockIDBRequest(undefined),
        getAllKeys: () => new MockIDBRequest([]),
        getAll: () => new MockIDBRequest([]),
        count: () => new MockIDBRequest(0),
        createIndex: () => ({}),
        index: () => ({ getAll: () => new MockIDBRequest([]), getAllKeys: () => new MockIDBRequest([]) })
    };
    const mockDb = {
        objectStoreNames: { contains: () => true, length: 0 },
        createObjectStore: () => mockStore,
        close: noop,
        addEventListener: noop,
        transaction: () => {
            const tx = {
                objectStore: () => mockStore,
                addEventListener: (type, fn) => { if (type === "complete") Promise.resolve().then(() => fn({ target: tx })); },
                removeEventListener: noop
            };
            Promise.resolve().then(() => { if (typeof tx.oncomplete === "function") tx.oncomplete({ target: tx }); });
            return tx;
        }
    };

    const win = {
        VencordNative: VN,
        location: { href: "https://discord.com/channels/@me", hostname: "discord.com", origin: "https://discord.com", protocol: "https:", pathname: "/channels/@me", search: "" },
        navigator: { userAgent: "Mozilla/5.0 Chrome/134.0.0.0 Electron/34.0.0", platform: "Win32", language: "en-US", languages: ["en-US"], mediaDevices: { addEventListener: noop } },
        document: {
            documentElement: dummyEl(),
            head: dummyEl(),
            body: dummyEl(),
            createElement: dummyEl,
            createElementNS: dummyEl,
            createTextNode: () => dummyEl(),
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: noop,
            removeEventListener: noop,
            cookie: "",
            readyState: "loading"
        },
        localStorage: localStorageMock,
        sessionStorage: localStorageMock,
        indexedDB: { open: () => new MockIDBRequest(mockDb), deleteDatabase: () => new MockIDBRequest(undefined) },
        IDBRequest: MockIDBRequest,
        IDBOpenDBRequest: MockIDBRequest,
        IDBDatabase: class {},
        IDBTransaction: class {},
        IDBObjectStore: class {},
        IDBIndex: class {},
        IDBCursor: class {},
        IDBKeyRange: { bound: () => ({}), only: () => ({}), lowerBound: () => ({}), upperBound: () => ({}) },
        MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
        ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
        IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
        BroadcastChannel: class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} },
        CSSStyleSheet: class { replaceSync() {} replace() { return Promise.resolve(this); } insertRule() { return 0; } },
        DOMParser: class { parseFromString() { return { documentElement: dummyEl(), body: dummyEl(), head: dummyEl(), querySelector: () => null, querySelectorAll: () => [] }; } },
        Image: class {},
        Audio: class { play() { return Promise.resolve(); } pause() {} addEventListener() {} },
        Element: class {},
        HTMLElement: class {},
        HTMLStyleElement: class {},
        Node: class {},
        innerWidth: 1920,
        innerHeight: 1080,
        devicePixelRatio: 1,
        CustomEvent: CustomEvent,
        Event: Event,
        EventTarget: EventTarget,
        URL: URL,
        URLSearchParams: URLSearchParams,
        Headers: Headers,
        Request: Request,
        Response: Response,
        Blob: Blob,
        File: File,
        ReadableStream: ReadableStream,
        WritableStream: WritableStream,
        TransformStream: TransformStream,
        CompressionStream: CompressionStream,
        DecompressionStream: DecompressionStream,
        DOMException: DOMException,
        MessageChannel: MessageChannel,
        MessagePort: MessagePort,
        WebSocket: globalThis.WebSocket || class {},
        Worker: class { postMessage() {} terminate() {} addEventListener() {} },
        performance: performance,
        atob: atob,
        btoa: btoa,
        structuredClone: structuredClone,
        FormData: FormData,
        AbortController: AbortController,
        AbortSignal: AbortSignal,
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        crypto: crypto.webcrypto,
        fetch: (...a) => global.fetch(...a),
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval,
        queueMicrotask,
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: noop,
        matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }),
        getComputedStyle: () => new Proxy({}, { get: () => "" }),
        addEventListener: noop,
        removeEventListener: noop,
        dispatchEvent: () => true,
        postMessage: noop,
        webpackChunkdiscord_app: [],
        console
    };
    win.window = win;
    win.globalThis = win;
    win.self = win;
    win.top = win;
    win.parent = win;

    vm.runInNewContext(executedRendererJs, win, { filename: "renderer.js" });

    assert(win.Vencord, "renderer.js did not initialize window.Vencord");
    assert(win.Vencord.Plugins && Object.keys(win.Vencord.Plugins.plugins).length > 100, "Plugins registry failed to populate");
    assert(win.Vencord.Updater, "Vencord.Updater missing");

    // 6. Execute Vencord.Updater.checkForUpdates() + Vencord.Updater.update() end-to-end!
    const hasUpdate = await win.Vencord.Updater.checkForUpdates();
    assert.strictEqual(hasUpdate, true, "Updater failed to detect pending core/plugin/removal updates");
    assert.strictEqual(win.Vencord.Updater.changes.length, 3, "Expected 3 change entries (1 core, 1 new plugin, 1 removed plugin)");

    const applied = await win.Vencord.Updater.update();
    assert.strictEqual(applied, true, "Updater failed to apply updates");

    assert.strictEqual(
        sha256(fs.readFileSync(path.join(sandboxDistDir, "renderer.css"))),
        sha256(updatedCssBuf),
        "Updated renderer.css hash mismatch on disk"
    );
    assert.strictEqual(
        sha256(fs.readFileSync(path.join(sandboxPluginsDir, "VerifiedPlugin.js"))),
        sha256(newPluginBuf),
        "Updated VerifiedPlugin.js hash mismatch on disk"
    );
    assert.strictEqual(
        fs.existsSync(path.join(sandboxPluginsDir, "ObsoleteVerifyPlugin.js")),
        false,
        "ObsoleteVerifyPlugin.js was not removed by updater"
    );

    // Second check should now report up-to-date
    const secondCheck = await win.Vencord.Updater.checkForUpdates();
    assert.strictEqual(secondCheck, false, "Updater still reported outdated after applying updates");

    // Also test Tray Menu 'Update Vencord' click handler when up-to-date
    const updateMenuItem = vencordMenu.submenu.find(i => i.label === "Update Vencord");
    assert(updateMenuItem && typeof updateMenuItem.click === "function", "Tray Update Vencord item missing");
    await updateMenuItem.click({}, null);
    assert(dialogCalls.some(d => d.title === "No Update Available"), "Tray Update Vencord click failed");

    assert.strictEqual(unhandledError, null);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    console.log("Patched main, preload, renderer (" + Object.keys(win.Vencord.Plugins.plugins).length + " plugins), IPC, and live updater roundtrip verified!");
    process.exit(0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
`;

    runIsolatedNodeScript("Desktop-E2E", harness);

    // Also verify vencordDesktopMain.js boots cleanly
    const vesktopHarness = `
"use strict";
const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "imcord-vesktop-test-"));
process.env.VENCORD_USER_DATA_DIR = sandboxRoot;
const handlers = new Map();
const electronMock = {
    app: { getPath: () => sandboxRoot, whenReady: () => ({ then: () => Promise.resolve() }), on: () => {} },
    ipcMain: {
        handle: (ch, fn) => {
            assert(typeof ch === "string" && ch.length > 0, "Invalid Vesktop IPC channel");
            assert(!handlers.has(ch), "Duplicate Vesktop IPC channel: " + ch);
            handlers.set(ch, fn);
        },
        on: () => {}
    },
    BrowserWindow: class { static getAllWindows() { return []; } },
    protocol: { handle: () => {} },
    session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
    net: { fetch: global.fetch },
    dialog: {},
    shell: {},
    nativeTheme: { shouldUseDarkColors: true },
    systemPreferences: {},
    webFrameMain: { fromId: () => null }
};
const origLoad = Module._load;
Module._load = function(req) {
    if (req === "electron" || req === "electron/main") return electronMock;
    if (req === "original-fs") return fs;
    return origLoad.apply(this, arguments);
};
require(${JSON.stringify(path.join(distDir, "vencordDesktopMain.js"))});
(async () => {
    const repo = await handlers.get("VencordGetRepo")();
    assert.deepStrictEqual(repo, { ok: true, value: "https://github.com/iMAboud/iMACord" });
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    console.log("Vesktop main bundle & IPC handlers verified!");
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
`;

    runIsolatedNodeScript("Vesktop-Main", vesktopHarness);
}

async function verifyReleaseArtifactsAndInstaller() {
    step("4. Release Manifest & Standalone Installer Sandbox E2E");

    const manifestPath = path.join(userpluginsDir, "manifest.json");
    assert(fs.existsSync(manifestPath), "Missing userplugins/manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    for (const file of ["patcher.js", "preload.js", "renderer.js", "renderer.css"]) {
        const entry = manifest.dist?.[file];
        assert(entry?.hash, `manifest.json missing dist.${file}.hash`);
        const buf = fs.readFileSync(path.join(distDir, file));
        assert(entry.hash.toLowerCase() === sha256(buf), `manifest.json hash mismatch for dist/${file}`);
        assert(entry.size === buf.length, `manifest.json size mismatch for dist/${file}`);
    }

    for (const [pluginFile, entry] of Object.entries(manifest.plugins ?? {})) {
        const full = path.join(userpluginsDir, pluginFile);
        assert(fs.existsSync(full), `manifest.json references missing plugin: ${pluginFile}`);
        const buf = fs.readFileSync(full);
        assert(entry.hash.toLowerCase() === sha256(buf), `manifest.json hash mismatch for userplugins/${pluginFile}`);
    }
    console.log("  [OK] manifest.json SHA-256 & byte-size integrity verified.");

    if (process.platform !== "win32") {
        console.log("  [SKIP] Skipping Windows .exe sandbox execution on non-Windows host.");
        return;
    }

    const cliExe = path.join(rootDir, "iMCordCLI.exe");
    const guiExe = path.join(rootDir, "iMCord.exe");
    assert(fs.existsSync(cliExe), "Missing compiled iMCordCLI.exe");
    assert(fs.existsSync(guiExe), "Missing compiled iMCord.exe");

    if (manifest.installer?.cli?.hash) {
        assert(
            manifest.installer.cli.hash.toLowerCase() === sha256(fs.readFileSync(cliExe)),
            "manifest.json installer.cli.hash mismatch"
        );
    }
    if (manifest.installer?.gui?.hash) {
        assert(
            manifest.installer.gui.hash.toLowerCase() === sha256(fs.readFileSync(guiExe)),
            "manifest.json installer.gui.hash mismatch"
        );
    }

    const verOut = execFileSync(cliExe, ["--version"], { encoding: "utf8", timeout: 15_000 });
    assert(verOut.includes("iMCord Installer CLI"), `Unexpected iMCordCLI.exe --version output: ${verOut}`);

    // Spin up loopback HTTP server to test iMCordCLI delta sync + sandbox Discord install + ASAR patch + uninstall
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "imcord-cli-sandbox-"));
    const fakeDiscordBase = path.join(testRoot, "Discord");
    const fakeResources = path.join(fakeDiscordBase, "app-1.0.9999", "resources");
    fs.mkdirSync(fakeResources, { recursive: true });
    const stockAsarBytes = Buffer.from("STOCK_DISCORD_ASAR_PAYLOAD", "utf8");
    fs.writeFileSync(path.join(fakeResources, "app.asar"), stockAsarBytes);

    const deltaPluginContent = Buffer.from("// loopback delta plugin test\nexport default {};\n", "utf8");
    const deltaPluginHash = sha256(deltaPluginContent);

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname === "/manifest.json") {
            const port = server.address().port;
            const base = `http://127.0.0.1:${port}/files`;
            const body = JSON.stringify({
                ...manifest,
                version: "v99.99.99",
                dist: Object.fromEntries(
                    Object.entries(manifest.dist).map(([k, v]) => [k, { ...v, url: `${base}/dist/${encodeURIComponent(k)}` }])
                ),
                plugins: {
                    ...Object.fromEntries(
                        Object.entries(manifest.plugins ?? {}).map(([k, v]) => [k, { ...v, url: `${base}/plugins/${encodeURIComponent(k)}` }])
                    ),
                    "LoopbackDeltaTest.js": {
                        hash: deltaPluginHash,
                        size: deltaPluginContent.length,
                        url: `${base}/plugins/LoopbackDeltaTest.js`
                    }
                }
            });
            res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
            res.end(body);
            return;
        }
        if (u.pathname === "/files/plugins/LoopbackDeltaTest.js") {
            res.writeHead(200, { "content-type": "application/javascript", "content-length": deltaPluginContent.length });
            res.end(deltaPluginContent);
            return;
        }
        if (u.pathname.startsWith("/files/dist/")) {
            const name = decodeURIComponent(u.pathname.slice("/files/dist/".length));
            const p = path.join(distDir, path.basename(name));
            if (fs.existsSync(p)) {
                res.writeHead(200);
                res.end(fs.readFileSync(p));
                return;
            }
        }
        if (u.pathname.startsWith("/files/plugins/")) {
            const name = decodeURIComponent(u.pathname.slice("/files/plugins/".length));
            const p = path.join(userpluginsDir, path.basename(name));
            if (fs.existsSync(p)) {
                res.writeHead(200);
                res.end(fs.readFileSync(p));
                return;
            }
        }
        res.writeHead(404);
        res.end("Not found");
    });

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
        const testEnv = {
            ...process.env,
            IMCORD_MANIFEST_URL: `http://127.0.0.1:${port}/manifest.json`,
            IMCORD_TEST_DIR: testRoot
        };

        const { stdout: cliOut } = await execFileAsync(cliExe, ["--no-self-update", "--location", fakeDiscordBase, "--install"], {
            env: testEnv,
            encoding: "utf8",
            timeout: 30_000
        });
        if (!fs.existsSync(path.join(testRoot, "AppData_Vencord", "userplugins", "LoopbackDeltaTest.js"))) {
            console.error("CLI install output:\n" + cliOut);
        }

        const backupAsar = path.join(fakeResources, "_app.asar");
        const patchedAsar = path.join(fakeResources, "app.asar");
        assert(fs.existsSync(backupAsar), "Installer did not create _app.asar backup");
        assert(fs.readFileSync(backupAsar).equals(stockAsarBytes), "_app.asar backup bytes corrupted");
        assert(fs.existsSync(patchedAsar), "Installer did not write patched app.asar");

        const deployedVencord = path.join(testRoot, "AppData_Vencord");
        const deployedPatcher = path.join(deployedVencord, "dist", "patcher.js");
        const deployedDeltaPlugin = path.join(deployedVencord, "userplugins", "LoopbackDeltaTest.js");
        assert(fs.existsSync(deployedPatcher), "Installer did not deploy dist/patcher.js");
        assert(
            sha256(fs.readFileSync(deployedPatcher)) === manifest.dist["patcher.js"].hash.toLowerCase(),
            "Deployed patcher.js hash mismatch"
        );
        assert(
            fs.existsSync(deployedDeltaPlugin) && sha256(fs.readFileSync(deployedDeltaPlugin)) === deltaPluginHash,
            "Installer failed Tier-2 loopback delta plugin sync"
        );

        const asarRaw = fs.readFileSync(patchedAsar, "utf8");
        assert(asarRaw.includes("patcher.js"), "Patched app.asar does not reference patcher.js");

        await execFileAsync(cliExe, ["--no-update", "--location", fakeDiscordBase, "--uninstall"], {
            env: testEnv,
            encoding: "utf8",
            timeout: 15_000
        });
        assert(!fs.existsSync(backupAsar), "Uninstall did not restore _app.asar");
        assert(fs.readFileSync(patchedAsar).equals(stockAsarBytes), "Uninstall did not restore original app.asar");

        console.log("  [OK] iMCordCLI.exe loopback delta sync, ASAR patch, and uninstall verified in sandbox.");
    } finally {
        server.close();
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
}

async function main() {
    const t0 = Date.now();
    if (!onlyRelease) {
        verifyTypeScriptContracts();
        verifyBundlesAndSyntax();
        verifyMainPreloadRendererAndUpdater();
    }
    if (verifyRelease) {
        await verifyReleaseArtifactsAndInstaller();
    }
    console.log(`\n[SUCCESS] All verification gates passed in ${((Date.now() - t0) / 1000).toFixed(2)}s!`);
}

main().catch(err => {
    console.error(`\n${err.stack || err.message || err}`);
    process.exit(1);
});

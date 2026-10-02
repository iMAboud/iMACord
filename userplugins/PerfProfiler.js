import definePlugin, { StartAt } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

export default definePlugin({
    name: "PerfProfiler",
    description: "Deep 30s performance profiler. Press F8, Cmd/Ctrl+Shift+K, or click notice to run.",
    authors: [
        {
            name: "Performance Monitor",
            id: 0n
        }
    ],
    startAt: StartAt.WebpackReady,
    enabledByDefault: true,

    start() {
        this.isScanning = false;
        this.fluxStats = new Map();
        this.longTasks = [];
        this.frameDeltas = [];
        this.fpsSamples = [];
        this.domMutationsCount = 0;
        this.userInteractionsCount = 0;
        this.lastAction = { type: "NONE", time: 0 };
        this.lastInteraction = { type: "NONE", time: 0 };

        // 1. Safe Dispatcher Hook (Guards against ReferenceError)
        const dispatcher = (typeof FluxDispatcher !== "undefined" && FluxDispatcher)
            || window.Vencord?.Webpack?.Common?.FluxDispatcher;

        if (dispatcher && typeof dispatcher.dispatch === "function") {
            try {
                const original = dispatcher.dispatch.bind(dispatcher);
                this.origDispatch = dispatcher.dispatch;
                this.dispatcherInstance = dispatcher;
                const stats = this.fluxStats;
                const self = this;

                dispatcher.dispatch = function (action) {
                    const type = action?.type || "UNKNOWN_ACTION";
                    const now = performance.now();
                    self.lastAction = { type, time: now };

                    const res = original(action);
                    const duration = performance.now() - now;

                    const entry = stats.get(type) || { count: 0, totalTime: 0, maxTime: 0 };
                    entry.count++;
                    entry.totalTime += duration;
                    if (duration > entry.maxTime) {
                        entry.maxTime = duration;
                    }
                    stats.set(type, entry);

                    return res;
                };
            } catch (e) {
                console.warn("[PerfProfiler] Dispatcher could not be hooked:", e);
            }
        }

        // 2. Long Task Observer with Root-Cause Action Attribution
        if (typeof PerformanceObserver !== "undefined") {
            try {
                this.longTaskObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        this.longTasks.push({
                            durationMs: Math.round(entry.duration * 100) / 100,
                            startTime: Math.round(entry.startTime),
                            correlatedAction: this.lastAction.type,
                            correlatedInteraction: this.lastInteraction.type,
                            msSinceLastAction: Math.round(performance.now() - this.lastAction.time)
                        });
                    }
                });
                this.longTaskObserver.observe({ entryTypes: ["longtask"] });
            } catch (e) {
                console.warn("[PerfProfiler] LongTask observer error:", e);
            }
        }

        // 3. User Interaction Tracker (to correlate freezes to clicks/scrolls)
        this.onUserEvent = (e) => {
            if (!this.isScanning) return;
            this.userInteractionsCount++;
            this.lastInteraction = {
                type: e.type,
                time: performance.now()
            };
        };

        window.addEventListener("click", this.onUserEvent, true);
        window.addEventListener("scroll", this.onUserEvent, true);

        // 4. Keydown Listener in Capture Phase
        this.onKeyDown = (e) => {
            const isF8 = e.key === "F8";
            const isKCombo = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "K" || e.key === "k");

            if (isF8 || isKCombo) {
                e.preventDefault();
                e.stopPropagation();
                this.startDiagnosticSession(30);
            }
        };

        window.addEventListener("keydown", this.onKeyDown, true);
        window.startDiscordPerfScan = () => this.startDiagnosticSession(30);

        // 5. Visual Notification (Clickable)
        this.showStartupNotice();
    },

    stop() {
        this.stopDiagnosticSession();

        if (this.origDispatch && this.dispatcherInstance) {
            this.dispatcherInstance.dispatch = this.origDispatch;
            this.origDispatch = null;
            this.dispatcherInstance = null;
        }

        if (this.longTaskObserver) {
            this.longTaskObserver.disconnect();
            this.longTaskObserver = null;
        }

        if (this.onKeyDown) {
            window.removeEventListener("keydown", this.onKeyDown, true);
            this.onKeyDown = null;
        }

        window.removeEventListener("click", this.onUserEvent, true);
        window.removeEventListener("scroll", this.onUserEvent, true);

        delete window.startDiscordPerfScan;
        this.removeHud();
    },

    startDiagnosticSession(durationSeconds) {
        if (this.isScanning) return;

        this.isScanning = true;
        this.fluxStats.clear();
        this.longTasks = [];
        this.frameDeltas = [];
        this.fpsSamples = [];
        this.domMutationsCount = 0;
        this.userInteractionsCount = 0;

        const initialMemory = performance.memory
            ? {
                  usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / (1024 * 1024)),
                  totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / (1024 * 1024))
              }
            : null;

        // Monitor DOM churn
        this.mutationObserver = new MutationObserver((mutations) => {
            this.domMutationsCount += mutations.length;
        });
        this.mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: false });

        // Frame rate sampler
        let framesThisSecond = 0;
        let lastSecondTime = performance.now();
        let lastFrameTime = performance.now();
        let runningFps = 60;

        const fpsLoop = (now) => {
            const delta = now - lastFrameTime;
            this.frameDeltas.push(delta);
            lastFrameTime = now;

            framesThisSecond++;
            if (now - lastSecondTime >= 1000) {
                runningFps = framesThisSecond;
                this.fpsSamples.push(runningFps);
                framesThisSecond = 0;
                lastSecondTime = now;
            }

            if (this.isScanning) {
                this.fpsRaf = requestAnimationFrame(fpsLoop);
            }
        };
        this.fpsRaf = requestAnimationFrame(fpsLoop);

        this.createHud();
        let remaining = durationSeconds;
        this.updateHud(remaining, runningFps, this.longTasks.length);

        this.scanInterval = setInterval(() => {
            remaining--;
            this.updateHud(remaining, runningFps, this.longTasks.length);

            if (remaining <= 0) {
                clearInterval(this.scanInterval);
                this.scanInterval = null;
                this.finishDiagnosticSession(initialMemory, durationSeconds);
            }
        }, 1000);
    },

    stopDiagnosticSession() {
        this.isScanning = false;
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
        if (this.fpsRaf) {
            cancelAnimationFrame(this.fpsRaf);
            this.fpsRaf = null;
        }
        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }
    },

    finishDiagnosticSession(initialMemory, durationSeconds) {
        this.stopDiagnosticSession();
        this.setHudComplete();

        // 1. Calculate FPS & Frame Jitter Distribution
        const avgFps = this.fpsSamples.length > 0
            ? Math.round(this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length)
            : 60;
        const minFps = this.fpsSamples.length > 0 ? Math.min(...this.fpsSamples) : 60;

        const sortedDeltas = [...this.frameDeltas].sort((a, b) => a - b);
        const p99FrameTime = sortedDeltas[Math.floor(sortedDeltas.length * 0.99)] || 16.6;
        const onePercentLowFps = p99FrameTime > 0 ? Math.round(1000 / p99FrameTime) : avgFps;

        let framesUnder16ms = 0;
        let frames16to33ms = 0;
        let frames33to66ms = 0;
        let framesOver66ms = 0;

        for (const d of this.frameDeltas) {
            if (d <= 16.7) framesUnder16ms++;
            else if (d <= 33.3) frames16to33ms++;
            else if (d <= 66.6) frames33to66ms++;
            else framesOver66ms++;
        }

        // 2. Hardware and GPU Inspection
        let gpuInfo = "Unavailable";
        try {
            const canvas = document.createElement("canvas");
            const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
            if (gl) {
                const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
                gpuInfo = debugInfo
                    ? {
                          vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
                          renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
                      }
                    : { renderer: gl.getParameter(gl.RENDERER) };
            }
        } catch (e) {
            gpuInfo = "Error querying WebGL";
        }

        // 3. Memory Delta
        const endMemory = performance.memory
            ? {
                  usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / (1024 * 1024)),
                  totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / (1024 * 1024)),
                  heapLimitMB: Math.round(performance.memory.jsHeapSizeLimit / (1024 * 1024))
              }
            : null;

        const memoryGrowthMB = initialMemory && endMemory
            ? endMemory.usedJSHeapMB - initialMemory.usedJSHeapMB
            : 0;

        // 4. DOM Architecture & Depth Analysis
        const totalDomElements = document.querySelectorAll("*").length;
        const maxNestingDepth = this.computeMaxDomDepth(document.body);
        const svgCount = document.querySelectorAll("svg").length;
        const imgCount = document.querySelectorAll("img").length;
        const canvasCount = document.querySelectorAll("canvas").length;
        const styleTagsCount = document.querySelectorAll("style, link[rel='stylesheet']").length;
        const chatMessages = document.querySelectorAll("[data-list-id='chat-messages'] [id^='chat-messages-']").length;

        // 5. Reflow / Forced Style Recalculation Benchmark
        const reflowTimeMs = this.benchmarkLayoutReflow();

        // 6. Flux Store Bottlenecks
        const sortedFlux = Array.from(this.fluxStats.entries())
            .map(([type, data]) => ({
                action: type,
                dispatches: data.count,
                totalTimeMs: Math.round(data.totalTime * 100) / 100,
                avgTimeMs: Math.round((data.totalTime / data.count) * 100) / 100,
                maxSingleLagMs: Math.round(data.maxTime * 100) / 100
            }))
            .sort((a, b) => b.totalTimeMs - a.totalTimeMs);

        // 7. Compile Diagnostic Report
        const report = {
            metadata: {
                timestamp: new Date().toISOString(),
                durationTestedSeconds: durationSeconds,
                discordBuild: window.GLOBAL_ENV?.RELEASE_CHANNEL || "unknown",
                userAgent: navigator.userAgent
            },
            systemAndHardware: {
                logicalCpuCores: navigator.hardwareConcurrency || "unknown",
                deviceMemoryEstimateGB: navigator.deviceMemory || "unknown",
                screenResolution: `${window.screen.width}x${window.screen.height} (Scale: ${window.devicePixelRatio}x)`,
                gpuInfo
            },
            performanceSummary: {
                averageFPS: avgFps,
                lowestDropFPS: minFps,
                onePercentLowFPS: onePercentLowFps,
                totalFreezesLongTasks: this.longTasks.length,
                totalFreezeTimeMs: Math.round(this.longTasks.reduce((acc, t) => acc + t.durationMs, 0)),
                domMutationsDuringSession: this.domMutationsCount,
                userInteractionsLogged: this.userInteractionsCount,
                heapMemoryGrowthMB: memoryGrowthMB
            },
            frameTimingBuckets: {
                smoothFramesUnder16ms: framesUnder16ms,
                droppedFrames16to33ms: frames16to33ms,
                stutterFrames33to66ms: frames33to66ms,
                severeStallFramesOver66ms: framesOver66ms
            },
            domArchitecture: {
                totalElements: totalDomElements,
                maximumNestingDepth: maxNestingDepth,
                renderedChatMessages: chatMessages,
                svgIconCount: svgCount,
                renderedImagesAvatars: imgCount,
                activeCanvasElements: canvasCount,
                injectedStyleSheets: styleTagsCount,
                forcedLayoutRecalculationCostMs: reflowTimeMs
            },
            memoryStatus: {
                start: initialMemory,
                end: endMemory
            },
            freezesWithRootCauseAttribution: this.longTasks,
            topSlowestFluxActions: sortedFlux.slice(0, 15)
        };

        this.downloadReport(report);

        setTimeout(() => {
            this.removeHud();
        }, 4000);
    },

    computeMaxDomDepth(root) {
        let max = 0;
        const queue = [{ node: root, depth: 1 }];

        while (queue.length > 0) {
            const { node, depth } = queue.shift();
            if (depth > max) max = depth;

            for (let i = 0; i < node.children.length; i++) {
                queue.push({ node: node.children[i], depth: depth + 1 });
            }
        }
        return max;
    },

    benchmarkLayoutReflow() {
        const start = performance.now();
        const target = document.getElementById("app-mount") || document.body;
        const _ = target.offsetHeight;
        return Math.round((performance.now() - start) * 100) / 100;
    },

    downloadReport(report) {
        const jsonStr = JSON.stringify(report, null, 2);
        const filename = `discord-perf-${Date.now()}.json`;

        if (window.DiscordNative?.fileManager?.saveFile) {
            try {
                const buffer = new TextEncoder().encode(jsonStr);
                window.DiscordNative.fileManager.saveFile(buffer, filename);
                return;
            } catch (err) {}
        }

        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    showStartupNotice() {
        const notice = document.createElement("div");
        notice.id = "perf-profiler-startup-notice";
        notice.style.position = "fixed";
        notice.style.bottom = "20px";
        notice.style.right = "20px";
        notice.style.backgroundColor = "#5865F2";
        notice.style.color = "#FFFFFF";
        notice.style.padding = "12px 16px";
        notice.style.borderRadius = "8px";
        notice.style.fontSize = "13px";
        notice.style.fontFamily = "sans-serif";
        notice.style.zIndex = "999999";
        notice.style.cursor = "pointer";
        notice.style.boxShadow = "0 4px 15px rgba(0,0,0,0.5)";
        notice.innerHTML = "⚡ <b>PerfProfiler Active</b><br><span style='font-size:11px;opacity:0.9;'>Press <b>F8</b> or click this popup to scan</span>";

        notice.onclick = () => {
            this.startDiagnosticSession(30);
            notice.remove();
        };

        document.body.appendChild(notice);

        setTimeout(() => {
            notice.remove();
        }, 6000);
    },

    createHud() {
        this.removeHud();
        const hud = document.createElement("div");
        hud.id = "perf-profiler-hud";
        hud.style.position = "fixed";
        hud.style.top = "20px";
        hud.style.right = "20px";
        hud.style.backgroundColor = "rgba(18, 18, 24, 0.95)";
        hud.style.border = "1px solid #5865F2";
        hud.style.borderRadius = "8px";
        hud.style.padding = "12px 18px";
        hud.style.color = "#FFFFFF";
        hud.style.fontFamily = "sans-serif";
        hud.style.fontSize = "13px";
        hud.style.zIndex = "999999";
        hud.style.boxShadow = "0 6px 20px rgba(0, 0, 0, 0.6)";
        hud.style.pointerEvents = "none";
        hud.innerText = "Starting benchmark...";
        document.body.appendChild(hud);
    },

    updateHud(remainingSec, fps, freezeCount) {
        const hud = document.getElementById("perf-profiler-hud");
        if (hud) {
            hud.innerHTML = `
                <div style="font-weight: bold; color: #5865F2; margin-bottom: 4px;">🔍 Deep Performance Benchmark</div>
                <div>Time Left: <b>${remainingSec}s</b></div>
                <div>Live FPS: <b>${fps}</b> | Freezes (>50ms): <b>${freezeCount}</b></div>
            `;
        }
    },

    setHudComplete() {
        const hud = document.getElementById("perf-profiler-hud");
        if (hud) {
            hud.style.borderColor = "#57F287";
            hud.innerHTML = `
                <div style="font-weight: bold; color: #57F287; margin-bottom: 2px;">✅ Diagnostic Completed</div>
                <div>Auto-exporting performance log file...</div>
            `;
        }
    },

    removeHud() {
        const hud = document.getElementById("perf-profiler-hud");
        if (hud) hud.remove();
    }
});
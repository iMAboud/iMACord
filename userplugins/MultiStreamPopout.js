import { definePlugin } from "@utils/types";
import { findByProps } from "@webpack";
import { React } from "@webpack/common";

let popoutWindows = [];

function popoutStream(streamKey) {
    const PopoutModule = findByProps("openPopout", "popOut") || findByProps("openPopout");
    const StreamStore = findByProps("getStreamerActiveStreamBaseKey", "getActiveStreamForUser")
        || findByProps("getAllActiveStreams");

    if (!streamKey) {
        const activeStream = StreamStore?.getAllActiveStreams?.()?.[0];
        if (activeStream) {
            streamKey = `${activeStream.streamType}:${activeStream.guildId}:${activeStream.channelId}:${activeStream.ownerId}`;
        }
    }

    if (PopoutModule && streamKey) {
        const windowKey = `DISCORD_STREAM_POPOUT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        
        PopoutModule.openPopout(
            windowKey,
            (props) => {
                const StreamComponent = findByProps("StreamPopout", "default")?.default
                    || findByProps("ApplicationStreamViewer")?.default
                    || findByProps("StreamPopout")?.StreamPopout;
                if (StreamComponent) {
                    return React.createElement(StreamComponent, { ...props, streamKey: streamKey });
                }
                return null;
            },
            {
                withTitleBar: true,
                windowKey: windowKey
            }
        );
        
        popoutWindows.push(windowKey);
    }
}

export default definePlugin({
    name: "MultiStreamPopout",
    description: "تفعيل فتح أكثر من بث/شير (Stream Popout) في نوافذ منفصلة بوقت واحد 📺✨",
    authors: [{ name: "MBdr" }],
    start() {
        this.handleKeyDown = this.handleKeyDown.bind(this);
        window.addEventListener("keydown", this.handleKeyDown);
    },
    stop() {
        window.removeEventListener("keydown", this.handleKeyDown);
        popoutWindows = [];
    },
    handleKeyDown(e) {
        // Ctrl + Shift + S لفتح البث الحالي في نافذة منفصلة جديدة
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
            popoutStream();
        }
    }
});
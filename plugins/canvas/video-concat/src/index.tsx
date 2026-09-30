// 视频拼接节点:把上游视频节点按顺序首尾相接成一个视频。
// 拼接采用 canvas 重绘 + MediaRecorder 录制(零依赖):各段视频实时播放,
// 画面 contain 居中绘到同一画布,音频经 AudioContext 汇成一条音轨,输出 mp4/webm。
// 结果 Blob 存进插件 storage(localforage),刷新后自动恢复为可播放的 blob URL。
//
// v2.0:帧级剪辑 —— 每段可展开帧级修剪台:胶片条 + 可拖拽入/出点手柄 + 帧步进
// (1/30s)+ 播放头逐帧预览 + I/O 快捷键,时间码精确到帧;保留收集、排序、进度反馈。
import { definePlugin, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodeData, CanvasNodePanelProps } from "@infinite-canvas/plugin-sdk";

// 帧率假设:AI 生成视频普遍 24/30fps,统一按 30fps 步进与显示,误差不超过半帧
const FPS = 30;
const FRAME = 1 / FPS;
// 每段裁剪:留空表示整段;start/end 单位秒。
type Trim = { start?: number; end?: number };

// 面板排序与裁剪的持久化形态(storage key: `segments:${nodeId}`)。
type SegmentState = { order: string[]; trims: Record<string, Trim> };

// 拼接耗时 ≈ 裁剪后各段总时长(画面边播边录);要突破实时速度需 WebCodecs 依赖链,等真的等不起再加。
type ProbeResult = { width: number; height: number; duration: number };

async function probeVideo(url: string): Promise<ProbeResult> {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("上游视频加载失败"));
        });
        return { width: video.videoWidth || 640, height: video.videoHeight || 360, duration: video.duration || 0 };
    } finally {
        video.removeAttribute("src");
    }
}

// 抓取视频均匀分布的多帧缩略图(胶片带);失败返回空数组由调用方降级为色块。
async function captureFrames(url: string, count: number): Promise<string[]> {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error("frames failed"));
        });
        const duration = video.duration || 0;
        if (!duration || !video.videoWidth) return [];
        const frames: string[] = [];
        for (let index = 0; index < count; index++) {
            video.currentTime = ((index + 0.5) / count) * duration; // 避开首尾黑屏
            await new Promise<void>((resolve) => {
                video.onseeked = () => resolve();
                setTimeout(resolve, 1500); // seek 卡死兜底,用当前帧
            });
            const canvas = document.createElement("canvas");
            const scale = Math.min(120 / video.videoWidth, 68 / video.videoHeight);
            canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
            const ctx2d = canvas.getContext("2d");
            if (!ctx2d) continue;
            ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push(canvas.toDataURL("image/jpeg", 0.62));
        }
        return frames;
    } catch {
        return [];
    } finally {
        video.removeAttribute("src");
    }
}

// 顺序播放各段(应用裁剪),画面实时绘上画布、声音汇入音轨;返回录制结果。
// 录制器在首段就绪后才启动、下一段与当前播放并行预加载,避免预卷黑帧与段间空档。
async function concatVideos(
    items: Array<{ url: string; trim?: Trim }>,
    onProgress: (index: number, currentTime: number, segmentDuration: number) => void,
): Promise<{ blob: Blob; durationMs: number; width: number; height: number }> {
    const probed = await Promise.all(items.map((item) => probeVideo(item.url)));
    const width = Math.max(...probed.map((item) => item.width)) & ~1; // 偶数对齐,编码器友好
    const height = Math.max(...probed.map((item) => item.height)) & ~1;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) throw new Error("无法创建画布");

    const audioCtx = new AudioContext();
    // 自动播放策略下 AudioContext 初始为 suspended,媒体元素时钟会被拖住,必须显式恢复
    await audioCtx.resume().catch(() => undefined);
    const dest = audioCtx.createMediaStreamDestination();
    // 优先 mp4(外部兼容性好;Safari 仅支持 mp4,Chrome 126+ 支持),Firefox 等降级 webm。
    const mimeType = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("当前浏览器不支持视频录制");
    const stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
    });
    let recorderStarted = false;
    const startRecorder = () => {
        if (recorderStarted) return;
        recorderStarted = true;
        recorder.start(250);
    };

    // 加载单段并 seek 到入点;下一段在当前段播放期间并行执行,消除段间空档
    const prepareSegment = async (url: string, start: number) => {
        const video = document.createElement("video");
        video.src = url;
        video.playsInline = true;
        video.preload = "auto";
        const source = audioCtx.createMediaElementSource(video);
        source.connect(dest);
        await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error("上游视频加载失败"));
        });
        if (start > 0) {
            video.currentTime = start;
            await new Promise<void>((resolve) => {
                video.onseeked = () => resolve();
                setTimeout(resolve, 2000); // seek 卡死兜底
            });
        }
        return { video, source };
    };

    // 进度回调节流到 ~5 次/秒,避免拼接期间面板高频重渲染拖慢录制
    let lastReportAt = 0;
    const report = (index: number, currentTime: number, segmentDuration: number) => {
        const now = performance.now();
        if (currentTime > 0 && now - lastReportAt < 200) return;
        lastReportAt = now;
        onProgress(index, currentTime, segmentDuration);
    };

    const startedAt = performance.now();
    try {
        let prepared = await prepareSegment(items[0].url, Math.max(0, items[0].trim?.start ?? 0));
        for (let index = 0; index < items.length; index++) {
            const { trim } = items[index];
            const start = Math.max(0, trim?.start ?? 0);
            const end = trim?.end && trim.end > start ? trim.end : Infinity;
            const segmentDuration = Math.max(0, Math.min(end, probed[index].duration) - start);
            const { video, source } = prepared;
            const nextItem = items[index + 1];
            startRecorder();
            try {
                await video.play();
            } catch {
                video.muted = true; // 自动播放策略兜底:丢音保画面
                await video.play();
            }
            report(index, 0, segmentDuration);
            await new Promise<void>((resolve) => {
                // 段结束用媒体事件判定(ended/timeupdate),rAF 在后台窗口会被节流,不能作为退出依据
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    video.removeEventListener("ended", finish);
                    video.removeEventListener("timeupdate", onTimeUpdate);
                    resolve();
                };
                const onTimeUpdate = () => {
                    if (video.currentTime >= end) finish();
                };
                video.addEventListener("ended", finish);
                video.addEventListener("timeupdate", onTimeUpdate);
                const draw = () => {
                    if (done) return;
                    report(index, video.currentTime, segmentDuration);
                    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
                    const dw = video.videoWidth * scale;
                    const dh = video.videoHeight * scale;
                    ctx2d.fillStyle = "#000";
                    ctx2d.fillRect(0, 0, width, height);
                    ctx2d.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
                    requestAnimationFrame(draw);
                };
                draw();
            });
            video.pause();
            source.disconnect();
            video.removeAttribute("src");
            // 段间准备(加载并 seek 下一段)期间暂停录制,不计入成片时长
            if (recorderStarted && index < items.length - 1) recorder.pause();
            if (nextItem) prepared = await prepareSegment(nextItem.url, Math.max(0, nextItem.trim?.start ?? 0));
            if (recorderStarted && index < items.length - 1) recorder.resume();
        }
    } finally {
        recorder.stop();
        await stopped;
        stream.getTracks().forEach((track) => track.stop());
        await audioCtx.close();
    }
    return { blob: new Blob(chunks, { type: mimeType }), durationMs: performance.now() - startedAt, width, height };
}

// 上游可拼接判定:有内容且是视频(内置 video 节点或 mimeType 为 video/* 的插件节点)。
function isVideoNode(node: CanvasNodeData): boolean {
    const metadata = node.metadata;
    return Boolean(metadata?.content) && (node.type === "video" || String(metadata?.mimeType || "").startsWith("video/"));
}

// 剪辑工具时间码:mm:ss.ff,ff 为帧号(30fps),帧级编辑下对齐感与精度兼得。
function formatTimecode(seconds: number): string {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const secs = Math.floor(safe - minutes * 60);
    const frames = Math.round((safe - minutes * 60 - secs) * FPS);
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(Math.min(Math.max(frames, 0), FPS - 1)).padStart(2, "0")}`;
}

// 对齐到帧边界(1/30s)。
function snapFrame(seconds: number): number {
    return Math.round(seconds * FPS) / FPS;
}

// 跨域视频源(无 CORS 头)画布绘制会污染画布:缩略图 toDataURL 与拼接 captureStream 都会抛错,
// 部分源的时长元数据也不可靠。统一经宿主媒体代理取回字节转同源 blob URL,一并解决。
const blobUrlCache = new Map<string, Promise<string>>();
function normalizeClipUrl(url: string): Promise<string> {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return Promise.resolve(url);
    let entry = blobUrlCache.get(url);
    if (!entry) {
        entry = (async () => {
            try {
                const response = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
                if (!response.ok) throw new Error(String(response.status));
                const blob = await response.blob();
                if (!blob.size) throw new Error("empty");
                return URL.createObjectURL(blob);
            } catch {
                return url; // 代理失败退回原 URL
            }
        })();
        blobUrlCache.set(url, entry);
    }
    return entry;
}

// 裁剪后的有效时长(秒),probe 结果兜底 0。
function trimmedDuration(duration: number, trim?: Trim): number {
    const start = Math.max(0, trim?.start ?? 0);
    const end = trim?.end && trim.end > start ? trim.end : duration;
    return Math.max(0, Math.min(end, duration || end) - start);
}

function VideoConcatContent({ ctx }: CanvasNodeContentProps) {
    const content = ctx.node.metadata?.content;
    const status = ctx.node.metadata?.status;
    const [missing, setMissing] = useState(false);

    // 挂载即从插件 storage 读回输出 Blob 并重建运行时 URL——不管当前 content 是空、
    // 还是刷新后失效的 blob: 链接,一律以 storage 为准自愈。
    useEffect(() => {
        let stale = false;
        ctx.storage
            .get<Blob>(`output:${ctx.node.id}`)
            .then((blob) => {
                if (stale) return;
                if (blob instanceof Blob) {
                    setMissing(false);
                    ctx.updateMetadata({ content: URL.createObjectURL(blob) });
                } else if (ctx.node.metadata?.content) {
                    // 有 content 却没有存档输出:数据已丢失,明示而非黑屏。
                    setMissing(true);
                }
            })
            .catch(() => {
                if (!stale && ctx.node.metadata?.content) setMissing(true);
            });
        return () => {
            stale = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ctx.node.id]);

    const containerStyle = { height: "100%", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", color: ctx.theme.node.placeholder, fontSize: 12, textAlign: "center" as const, padding: 8 };

    if (status === "loading") {
        return (
            <div style={containerStyle}>
                <span>拼接中…(实时录制,约需裁剪后总时长)</span>
            </div>
        );
    }
    if (missing) {
        return (
            <div style={containerStyle}>
                <span>输出已丢失(浏览器存储无存档),打开面板重新拼接即可</span>
            </div>
        );
    }
    if (!content) {
        return (
            <div style={containerStyle}>
                <span>打开面板收集画布视频,或把视频节点连到本节点</span>
            </div>
        );
    }
    return (
        <video
            src={content}
            controls
            playsInline
            data-canvas-no-zoom
            style={{ height: "100%", width: "100%", objectFit: "contain", background: "#000" }}
            onWheel={(event) => event.stopPropagation()}
        />
    );
}

// ---------------------------------------------------------------------------
// 帧级修剪台:胶片条 + 入/出点手柄 + 播放头逐帧预览 + 帧步进 + I/O 快捷键
// ---------------------------------------------------------------------------

const TRIM_STRIP_FRAMES = 8;

function TrimEditor({ url, duration, trim, onChange, ctx }: { url: string; duration: number; trim: Trim; onChange: (next: Trim) => void; ctx: CanvasNodeContext }) {
    const accent = "#4c8dff";
    const mono = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
    const mutedColor = ctx.theme.node.placeholder;
    const strokeColor = ctx.theme.node.stroke;
    const start = Math.max(0, trim?.start ?? 0);
    const end = trim?.end && trim.end > start ? Math.min(trim.end, duration) : duration;
    const videoRef = useRef<HTMLVideoElement>(null);
    const stripRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<null | "in" | "out" | "play">(null);
    const [playhead, setPlayhead] = useState(start);
    const [strip, setStrip] = useState<string[]>([]);

    useEffect(() => {
        let stale = false;
        captureFrames(url, TRIM_STRIP_FRAMES).then((frames) => {
            if (!stale) setStrip(frames);
        });
        return () => {
            stale = true;
        };
    }, [url]);

    const seekTo = (time: number) => {
        const clamped = Math.min(Math.max(snapFrame(time), 0), duration);
        setPlayhead(clamped);
        if (videoRef.current) videoRef.current.currentTime = clamped;
    };

    const timeFromEvent = (clientX: number) => {
        const rect = stripRef.current?.getBoundingClientRect();
        if (!rect || !rect.width) return 0;
        return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * duration;
    };

    const commitIn = (time: number) => {
        const next = Math.min(Math.max(snapFrame(time), 0), end - FRAME);
        onChange({ start: next <= 0.0001 ? undefined : next, end: trim?.end });
    };
    const commitOut = (time: number) => {
        const next = Math.max(Math.min(snapFrame(time), duration), start + FRAME);
        onChange({ start: trim?.start, end: next >= duration - 0.0001 ? undefined : next });
    };

    // 拖拽手柄/播放头:window 级 pointermove,出界也能继续拖
    useEffect(() => {
        const move = (event: PointerEvent) => {
            if (!dragRef.current) return;
            event.preventDefault();
            const time = timeFromEvent(event.clientX);
            if (dragRef.current === "in") commitIn(time);
            else if (dragRef.current === "out") commitOut(time);
            else seekTo(time);
        };
        const up = () => {
            dragRef.current = null;
        };
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", up);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
    });

    const onKeyDown = (event: React.KeyboardEvent) => {
        const step = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            seekTo(playhead - step * FRAME);
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            seekTo(playhead + step * FRAME);
        } else if (event.key === "i" || event.key === "I") {
            event.preventDefault();
            event.stopPropagation();
            commitIn(playhead);
        } else if (event.key === "o" || event.key === "O") {
            event.preventDefault();
            event.stopPropagation();
            commitOut(playhead);
        }
    };

    const chipStyle = { padding: "3px 10px", borderRadius: 8, border: `1px solid ${strokeColor}`, background: ctx.theme.toolbar.activeBg, color: ctx.theme.node.text, cursor: "pointer", fontSize: 11, fontFamily: mono } as const;
    const leftPct = duration ? Math.min(100, (start / duration) * 100) : 0;
    const rightPct = duration ? Math.max(0, 100 - Math.min(100, (end / duration) * 100)) : 0;
    const playheadPct = duration ? Math.min(100, (playhead / duration) * 100) : 0;

    return (
        <div data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={onKeyDown} tabIndex={0} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 8px", marginTop: 4, borderRadius: 10, background: ctx.theme.toolbar.activeBg, border: `1px solid ${strokeColor}`, outline: "none" }}>
            {/* 逐帧预览:播放头位置静帧,时间码叠加右上角 */}
            <div style={{ position: "relative", height: 108, borderRadius: 8, overflow: "hidden", background: "#000" }}>
                <video ref={videoRef} src={url} muted playsInline style={{ height: "100%", width: "100%", objectFit: "contain" }} onLoadedMetadata={(event) => { event.currentTarget.currentTime = playhead; }} />
                <span style={{ position: "absolute", top: 5, right: 6, padding: "1px 7px", borderRadius: 6, background: "rgba(0,0,0,.72)", color: "#fff", fontFamily: mono, fontSize: 10.5 }}>{formatTimecode(playhead)}</span>
                <span style={{ position: "absolute", bottom: 5, left: 6, fontFamily: mono, fontSize: 10, color: "rgba(255,255,255,.75)" }}>帧 {Math.round(playhead * FPS)}</span>
            </div>

            {/* 胶片条:入/出点手柄可拖拽,遮罩压暗保留区之外,播放头随预览 */}
            <div
                ref={stripRef}
                onPointerDown={(event) => {
                    if ((event.target as HTMLElement).dataset.handle) return;
                    dragRef.current = "play";
                    seekTo(timeFromEvent(event.clientX));
                }}
                style={{ position: "relative", height: 40, borderRadius: 7, overflow: "hidden", background: "#000", cursor: "crosshair", touchAction: "none" }}
            >
                {strip.length ? (
                    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
                        {strip.map((frame, index) => (
                            <img key={index} src={frame} alt="" draggable={false} style={{ flex: 1, minWidth: 0, height: "100%", objectFit: "cover", borderRight: index < strip.length - 1 ? "1px solid rgba(0,0,0,.35)" : "none" }} />
                        ))}
                    </div>
                ) : (
                    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: mutedColor, fontSize: 10 }}>加载帧…</div>
                )}
                <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${leftPct}%`, background: "rgba(0,0,0,.62)", borderRight: `1.5px solid ${accent}`, pointerEvents: "none" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: `${rightPct}%`, background: "rgba(0,0,0,.62)", borderLeft: `1.5px solid ${accent}`, pointerEvents: "none" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, left: `${playheadPct}%`, width: 1.5, background: "#fff", pointerEvents: "none", boxShadow: "0 0 4px rgba(255,255,255,.8)" }} />
                {/* 入点手柄 */}
                <div
                    data-handle="in"
                    onPointerDown={(event) => {
                        event.stopPropagation();
                        dragRef.current = "in";
                    }}
                    title="拖拽调整入点"
                    style={{ position: "absolute", top: 0, bottom: 0, left: `calc(${leftPct}% - 7px)`, width: 14, cursor: "ew-resize", touchAction: "none", display: "grid", placeItems: "center" }}
                >
                    <span style={{ width: 5, height: 18, borderRadius: 3, background: accent, boxShadow: "0 0 0 1px rgba(255,255,255,.55)" }} />
                </div>
                {/* 出点手柄 */}
                <div
                    data-handle="out"
                    onPointerDown={(event) => {
                        event.stopPropagation();
                        dragRef.current = "out";
                    }}
                    title="拖拽调整出点"
                    style={{ position: "absolute", top: 0, bottom: 0, left: `calc(${100 - rightPct}% - 7px)`, width: 14, cursor: "ew-resize", touchAction: "none", display: "grid", placeItems: "center" }}
                >
                    <span style={{ width: 5, height: 18, borderRadius: 3, background: accent, boxShadow: "0 0 0 1px rgba(255,255,255,.55)" }} />
                </div>
            </div>

            {/* 控制行:帧步进 + 播放头设入/出点 + 时间码 */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", fontSize: 11, color: mutedColor }}>
                <button type="button" style={chipStyle} onClick={() => seekTo(playhead - FRAME)} title="后退一帧">◀1f</button>
                <button type="button" style={chipStyle} onClick={() => seekTo(playhead + FRAME)} title="前进一帧">1f▶</button>
                <button type="button" style={chipStyle} onClick={() => commitIn(playhead)} title="把播放头设为入点(I)">设入点</button>
                <button type="button" style={chipStyle} onClick={() => commitOut(playhead)} title="把播放头设为出点(O)">设出点</button>
                {trim ? (
                    <button type="button" style={chipStyle} onClick={() => onChange({ start: undefined, end: undefined })}>
                        清除
                    </button>
                ) : null}
                <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 10.5 }}>
                    <span style={{ color: accent }}>IN {formatTimecode(start)}</span> · <span style={{ color: accent }}>OUT {formatTimecode(end)}</span> · 源 {formatTimecode(duration)}
                </span>
            </div>
            <div style={{ fontFamily: mono, fontSize: 10, color: mutedColor }}>←/→ 逐帧(Shift ×10) · I 设入点 · O 设出点 · 拖手柄或胶片条调整</div>
        </div>
    );
}

// 深色剪辑台风格的面板:等宽时间码 + 胶片多帧卡片 + 比例时间轴 + hover 无声预览。
const FILM_FRAME_COUNT = 4;
const ACCENT = "#4c8dff";
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

function VideoConcatPanel({ ctx }: CanvasNodePanelProps) {
    const upstream = ctx.getUpstream().filter(isVideoNode);
    const upstreamKey = upstream.map((node) => node.id).join(",");
    const [state, setState] = useState<SegmentState>(() => ({ order: upstreamKey ? upstreamKey.split(",") : [], trims: {} }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [progress, setProgress] = useState<{ index: number; current: number; total: number } | null>(null);
    const [frames, setFrames] = useState<Record<string, string[]>>({});
    const [trimOpenId, setTrimOpenId] = useState<string | null>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const dragIndex = useRef(-1);
    const [overIndex, setOverIndex] = useState(-1);
    // 节点 metadata 缺 durationMs 时（旧上传节点）自行探测时长兜底
    const [probed, setProbed] = useState<Record<string, number>>({});
    // 剪辑源的同源 blob URL（跨域源经宿主媒体代理转存）
    const [sources, setSources] = useState<Record<string, string>>({});

    // 上游变化时合并:保留已排序项与裁剪,新上游追加到末尾;持久化状态优先。
    useEffect(() => {
        const ids = upstreamKey ? upstreamKey.split(",") : [];
        ctx.storage
            .get<SegmentState | string[]>(`segments:${ctx.node.id}`)
            .then((saved) => {
                const savedState: SegmentState = Array.isArray(saved) ? { order: saved, trims: {} } : saved || { order: [], trims: {} };
                const kept = savedState.order.filter((id) => ids.includes(id));
                const added = ids.filter((id) => !kept.includes(id));
                setState((prev) => ({ order: [...kept, ...added], trims: { ...prev.trims, ...savedState.trims } }));
            })
            .catch(() => setState({ order: ids, trims: {} }));
    }, [upstreamKey, ctx.node.id, ctx.storage]);

    const persist = (next: SegmentState) => {
        setState(next);
        void ctx.storage.set(`segments:${ctx.node.id}`, next);
    };

    const ordered = state.order.map((id) => upstream.find((node) => node.id === id)).filter((node): node is CanvasNodeData => Boolean(node));
    const connectedIds = new Set(state.order);
    const candidates = ctx.getNodes().filter((node) => isVideoNode(node) && !connectedIds.has(node.id) && node.id !== ctx.node.id);

    // 剪辑源统一用同源 blob URL（跨域源经宿主媒体代理转存），缩略图/拼接/时长探测都基于它
    const sourceOf = (node: CanvasNodeData) => sources[node.id] || node.metadata?.content || "";
    useEffect(() => {
        const pool = [...ordered, ...candidates];
        const missing = pool.find((node) => node.metadata?.content && !sources[node.id]);
        if (!missing) return;
        let stale = false;
        normalizeClipUrl(missing.metadata!.content!).then((url) => {
            if (!stale) setSources((prev) => ({ ...prev, [missing.id]: url }));
        });
        return () => {
            stale = true;
        };
    }, [ordered, candidates, sources]);

    // 每段的裁剪后有效时长(秒)与整段时长;优先用探测结果(源文件真实元数据),metadata 兜底。
    const durationOf = (node: CanvasNodeData) => {
        const probedDuration = probed[node.id];
        if (probedDuration !== undefined && probedDuration > 0) return probedDuration;
        return (node.metadata?.durationMs || 0) / 1000 || 0;
    };
    const effectiveOf = (node: CanvasNodeData) => trimmedDuration(durationOf(node), state.trims[node.id]);
    const totalSeconds = ordered.reduce((sum, node) => sum + effectiveOf(node), 0);

    useEffect(() => {
        const pool = [...ordered, ...candidates];
        const missing = pool.find((node) => sourceOf(node) && probed[node.id] === undefined);
        if (!missing) return;
        let stale = false;
        probeVideo(sourceOf(missing))
            .then((result) => {
                if (!stale) setProbed((prev) => ({ ...prev, [missing.id]: result.duration }));
            })
            .catch(() => {
                if (!stale) setProbed((prev) => ({ ...prev, [missing.id]: 0 }));
            });
        return () => {
            stale = true;
        };
    }, [ordered, candidates, probed, sources]);

    // 缺失的胶片帧异步补齐(已添加与候选都抓,一次一段,面板量级小)。
    useEffect(() => {
        const pool = [...ordered, ...candidates];
        const missing = pool.find((node) => sourceOf(node) && !frames[node.id]);
        if (!missing) return;
        let stale = false;
        captureFrames(sourceOf(missing), FILM_FRAME_COUNT)
            .then((captured) => {
                if (!stale) setFrames((prev) => ({ ...prev, [missing.id]: captured }));
            })
            .catch(() => {});
        return () => {
            stale = true;
        };
    }, [ordered, candidates, frames, sources]);

    const connect = (ids: string[]) => {
        if (!ids.length) return;
        ctx.applyOps(ids.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: ctx.node.id })));
    };

    const reorder = (from: number, to: number) => {
        if (from === to || from < 0 || to < 0 || from >= state.order.length || to >= state.order.length) return;
        const next = [...state.order];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        persist({ ...state, order: next });
    };

    // 裁剪覆盖整段时视为未裁剪,清掉记录。
    const updateTrim = (id: string, patch: Trim) => {
        const node = ordered.find((item) => item.id === id);
        const duration = node ? durationOf(node) : 0;
        const next = { ...state.trims, [id]: { ...state.trims[id], ...patch } };
        const trim = next[id];
        if ((!trim.start || trim.start <= 0.0001) && (!trim.end || trim.end >= duration - 0.0001)) delete next[id];
        persist({ ...state, trims: next });
    };

    const run = async () => {
        if (busy || !ordered.length) return;
        setBusy(true);
        setError("");
        setProgress({ index: 0, current: 0, total: 1 });
        ctx.updateMetadata({ status: "loading", errorDetails: undefined });
        try {
            const { blob, durationMs, width, height } = await concatVideos(
                ordered.map((node) => ({ url: sourceOf(node), trim: state.trims[node.id] })),
                (index, current, total) => {
                    setProgress((prev) => (prev && prev.index === index && prev.current === current ? prev : { index, current, total }));
                },
            );
            const old = ctx.node.metadata?.content;
            await ctx.storage.set(`output:${ctx.node.id}`, blob);
            await ctx.storage.set(`segments:${ctx.node.id}`, state);
            ctx.updateMetadata({ content: URL.createObjectURL(blob), mimeType: blob.type, durationMs, naturalWidth: width, naturalHeight: height, bytes: blob.size, status: "success" });
            if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : "拼接失败";
            setError(message);
            ctx.updateMetadata({ status: "error", errorDetails: message });
        } finally {
            setBusy(false);
            setProgress(null);
        }
    };

    const mutedColor = ctx.theme.node.placeholder;
    const panelBg = ctx.theme.toolbar.panel;
    const strokeColor = ctx.theme.node.stroke;
    const chipStyle = { padding: "5px 12px", borderRadius: 8, border: `1px solid ${strokeColor}`, background: ctx.theme.toolbar.activeBg, color: ctx.theme.node.text, cursor: "pointer", fontSize: 12 } as const;
    const smallChipStyle = { ...chipStyle, padding: "3px 10px", fontSize: 11 } as const;

    // 拼接进度百分比(时间轴带复用为进度条)。
    const progressPercent = (() => {
        if (!progress || !ordered.length) return 0;
        const index = Math.min(progress.index, ordered.length - 1);
        const before = ordered.slice(0, index).reduce((sum, node) => sum + effectiveOf(node), 0);
        const done = before + Math.min(progress.current, progress.total || progress.current);
        return totalSeconds ? Math.min(100, (done * 100) / totalSeconds) : 0;
    })();

    return (
        <div data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 10, color: ctx.theme.node.text, fontSize: 13, minWidth: 380 }}>
            {/* 时间码总览 + 比例时间轴带(拼接时复用为进度条) */}
            {ordered.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11, color: mutedColor }}>
                        <span>{ordered.length} CLIPS</span>
                        <span>{busy ? `RENDERING ${progressPercent.toFixed(0)}%` : `TOTAL ${formatTimecode(totalSeconds)}`}</span>
                    </div>
                    <div style={{ position: "relative", display: "flex", gap: 2, height: 16, borderRadius: 5, overflow: "hidden", background: panelBg }}>
                        {ordered.map((node, index) => (
                            <div
                                key={node.id}
                                title={`${index + 1}. ${node.title} · ${formatTimecode(effectiveOf(node))}`}
                                style={{ flex: Math.max(effectiveOf(node), 0.05), background: `rgba(76,141,255,${0.35 + (index % 2) * 0.25})`, minWidth: 6, borderRadius: 2, display: "grid", placeItems: "center", color: "#fff", fontSize: 9, fontFamily: MONO, overflow: "hidden", whiteSpace: "nowrap" }}
                            >
                                {effectiveOf(node) / Math.max(totalSeconds, 0.001) > 0.08 ? index + 1 : ""}
                            </div>
                        ))}
                        {busy ? <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(76,141,255,.85), rgba(76,141,255,1))", transform: `scaleX(${progressPercent / 100})`, transformOrigin: "left center", transition: "transform .25s linear" }} /> : null}
                    </div>
                </div>
            ) : null}

            {/* 胶片卡片列表 */}
            {ordered.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {ordered.map((node, index) => {
                        const trim = state.trims[node.id];
                        const duration = durationOf(node);
                        const effective = effectiveOf(node);
                        const isOver = overIndex === index && dragIndex.current !== index;
                        const strip = frames[node.id];
                        const trimStart = Math.max(0, trim?.start ?? 0);
                        const trimEnd = trim?.end && trim.end > trimStart ? trim.end : duration;
                        const leftMaskPct = duration ? Math.min(100, (trimStart / duration) * 100) : 0;
                        const rightMaskPct = duration ? Math.max(0, 100 - Math.min(100, (trimEnd / duration) * 100)) : 0;
                        return (
                            <div key={node.id}>
                                <div
                                    draggable={!busy}
                                    onDragStart={(event) => {
                                        event.stopPropagation();
                                        dragIndex.current = index;
                                        event.dataTransfer.effectAllowed = "move";
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        if (dragIndex.current >= 0 && dragIndex.current !== index) setOverIndex(index);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        reorder(dragIndex.current, index);
                                    }}
                                    onDragEnd={() => {
                                        dragIndex.current = -1;
                                        setOverIndex(-1);
                                    }}
                                    onMouseEnter={() => setHoveredId(node.id)}
                                    onMouseLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                                    style={{ position: "relative", height: 78, borderRadius: 10, overflow: "hidden", cursor: busy ? "default" : "grab", border: `1.5px solid ${isOver ? ACCENT : strokeColor}`, boxShadow: hoveredId === node.id ? "0 4px 16px rgba(0,0,0,.45)" : "none", background: "#000", transition: "box-shadow .15s, border-color .15s" }}
                                >
                                    {/* 胶片帧:多帧横排,帧间分割线制造胶片感;hover 时无声循环预览(应用裁剪区间) */}
                                    {hoveredId === node.id ? (
                                        <video
                                            src={sourceOf(node)}
                                            muted
                                            loop
                                            autoPlay
                                            playsInline
                                            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                                            onLoadedMetadata={(event) => {
                                                const video = event.currentTarget;
                                                video.currentTime = trimStart;
                                            }}
                                            onTimeUpdate={(event) => {
                                                const video = event.currentTarget;
                                                if (trimEnd < duration && video.currentTime >= trimEnd) video.currentTime = trimStart;
                                            }}
                                        />
                                    ) : strip && strip.length ? (
                                        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
                                            {strip.map((frame, frameIndex) => (
                                                <img key={frameIndex} src={frame} alt="" style={{ flex: 1, minWidth: 0, height: "100%", objectFit: "cover", borderRight: frameIndex < strip.length - 1 ? "1px solid rgba(0,0,0,.35)" : "none" }} />
                                            ))}
                                        </div>
                                    ) : (
                                        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: mutedColor, fontSize: 11, background: panelBg }}>加载帧…</div>
                                    )}

                                    {/* 裁剪遮罩:被裁掉的时间区域压暗,保留区亮起 */}
                                    {trim && duration ? (
                                        <>
                                            <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${leftMaskPct}%`, background: "rgba(0,0,0,.62)", borderRight: "1px dashed rgba(255,255,255,.45)" }} />
                                            <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: `${rightMaskPct}%`, background: "rgba(0,0,0,.62)", borderLeft: "1px dashed rgba(255,255,255,.45)" }} />
                                        </>
                                    ) : null}

                                    {/* 序号徽标 */}
                                    <span style={{ position: "absolute", top: 6, left: 6, padding: "1px 6px", borderRadius: 5, background: "rgba(0,0,0,.72)", color: "#fff", fontFamily: MONO, fontSize: 10, lineHeight: 1.6 }}>{String(index + 1).padStart(2, "0")}</span>

                                    {/* 裁剪按钮 */}
                                    <button
                                        type="button"
                                        title="帧级裁剪起止"
                                        disabled={busy}
                                        onClick={() => setTrimOpenId(trimOpenId === node.id ? null : node.id)}
                                        style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 999, border: "none", background: trimOpenId === node.id ? ACCENT : "rgba(0,0,0,.6)", color: "#fff", cursor: "pointer", fontSize: 11, display: "grid", placeItems: "center", opacity: hoveredId === node.id || trimOpenId === node.id || trim ? 1 : 0.55 }}
                                    >
                                        ✂
                                    </button>

                                    {/* 底部渐变信息条:标题 + 时间码 */}
                                    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", gap: 8, padding: "14px 8px 5px", background: "linear-gradient(transparent, rgba(0,0,0,.82))", pointerEvents: "none" }}>
                                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#fff", fontSize: 12, textShadow: "0 1px 2px rgba(0,0,0,.8)" }}>{node.title}</span>
                                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: "rgba(255,255,255,.85)", display: "flex", gap: 6, alignItems: "center" }}>
                                            {effective < duration ? <span style={{ color: ACCENT }}>IN {formatTimecode(trimStart)} OUT {formatTimecode(Math.min(trimEnd, duration))}</span> : null}
                                            <span>{formatTimecode(effective)}</span>
                                        </span>
                                    </div>
                                </div>

                                {/* 帧级修剪台 */}
                                {trimOpenId === node.id ? <TrimEditor url={sourceOf(node)} duration={duration} trim={trim || {}} onChange={(next) => updateTrim(node.id, next)} ctx={ctx} /> : null}
                            </div>
                        );
                    })}
                </div>
            ) : (
                /* 空态:画布有视频时引导点击候选卡片,否则提示先去生成 */
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, height: 60, borderRadius: 10, border: `1.5px dashed ${strokeColor}`, color: mutedColor, fontSize: 12 }}>
                    {candidates.length ? "点击下方视频卡片,加入拼接序列" : "画布上还没有可拼接的视频,先生成或导入视频"}
                </div>
            )}

            {/* 候选区常驻:画布上未连接的视频,胶片卡片直接可见内容,点击即加入 */}
            {candidates.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 11, color: mutedColor, fontFamily: MONO }}>画布视频 · {candidates.length}</span>
                        <button type="button" style={smallChipStyle} disabled={busy} onClick={() => connect(candidates.map((node) => node.id))}>
                            ⇪ 全部加入
                        </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflow: "auto" }}>
                        {candidates.map((node) => {
                            const strip = frames[node.id];
                            const duration = (node.metadata?.durationMs || 0) / 1000;
                            return (
                                <button
                                    key={node.id}
                                    type="button"
                                    title="点击加入拼接序列"
                                    disabled={busy}
                                    onMouseEnter={() => setHoveredId(node.id)}
                                    onMouseLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                                    onClick={() => connect([node.id])}
                                    style={{ position: "relative", height: 64, borderRadius: 10, overflow: "hidden", cursor: busy ? "default" : "pointer", border: `1.5px dashed ${strokeColor}`, background: "#000", padding: 0, textAlign: "left", transition: "border-color .15s" }}
                                >
                                    {hoveredId === node.id ? (
                                        <video src={sourceOf(node)} muted loop autoPlay playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                                    ) : strip && strip.length ? (
                                        <span style={{ position: "absolute", inset: 0, display: "flex" }}>
                                            {strip.map((frame, frameIndex) => (
                                                <img key={frameIndex} src={frame} alt="" style={{ flex: 1, minWidth: 0, height: "100%", objectFit: "cover", borderRight: frameIndex < strip.length - 1 ? "1px solid rgba(0,0,0,.35)" : "none" }} />
                                            ))}
                                        </span>
                                    ) : (
                                        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: mutedColor, fontSize: 11, background: panelBg }}>加载帧…</span>
                                    )}
                                    {/* ＋ 徽标:明确的加入行动 */}
                                    <span style={{ position: "absolute", top: 6, right: 6, width: 20, height: 20, borderRadius: 999, background: hoveredId === node.id ? ACCENT : "rgba(0,0,0,.6)", color: "#fff", fontSize: 13, fontWeight: 700, display: "grid", placeItems: "center", lineHeight: 1 }}>＋</span>
                                    {/* 底部渐变信息条 */}
                                    <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", gap: 8, padding: "12px 8px 4px", background: "linear-gradient(transparent, rgba(0,0,0,.82))", pointerEvents: "none" }}>
                                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#fff", fontSize: 12, textShadow: "0 1px 2px rgba(0,0,0,.8)" }}>{node.title}</span>
                                        {duration ? <span style={{ fontFamily: MONO, fontSize: 10.5, color: "rgba(255,255,255,.85)" }}>{formatTimecode(duration)}</span> : null}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            {/* 主行动:满宽拼接按钮(拼接中变为等宽时间码状态条) */}
            {busy && progress ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: 8, background: "rgba(76,141,255,.12)", border: `1px solid ${ACCENT}`, fontFamily: MONO, fontSize: 11.5 }}>
                    <span>CLIP {String(Math.min(progress.index + 1, ordered.length)).padStart(2, "0")}/{String(ordered.length).padStart(2, "0")}</span>
                    <span>{Math.min(progress.current, progress.total || progress.current).toFixed(1)}s / {(progress.total || 0).toFixed(1)}s</span>
                </div>
            ) : (
                <button
                    type="button"
                    disabled={!ordered.length}
                    onClick={run}
                    style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "none", background: ordered.length ? ACCENT : strokeColor, color: "#fff", cursor: ordered.length ? "pointer" : "default", fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}
                >
                    拼接 {ordered.length} 段{totalSeconds ? ` · ${formatTimecode(totalSeconds)}` : ""}
                </button>
            )}
            {error ? <div style={{ color: "#f87171", fontSize: 12 }}>⚠ {error}</div> : null}
        </div>
    );
}

export default definePlugin({
    id: "video-concat",
    name: "视频拼接",
    version: "2.0.0",
    description: "把上游视频节点按顺序首尾拼接成一个视频:胶片卡片收集、拖拽排序、帧级裁剪",
    nodes: [
        {
            type: "video-concat:node",
            title: "视频拼接",
            icon: "🎞️",
            description: "把上游视频按顺序首尾拼接,支持帧级裁剪",
            defaultSize: { width: 320, height: 200 },
            defaultMetadata: { content: "" },
            minimapColor: "#f59e0b",
            hasSourceHandle: true,
            autoOpenPanel: true,
            interactionToggle: true, // 视频播放需要指针交互
            resource: (node) => (node.metadata?.content ? { kind: "video", url: node.metadata.content } : null),
            Content: VideoConcatContent,
            Panel: VideoConcatPanel,
            toolbar: (ctx) => {
                const items = [];
                if (ctx.node.metadata?.content) items.push({ id: "reconcat", title: "重新拼接", label: "拼接", icon: "↻", onClick: () => ctx.openPanel() });
                return items;
            },
        },
    ],
});

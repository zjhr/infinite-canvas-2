// 画布节点插件契约（宿主侧）。
// 与 plugins/canvas/sdk 的公开类型保持同构：插件产物按此契约运行，
// 宿主负责注入运行时（React 单例、事件总线、样式注入、存储）。
import type * as React from "react";
import type { ComponentType, ReactNode } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata, ViewportTransform } from "../types";

// ---------------------------------------------------------------------------
// 画布指令集（ctx.applyOps）
// ---------------------------------------------------------------------------

export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: string; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<Pick<CanvasNodeData, "title" | "width" | "height">>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: string }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string }
    | { type: "set_viewport"; viewport: ViewportTransform }
    | { type: "select_nodes"; ids: string[] }
    | { type: "run_generation"; nodeId: string; mode?: CanvasGenerationMode; prompt?: string };

// ---------------------------------------------------------------------------
// 资源：插件节点作为上游输入被消费时输出什么
// ---------------------------------------------------------------------------

export type CanvasResourceKind = "image" | "video" | "audio" | "text";
export type CanvasNodeResource = { kind: CanvasResourceKind; text?: string; url?: string };

// ---------------------------------------------------------------------------
// AI 生成：复用宿主的模型/密钥配置，插件本身拿不到 API Key
// ---------------------------------------------------------------------------

export type GenerateOptions = { signal?: AbortSignal; references?: string[]; model?: string };
export type GenerateImageOptions = GenerateOptions & { count?: number; size?: string };
export type GenerateImageResult = { images: string[] };
export type GenerateVideoOptions = GenerateOptions & { size?: string; seconds?: string };
export type GenerateVideoResult = { url: string; mimeType: string; width?: number; height?: number; durationMs?: number };
export type GenerateTextOptions = { signal?: AbortSignal; model?: string; system?: string; onDelta?: (text: string) => void };
export type GenerateTextResult = { text: string };
export type PluginModelCapability = "image" | "video" | "text" | "audio";
export type ModelOption = { value: string; label: string };

export type CanvasPluginAi = {
    generateImage: (prompt: string, options?: GenerateImageOptions) => Promise<GenerateImageResult>;
    generateVideo: (prompt: string, options?: GenerateVideoOptions) => Promise<GenerateVideoResult>;
    generateText: (prompt: string, options?: GenerateTextOptions) => Promise<GenerateTextResult>;
    listModels: (capability?: PluginModelCapability) => ModelOption[];
    defaultModel: (capability: PluginModelCapability) => string;
};

// ---------------------------------------------------------------------------
// 节点上下文与定义
// ---------------------------------------------------------------------------

export type PluginStorage = {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
};

// 节点 hover 工具条上追加的自定义按钮
export type CanvasNodeToolbarItem = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
};

export type CanvasNodeContext = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    scale: number;
    isSelected: boolean;
    updateMetadata: (patch: CanvasNodeMetadata) => void;
    updateNode: (patch: Partial<Pick<CanvasNodeData, "title" | "width" | "height">>) => void;
    getNode: (id: string) => CanvasNodeData | null;
    getNodes: () => CanvasNodeData[];
    getConnections: () => CanvasConnection[];
    getUpstream: () => CanvasNodeData[];
    getDownstream: () => CanvasNodeData[];
    applyOps: (ops: CanvasAgentOp[]) => void;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => () => void;
    ai: CanvasPluginAi;
    openPanel: () => void;
    closePanel: () => void;
    storage: PluginStorage;
};

export type CanvasNodeContentProps = { ctx: CanvasNodeContext };
export type CanvasNodePanelProps = { ctx: CanvasNodeContext; onClose: () => void };

export type CanvasNodeDefinition = {
    type: string; // 建议 "<pluginId>:<name>"，全局唯一
    title: string;
    icon: ReactNode;
    description?: string;
    defaultSize: { width: number; height: number };
    defaultMetadata?: CanvasNodeMetadata;
    minimapColor?: string;
    showInCreateMenu?: boolean; // 默认 true
    hasSourceHandle?: boolean; // 右侧输出连接点，默认 true
    hidePanel?: boolean; // 点击/新建不弹出下方面板，纯展示型节点用
    transparentBackground?: boolean; // 节点卡片背景与边框透明
    autoOpenPanel?: boolean; // 单击节点自动打开自定义 Panel
    interactionToggle?: boolean; // hover 工具条加「交互 ⇄ 移动」开关，按 metadata.interactive 控制内容层指针事件
    forceInteractive?: (node: CanvasNodeData) => boolean;
    keepAspectRatio?: (node: CanvasNodeData) => boolean;
    resource?: (node: CanvasNodeData) => CanvasNodeResource | null;
    Content?: ComponentType<CanvasNodeContentProps>;
    Panel?: ComponentType<CanvasNodePanelProps>;
    toolbar?: (ctx: CanvasNodeContext) => CanvasNodeToolbarItem[];
    onDoubleClick?: (ctx: CanvasNodeContext) => boolean;
};

// ---------------------------------------------------------------------------
// 插件运行时与插件包
// ---------------------------------------------------------------------------

export type CanvasPluginApp = {
    version: string;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => () => void;
    injectCSS: (css: string, key?: string) => () => void;
};

// 宿主注入的运行时（工厂形式插件的入参），内含宿主 React 单例避免双 React。
// jsx/jsxs 来自宿主真实 jsx-runtime：jsxs 的静态 children 语义（不触发 key 校验）必须保留。
export type PluginRuntime = CanvasPluginApp & {
    React: typeof React;
    jsx: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
    jsxs: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
    Fragment: typeof React.Fragment;
};

export type CanvasPlugin = {
    id: string;
    name: string;
    version: string;
    description?: string;
    minAppVersion?: string;
    css?: string;
    nodes: CanvasNodeDefinition[];
    setup?: (app: CanvasPluginApp) => void | (() => void);
};

export type CanvasPluginFactory = (runtime: PluginRuntime) => CanvasPlugin;

// 宿主能力：渲染插件节点时由画布页面构造并注入
export type CanvasPluginHost = {
    getNode: (id: string) => CanvasNodeData | null;
    getNodes: () => CanvasNodeData[];
    getConnections: () => CanvasConnection[];
    getUpstream: (nodeId: string) => CanvasNodeData[];
    getDownstream: (nodeId: string) => CanvasNodeData[];
    updateNode: (nodeId: string, patch: Partial<Pick<CanvasNodeData, "title" | "width" | "height">>) => void;
    updateMetadata: (nodeId: string, patch: CanvasNodeMetadata) => void;
    applyOps: (ops: CanvasAgentOp[]) => void;
    ai: CanvasPluginAi;
    openPanel: (nodeId: string) => void;
    closePanel: () => void;
};

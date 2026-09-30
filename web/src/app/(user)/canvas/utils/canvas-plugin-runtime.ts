import React from "react";
import { jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import localforage from "localforage";

import type { CanvasPluginApp, PluginRuntime, PluginStorage } from "./canvas-plugin-types";

// ---------------------------------------------------------------------------
// 轻量画布事件总线：节点间 / 插件间通信
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function emitCanvasEvent(event: string, payload?: unknown) {
    handlers.get(event)?.forEach((handler) => {
        try {
            handler(payload);
        } catch (error) {
            console.error(`[canvas-event] handler for "${event}" failed`, error);
        }
    });
}

export function onCanvasEvent(event: string, handler: Handler) {
    let set = handlers.get(event);
    if (!set) {
        set = new Set();
        handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
}

// ---------------------------------------------------------------------------
// 插件私有持久化：按插件 id 命名空间隔离（输出 Blob、剪辑状态等都存这里）
// ---------------------------------------------------------------------------

const stores = new Map<string, ReturnType<typeof localforage.createInstance>>();

export function createPluginStorage(pluginId: string): PluginStorage {
    let store = stores.get(pluginId);
    if (!store) {
        store = localforage.createInstance({ name: "infinite-canvas-plugins", storeName: pluginId });
        stores.set(pluginId, store);
    }
    return {
        get: (key) => store!.getItem(key),
        set: async (key, value) => {
            await store!.setItem(key, value);
        },
        remove: async (key) => {
            await store!.removeItem(key);
        },
    };
}

// ---------------------------------------------------------------------------
// 插件运行时：插件产物通过 globalThis.InfiniteCanvasRuntime 取宿主 React 单例
// ---------------------------------------------------------------------------

function injectCSS(css: string, key?: string) {
    const id = key ? `canvas-plugin-style-${key}` : undefined;
    if (id) document.getElementById(id)?.remove();
    const style = document.createElement("style");
    if (id) style.id = id;
    style.dataset.canvasPluginStyle = "true";
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
}

let runtime: PluginRuntime | null = null;

export function getPluginRuntime(): PluginRuntime {
    if (!runtime) {
        const next: PluginRuntime = {
            React,
            // 插件 SDK 的 jsx/jsxs 转发到这里:必须用真实 jsx-runtime 保留静态 children 语义
            jsx: (type, props, key) => reactJsx(type as never, props as never, key as never) as never,
            jsxs: (type, props, key) => reactJsxs(type as never, props as never, key as never) as never,
            Fragment: React.Fragment,
            injectCSS,
            version: process.env.NEXT_PUBLIC_APP_VERSION || "dev",
            emit: emitCanvasEvent,
            on: onCanvasEvent,
        };
        runtime = next;
        (window as unknown as { InfiniteCanvasRuntime?: PluginRuntime }).InfiniteCanvasRuntime = next;
    }
    return runtime;
}

export type { CanvasPluginApp };

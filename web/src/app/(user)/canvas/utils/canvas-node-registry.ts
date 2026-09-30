import { create } from "zustand";

import { CanvasNodeType } from "../types";
import type { CanvasNodeDefinition } from "./canvas-plugin-types";

// 插件节点定义注册表：内置节点不进这里，插件启用时注册、禁用/卸载时注销。
const definitions = new Map<string, CanvasNodeDefinition>();
const ownerByType = new Map<string, string>(); // type -> pluginId

// 注册/注销时递增版本号，驱动创建菜单等依赖 UI 刷新
export const useNodeRegistryVersion = create<{ version: number }>(() => ({ version: 0 }));
function bump() {
    useNodeRegistryVersion.setState((state) => ({ version: state.version + 1 }));
}

export function registerNodeDefinitions(defs: CanvasNodeDefinition[], pluginId: string) {
    defs.forEach((def) => {
        definitions.set(def.type, def);
        ownerByType.set(def.type, pluginId);
    });
    bump();
}

export function unregisterPluginNodes(pluginId: string) {
    for (const [type, owner] of ownerByType) {
        if (owner !== pluginId) continue;
        definitions.delete(type);
        ownerByType.delete(type);
    }
    bump();
}

export function getNodeDefinition(type: string) {
    return definitions.get(type);
}

// 插件节点的默认尺寸/标题/初始 metadata，供 createCanvasNode 使用；非插件类型返回 null
export function getPluginNodeSpec(type: string) {
    const def = definitions.get(type);
    if (!def) return null;
    return { width: def.defaultSize.width, height: def.defaultSize.height, title: def.title, metadata: def.defaultMetadata };
}

export function getNodePluginId(type: string) {
    return ownerByType.get(type) || "builtin";
}

export function listNodeDefinitions() {
    return Array.from(definitions.values());
}

export function isBuiltinNodeType(type: string) {
    return (Object.values(CanvasNodeType) as string[]).includes(type);
}

// 插件节点类型：非内置且当前已注册
export function isPluginNodeType(type: string) {
    return !isBuiltinNodeType(type) && definitions.has(type);
}

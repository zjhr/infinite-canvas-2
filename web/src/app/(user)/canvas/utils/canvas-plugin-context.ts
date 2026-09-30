import type { CanvasTheme } from "@/lib/canvas-theme";

import type { CanvasNodeData } from "../types";
import { getNodePluginId } from "./canvas-node-registry";
import { createPluginStorage, emitCanvasEvent, onCanvasEvent } from "./canvas-plugin-runtime";
import type { CanvasNodeContext, CanvasPluginHost } from "./canvas-plugin-types";

// 组装宿主能力、节点数据、主题与缩放，注入到插件节点的渲染上下文
export function buildNodeContext(host: CanvasPluginHost, node: CanvasNodeData, theme: CanvasTheme, scale: number, isSelected = false): CanvasNodeContext {
    const storage = createPluginStorage(getNodePluginId(node.type));
    return {
        node,
        theme,
        scale,
        isSelected,
        updateMetadata: (patch) => host.updateMetadata(node.id, patch),
        updateNode: (patch) => host.updateNode(node.id, patch),
        getNode: (id) => host.getNode(id),
        getNodes: () => host.getNodes(),
        getConnections: () => host.getConnections(),
        getUpstream: () => host.getUpstream(node.id),
        getDownstream: () => host.getDownstream(node.id),
        applyOps: (ops) => host.applyOps(ops),
        emit: (event, payload) => emitCanvasEvent(event, payload),
        on: (event, handler) => onCanvasEvent(event, handler),
        ai: host.ai,
        openPanel: () => host.openPanel(node.id),
        closePanel: () => host.closePanel(),
        storage,
    };
}

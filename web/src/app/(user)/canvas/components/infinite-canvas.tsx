"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "../types";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const scaleRef = useRef(viewport.k);
    const viewportRef = useRef(viewport);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(() => {
        scaleRef.current = viewport.k;
        viewportRef.current = viewport;
    }, [viewport]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    // 目标到画布容器之间是否存在可滚动区域（文本节点、插件面板等），有则把滚轮让给内容自身滚动
    const hasScrollableAncestor = (target: Element) => {
        let node: Element | null = target;
        while (node && node !== containerRef.current) {
            if (node instanceof HTMLElement) {
                const style = window.getComputedStyle(node);
                if ((/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) || (/(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth)) return true;
            }
            node = node.parentElement;
        }
        return false;
    };

    // 滚轮/触控板手势按帧合并：高频 wheel 事件只累积增量，rAF 里一次性应用，
    // 避免每个事件都触发整页重渲染造成抖动
    const wheelFrameRef = useRef<number | null>(null);
    const wheelAccumulatorRef = useRef({ dx: 0, dy: 0, zoom: 1, anchorX: 0, anchorY: 0 });

    const flushWheelAccumulator = useCallback(() => {
        wheelFrameRef.current = null;
        const container = containerRef.current;
        if (!container) return;
        const acc = wheelAccumulatorRef.current;
        let { x, y, k } = viewportRef.current;
        if (acc.zoom !== 1) {
            const newScale = Math.min(Math.max(k * acc.zoom, 0.05), 5);
            const rect = container.getBoundingClientRect();
            const mouseX = acc.anchorX - rect.left;
            const mouseY = acc.anchorY - rect.top;
            const worldX = (mouseX - x) / k;
            const worldY = (mouseY - y) / k;
            x = mouseX - worldX * newScale;
            y = mouseY - worldY * newScale;
            k = newScale;
            acc.zoom = 1;
        }
        if (acc.dx || acc.dy) {
            x -= acc.dx;
            y -= acc.dy;
            acc.dx = 0;
            acc.dy = 0;
        }
        const next = { x, y, k };
        viewportRef.current = next;
        onViewportChange(next);
    }, [onViewportChange]);

    const scheduleWheelFlush = useCallback(() => {
        if (wheelFrameRef.current !== null) return;
        wheelFrameRef.current = requestAnimationFrame(flushWheelAccumulator);
    }, [flushWheelAccumulator]);

    const handleWheel = (event: WheelEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !containerRef.current?.contains(target)) return;
        if (target.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        // 触控板双指捏合 / Ctrl+滚轮：以指针为中心缩放
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            let deltaY = event.deltaY;
            if (event.deltaMode === 1) deltaY *= 16;
            const acc = wheelAccumulatorRef.current;
            // 触控板捏合事件增量小(±2-10)频率高，鼠标滚轮一格 ±100；指数系数兼顾两者
            acc.zoom *= Math.exp(-Math.max(-80, Math.min(80, deltaY)) * 0.005);
            acc.anchorX = event.clientX;
            acc.anchorY = event.clientY;
            scheduleWheelFlush();
            return;
        }

        // 鼠标滚轮 / 触控板双指滑动：平移画布；Shift+滚轮横向移动
        if (hasScrollableAncestor(target)) return;
        event.preventDefault();
        event.stopPropagation();
        let dx = event.deltaX;
        let dy = event.deltaY;
        if (event.shiftKey && !dx) {
            dx = dy;
            dy = 0;
        }
        if (event.deltaMode === 1) {
            dx *= 16;
            dy *= 16;
        } else if (event.deltaMode === 2) {
            dx *= window.innerHeight;
            dy *= window.innerHeight;
        }
        const acc = wheelAccumulatorRef.current;
        acc.dx += dx;
        acc.dy += dy;
        scheduleWheelFlush();
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        const temporaryTool = isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan");
        if (activeTool === "pan" && (!target || !event.currentTarget.contains(target))) return;
        if (target?.closest("[data-canvas-no-zoom]") && activeTool !== "pan") return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        if (event.button === 0 && isBackgroundClick && document.activeElement instanceof HTMLElement && (document.activeElement.isContentEditable || document.activeElement instanceof HTMLMediaElement)) document.activeElement.blur();

        if (shouldPan) {
            event.preventDefault();
            if (activeTool === "pan") event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: viewport.x,
                initialY: viewport.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id],[data-connection-create-menu]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;
            if (event.buttons === 0) {
                panState.current.isPanning = false;
                setIsPanning(false);
                document.body.style.cursor = "";
                return;
            }
            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                if (nextViewportRef.current) onViewportChange(nextViewportRef.current);
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        document.addEventListener("wheel", handleWheel, { capture: true, passive: false });
        return () => {
            document.removeEventListener("wheel", handleWheel, true);
            if (wheelFrameRef.current !== null) {
                cancelAnimationFrame(wheelFrameRef.current);
                wheelFrameRef.current = null;
            }
        };
    }, [handleWheel]);

    const temporaryTool = isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className={`relative h-full w-full select-none overflow-hidden ${activeTool === "pan" || isPanning ? "[&_*]:!cursor-[inherit]" : ""}`}
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={activeTool === "pan" ? undefined : handlePointerDown}
            onPointerDownCapture={activeTool === "pan" ? handlePointerDown : undefined}
            onDoubleClick={handleDoubleClick}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`, "--canvas-inverse-scale": 1 / viewport.k } as React.CSSProperties}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}

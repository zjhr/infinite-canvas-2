// automatic JSX 运行时:esbuild/tsc 的 `jsxImportSource` 指向本包时,
// TSX 会被编译成对本模块 jsx()/jsxs() 的调用。这里转发到宿主真实的 jsx-runtime,
// 让插件写纯 TSX、react 全程 external。jsxs 的静态 children 语义(不触发 key 校验)
// 必须由宿主 runtime 保留,不能退化成 createElement——否则多子元素会误报 key 告警。

import type * as React from "react";

import { getRuntime } from "./runtime";

// Fragment 哨兵:渲染时才解析为宿主 React.Fragment,避免模块顶层触碰运行时。
export const Fragment = Symbol.for("infinite-canvas.jsx.fragment") as unknown as React.ExoticComponent<{ children?: React.ReactNode }>;

// jsx 与 jsxs 必须分别转发:两者的 children key 校验语义不同。
export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): React.ReactElement {
    const runtime = getRuntime();
    const resolvedType = type === Fragment ? runtime.React.Fragment : type;
    return runtime.jsx(resolvedType as never, props as never, key as never) as React.ReactElement;
}

export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): React.ReactElement {
    const runtime = getRuntime();
    const resolvedType = type === Fragment ? runtime.React.Fragment : type;
    return runtime.jsxs(resolvedType as never, props as never, key as never) as React.ReactElement;
}

// 让 `jsxImportSource` 指向本包的编译器能从这里取到 JSX 内建标签类型(复用 @types/react)。
export namespace JSX {
    export type Element = React.JSX.Element;
    export type ElementType = React.JSX.ElementType;
    export type ElementClass = React.JSX.ElementClass;
    export type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
    export type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
    export type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
    export type IntrinsicAttributes = React.JSX.IntrinsicAttributes;
    export type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>;
    export type IntrinsicElements = React.JSX.IntrinsicElements;
}

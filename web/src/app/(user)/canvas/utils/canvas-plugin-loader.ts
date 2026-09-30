import { registerNodeDefinitions, unregisterPluginNodes } from "./canvas-node-registry";
import { getPluginRuntime } from "./canvas-plugin-runtime";
import { usePluginStore, type InstalledPlugin } from "../stores/use-plugin-store";
import type { CanvasPlugin, CanvasPluginFactory } from "./canvas-plugin-types";

// 官方插件注册表：与旧版插件生态共用同一份清单与产物契约
export const PLUGIN_REGISTRY_URL = process.env.NEXT_PUBLIC_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";

const cleanups = new Map<string, () => void>();

// 插件产物是浏览器原生 ESM；用 Function 包一层动态 import，避免被打包器静态分析
const dynamicImport = new Function("url", "return import(url);") as (url: string) => Promise<{ default?: unknown; plugin?: unknown }>;

// 插件可能默认导出 CanvasPlugin 对象，或接收运行时的工厂函数（工厂用 runtime.React，避免自带第二份 React）
async function evaluatePluginSource(source: string): Promise<CanvasPlugin> {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
        const mod = await dynamicImport(url);
        const exported = mod.default ?? mod.plugin;
        const plugin = typeof exported === "function" ? (exported as CanvasPluginFactory)(getPluginRuntime()) : exported;
        return assertPlugin(plugin);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function assertPlugin(plugin: unknown): CanvasPlugin {
    const value = plugin as Partial<CanvasPlugin> | null;
    if (!value || typeof value !== "object") throw new Error("插件格式无效：缺少默认导出对象");
    if (!value.id || !Array.isArray(value.nodes) || !value.nodes.length) throw new Error("插件缺少 id 或 nodes 定义");
    return value as CanvasPlugin;
}

export function activatePlugin(plugin: CanvasPlugin) {
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    // 声明的样式在启用时注入，禁用/卸载时移除
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(plugin.id, () => disposers.forEach((dispose) => dispose()));
}

export function deactivatePlugin(pluginId: string) {
    cleanups.get(pluginId)?.();
    cleanups.delete(pluginId);
    unregisterPluginNodes(pluginId);
}

async function fetchPluginSource(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`插件下载失败（HTTP ${response.status}）`);
    return response.text();
}

// 加时间戳参数绕过 HTTP/CDN 缓存，watch 构建后能拿到最新产物
function withCacheBust(url: string) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

// 从 URL 安装（或替换）插件并立即启用；bustCache 用于升级时绕过缓存，落库的 URL 保持干净
export async function installPluginFromUrl(url: string, opts?: { official?: boolean; bustCache?: boolean }) {
    const source = await fetchPluginSource(opts?.bustCache ? withCacheBust(url) : url);
    const plugin = await evaluatePluginSource(source);
    deactivatePlugin(plugin.id); // 替换旧版本
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url, source, enabled: true, official: opts?.official });
    activatePlugin(plugin);
    return plugin;
}

export async function updatePlugin(record: InstalledPlugin) {
    // 升级必须拿最新产物，始终绕过缓存
    return installPluginFromUrl(record.url, { official: record.official, bustCache: true });
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    usePluginStore.getState().setEnabled(record.id, enabled);
    if (!enabled) {
        deactivatePlugin(record.id);
        return;
    }
    // 本地插件启用时按文件重新拉取，避免缓存源码过期
    const source = record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source;
    activatePlugin(await evaluatePluginSource(source));
}

export function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
}

let loaded = false;

// 应用启动时加载已安装且启用的插件
export async function ensurePluginsLoaded() {
    if (loaded) return;
    loaded = true;
    await usePluginStore.persist.rehydrate();
    await loadLocalPlugins(); // 先发现本地插件（默认关闭），再激活所有启用记录
    const records = usePluginStore.getState().plugins.filter((record) => record.enabled);
    await Promise.all(
        records.map(async (record) => {
            try {
                // 本地插件用最新产物，其余用缓存的源码
                const source = record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source;
                activatePlugin(await evaluatePluginSource(source));
            } catch (error) {
                console.error(`[plugin] 插件加载失败: ${record.id}`, error);
            }
        }),
    );
    await loadDevPlugins();
}

// 发现 web/public/plugins 下的本地插件，加入管理器列表（默认关闭）
async function loadLocalPlugins() {
    let urls: unknown;
    try {
        const response = await fetch("/plugins/index.json");
        if (!response.ok) return;
        urls = await response.json();
    } catch {
        return; // 没有本地清单时跳过
    }
    if (!Array.isArray(urls) || !urls.length) return;
    const store = usePluginStore.getState();
    await Promise.all(
        urls.map(async (url: string) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                const existing = store.plugins.find((item) => item.id === plugin.id);
                store.upsert({
                    id: plugin.id,
                    name: plugin.name || plugin.id,
                    version: plugin.version || "0.0.0",
                    description: plugin.description,
                    url,
                    source,
                    enabled: existing?.enabled ?? false, // 保留用户开关；新发现的插件默认关闭
                    local: true,
                });
            } catch (error) {
                console.error(`[plugin] 本地插件发现失败: ${url}`, error);
            }
        }),
    );
}

// 本地开发：NEXT_PUBLIC_DEV_PLUGINS 声明的插件每次刷新都重新拉取并直接激活（不缓存、不落库）
async function loadDevPlugins() {
    const raw = process.env.NEXT_PUBLIC_DEV_PLUGINS;
    if (!raw) return;
    const urls = raw.split(",").map((item) => item.trim()).filter(Boolean);
    await Promise.all(
        urls.map(async (url) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                deactivatePlugin(plugin.id);
                activatePlugin(plugin);
                console.info(`[plugin] 开发插件已加载: ${plugin.id} (${url})`);
            } catch (error) {
                console.error(`[plugin] 开发插件加载失败: ${url}`, error);
            }
        }),
    );
}

// ---------------------------------------------------------------------------
// 官方插件注册表
// ---------------------------------------------------------------------------

export type OfficialPluginEntry = {
    id: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    url: string;
};

type RawEntry = { id?: string; name?: string; version?: string; description?: string; icon?: string; entry?: string; url?: string };
type RawManifest = { plugins?: RawEntry[] };

// 拉取官方注册表，把相对 entry 解析成绝对 URL 后走统一的 URL 安装流程
export async function fetchOfficialPlugins(registryUrl: string = PLUGIN_REGISTRY_URL): Promise<OfficialPluginEntry[]> {
    const response = await fetch(registryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`官方插件列表拉取失败（HTTP ${response.status}）`);
    const data = (await response.json()) as RawManifest;
    const list = Array.isArray(data?.plugins) ? data.plugins : [];
    return list
        .filter((item): item is RawEntry & { id: string } => Boolean(item && item.id && (item.entry || item.url)))
        .map((item) => ({
            id: item.id,
            name: item.name || item.id,
            version: item.version || "0.0.0",
            description: item.description,
            icon: item.icon,
            url: item.url ? item.url : new URL(item.entry as string, registryUrl).toString(),
        }));
}

// 比较语义化版本：正数表示 a 更新，负数表示 b 更新，0 表示相等；只比较数字段，忽略预发布标签
function compareSemver(a: string, b: string): number {
    const parse = (v: string) => v.split(".").map((part) => parseInt(part, 10) || 0);
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// 远端版本是否比已安装版本更新
export function hasUpgrade(installedVersion: string, remoteVersion: string): boolean {
    return compareSemver(remoteVersion, installedVersion) > 0;
}

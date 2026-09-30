"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { App, Button, Input, Modal, Popconfirm, Switch, Tabs } from "antd";
import { AlertTriangle, Download, Puzzle, RefreshCw, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { usePluginStore, type InstalledPlugin } from "../stores/use-plugin-store";
import { fetchOfficialPlugins, hasUpgrade, installPluginFromUrl, setPluginEnabled, uninstallPlugin, updatePlugin, type OfficialPluginEntry } from "../utils/canvas-plugin-loader";

// 节点插件管理器：官方注册表一键安装、本地插件开关、第三方 JS URL 安装
export function CanvasPluginManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message } = App.useApp();
    const plugins = usePluginStore((state) => state.plugins);
    const [url, setUrl] = useState("");
    const [installing, setInstalling] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const [official, setOfficial] = useState<OfficialPluginEntry[]>([]);
    const [loadingOfficial, setLoadingOfficial] = useState(false);
    const [officialError, setOfficialError] = useState<string | null>(null);

    const recordById = useMemo(() => new Map(plugins.map((item) => [item.id, item])), [plugins]);
    const localPlugins = useMemo(() => plugins.filter((item) => item.local), [plugins]);
    const thirdPartyPlugins = useMemo(() => plugins.filter((item) => !item.local && !item.official), [plugins]);

    const loadOfficial = useCallback(async () => {
        setLoadingOfficial(true);
        setOfficialError(null);
        try {
            setOfficial(await fetchOfficialPlugins());
        } catch (error) {
            setOfficialError(error instanceof Error ? error.message : String(error));
        } finally {
            setLoadingOfficial(false);
        }
    }, []);

    // 打开面板时拉取官方注册表；失败后不自动重试，手动刷新即可
    useEffect(() => {
        if (open && official.length === 0 && !loadingOfficial && !officialError) void loadOfficial();
    }, [open, official.length, loadingOfficial, officialError, loadOfficial]);

    const handleInstallUrl = async () => {
        const target = url.trim();
        if (!target) return;
        setInstalling(true);
        try {
            const plugin = await installPluginFromUrl(target);
            message.success(`已安装插件「${plugin.name}」`);
            setUrl("");
        } catch (error) {
            message.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setInstalling(false);
        }
    };

    const handleInstallOfficial = async (entry: OfficialPluginEntry) => {
        setBusyId(entry.id);
        try {
            const plugin = await installPluginFromUrl(entry.url, { official: true });
            message.success(`已安装「${plugin.name}」`);
        } catch (error) {
            message.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusyId(null);
        }
    };

    const runOnPlugin = async (record: InstalledPlugin, action: () => Promise<void>, successText: string) => {
        setBusyId(record.id);
        try {
            await action();
            message.success(successText);
        } catch (error) {
            message.error(`${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusyId(null);
        }
    };

    // 已安装插件的操作：启用开关；非本地插件另有更新/卸载，有新版本时高亮更新
    const installedControls = (record: InstalledPlugin, upgradable = false) => (
        <>
            <Switch size="small" checked={record.enabled} loading={busyId === record.id} onChange={(checked) => runOnPlugin(record, () => setPluginEnabled(record, checked), checked ? "已启用" : "已停用")} />
            {!record.local ? (
                <>
                    <Button
                        type={upgradable ? "primary" : "text"}
                        size="small"
                        icon={<RefreshCw className="size-4" />}
                        loading={busyId === record.id}
                        title={upgradable ? "发现新版本" : "从来源更新"}
                        onClick={() => runOnPlugin(record, async () => void (await updatePlugin(record)), "已更新")}
                    />
                    <Popconfirm title="确定卸载该插件？" okText="卸载" cancelText="取消" onConfirm={() => uninstallPlugin(record.id)}>
                        <Button type="text" size="small" danger icon={<Trash2 className="size-4" />} title="卸载" />
                    </Popconfirm>
                </>
            ) : null}
        </>
    );

    // 有新版本时在图标右上角加绿点
    const withUpgradeDot = (icon: ReactNode) => (
        <span className="relative inline-flex">
            {icon}
            <span className="absolute -right-1 -top-1 size-2 rounded-full" style={{ background: "#22c55e", boxShadow: `0 0 0 2px ${theme.node.fill}` }} title="有新版本" />
        </span>
    );

    const versionTag = (version: string) => (
        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
            v{version}
        </span>
    );

    const emptyHint = (text: string) => (
        <div className="py-10 text-center text-sm" style={{ color: theme.node.muted }}>
            {text}
        </div>
    );

    // 通用插件行：图标、名称与版本、描述、操作
    const row = (key: string, icon: ReactNode, name: string, version: string, subtitle: string | undefined, right: ReactNode) => (
        <div key={key} className="flex items-center gap-3 rounded-xl border px-3 py-2.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
            <span className="grid size-9 shrink-0 place-items-center rounded-lg text-base" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                {icon}
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm font-medium" style={{ color: theme.node.text }}>
                    <span className="truncate">{name}</span>
                    {versionTag(version)}
                </div>
                {subtitle ? (
                    <div className="mt-0.5 truncate text-xs" style={{ color: theme.node.muted }}>
                        {subtitle}
                    </div>
                ) : null}
            </div>
            {right}
        </div>
    );

    const officialTab = (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <div className="text-xs" style={{ color: theme.node.muted }}>
                    官方插件经 jsDelivr 远程拉取，一键安装
                </div>
                <Button type="text" size="small" icon={<RefreshCw className={`size-4 ${loadingOfficial ? "animate-spin" : ""}`} />} onClick={loadOfficial} disabled={loadingOfficial}>
                    刷新
                </Button>
            </div>
            {officialError ? (
                <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                    加载失败：{officialError}
                </div>
            ) : loadingOfficial && official.length === 0 ? (
                emptyHint("正在加载官方插件…")
            ) : official.length === 0 ? (
                emptyHint("暂无官方插件")
            ) : (
                <div className="thin-scrollbar max-h-[46vh] space-y-2 overflow-auto">
                    {official.map((entry) => {
                        const record = recordById.get(entry.id);
                        const upgradable = Boolean(record && hasUpgrade(record.version, entry.version));
                        const icon = entry.icon || <Puzzle className="size-4" />;
                        return row(
                            entry.id,
                            upgradable ? withUpgradeDot(icon) : icon,
                            entry.name,
                            upgradable && record ? `${record.version} → ${entry.version}` : entry.version,
                            entry.description,
                            record ? (
                                installedControls(record, upgradable)
                            ) : (
                                <Button type="primary" size="small" icon={<Download className="size-4" />} loading={busyId === entry.id} onClick={() => handleInstallOfficial(entry)}>
                                    安装
                                </Button>
                            ),
                        );
                    })}
                </div>
            )}
        </div>
    );

    const localTab = <div className="thin-scrollbar max-h-[52vh] space-y-2 overflow-auto">{localPlugins.map((record) => row(record.id, <Puzzle className="size-4" />, record.name, record.version, record.description || record.url, installedControls(record)))}</div>;

    const thirdPartyTab = (
        <div className="space-y-3">
            <div className="flex gap-2">
                <Input placeholder="粘贴插件 JS 的 URL" value={url} onChange={(event) => setUrl(event.target.value)} onPressEnter={handleInstallUrl} allowClear />
                <Button type="primary" loading={installing} onClick={handleInstallUrl} icon={<Puzzle className="size-4" />}>
                    安装
                </Button>
            </div>
            <div className="thin-scrollbar max-h-[42vh] space-y-2 overflow-auto">{thirdPartyPlugins.length === 0 ? emptyHint("还没有安装第三方插件") : thirdPartyPlugins.map((record) => row(record.id, <Puzzle className="size-4" />, record.name, record.version, record.description || record.url, installedControls(record)))}</div>
        </div>
    );

    const tabs = [
        { key: "official", label: "官方插件", children: officialTab },
        ...(localPlugins.length > 0 ? [{ key: "local", label: "本地插件", children: localTab }] : []),
        { key: "third", label: "第三方插件", children: thirdPartyTab },
    ];

    return (
        <Modal title="节点插件" open={open} onCancel={onClose} footer={null} centered width={640}>
            <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: "#f59e0b55", background: "#f59e0b14", color: theme.node.text }}>
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <span>插件代码会在画布页面内直接执行，可访问浏览器本地数据（含 AI API Key），请只安装可信来源的插件。</span>
                </div>
                <Tabs defaultActiveKey="official" items={tabs} />
            </div>
        </Modal>
    );
}

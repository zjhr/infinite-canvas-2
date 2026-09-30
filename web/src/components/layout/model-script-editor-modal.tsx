"use client";

import { CopyOutlined } from "@ant-design/icons";
import { Button, Input, Modal, Select, Space, Typography } from "antd";
import { useMemo, useState } from "react";

import { useCopyText } from "@/hooks/use-copy-text";
import { getScriptAuthoringPrompt, getScriptReturn, getScriptTemplates, getScriptVariables } from "@/services/api/model-script";
import type { LocalModelChannel } from "@/stores/use-config-store";

type ModelScriptEditorModalProps = {
    channel: LocalModelChannel;
    onSave: (modelScripts: Record<string, string>) => void;
    onCancel: () => void;
};

export function ModelScriptEditorModal({ channel, onSave, onCancel }: ModelScriptEditorModalProps) {
    const copyText = useCopyText();
    const scripts = channel.modelScripts || {};
    const models = channel.models.length ? channel.models : [""];
    const [model, setModel] = useState(() => models.find((item) => scripts[item]?.trim()) || models[0]);
    const [draft, setDraft] = useState(() => scripts[model]?.trim() || "");
    const variables = useMemo(() => getScriptVariables(), []);
    const templates = useMemo(() => getScriptTemplates(), []);

    const switchModel = (nextModel: string) => {
        setModel(nextModel);
        setDraft(scripts[nextModel]?.trim() || "");
    };

    const save = () => {
        const next = { ...scripts };
        if (draft.trim()) next[model] = draft.trim();
        else delete next[model];
        onSave(next);
    };

    return (
        <Modal
            title={
                <Space size={8}>
                    <span>自定义模型脚本</span>
                    <Typography.Text type="secondary">{channel.name}</Typography.Text>
                </Space>
            }
            open
            width={960}
            onCancel={onCancel}
            footer={
                <Space>
                    <Button danger disabled={!draft.trim()} onClick={() => setDraft("")}>
                        清空脚本
                    </Button>
                    <Button onClick={onCancel}>取消</Button>
                    <Button type="primary" onClick={save}>
                        保存
                    </Button>
                </Space>
            }
            destroyOnHidden
        >
            <div className="flex flex-col gap-3">
                <Space.Compact block>
                    <Select
                        showSearch
                        style={{ width: 320 }}
                        placeholder="选择要挂载脚本的模型"
                        value={model}
                        options={models.filter(Boolean).map((item) => ({ label: item, value: item }))}
                        onChange={switchModel}
                    />
                    <Button icon={<CopyOutlined />} onClick={() => copyText(getScriptAuthoringPrompt(model, draft), "代写提示词已复制，可粘贴给 AI 生成脚本")}>
                        复制代写提示词
                    </Button>
                </Space.Compact>
                <div className="flex gap-3">
                    <div className="w-72 shrink-0 space-y-2 overflow-y-auto rounded-md bg-stone-50 p-3 text-xs leading-5 text-stone-500 dark:bg-stone-900" style={{ maxHeight: 420 }}>
                        <div>
                            <div className="font-medium text-stone-700 dark:text-stone-200">返回值要求</div>
                            <div className="mt-1">{getScriptReturn()}</div>
                        </div>
                        <div>
                            <div className="font-medium text-stone-700 dark:text-stone-200">可用变量（点击插入）</div>
                            <div className="mt-1 space-y-1">
                                {variables.map((variable) => (
                                    <button key={variable.name} type="button" className="block w-full rounded px-1 py-0.5 text-left hover:bg-stone-200/60 dark:hover:bg-stone-800" onClick={() => setDraft((current) => (current ? `${current}\n${variable.name}` : variable.name))}>
                                        <code className="font-mono font-semibold text-stone-800 dark:text-stone-100">{variable.name}</code>
                                        <span className="ml-1 font-mono text-[10px] text-stone-400">{variable.type}</span>
                                        <div>{variable.desc}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <div className="font-medium text-stone-700 dark:text-stone-200">示例模板</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {templates.map((template) => (
                                    <Button key={template.label} size="small" onClick={() => setDraft(template.script)}>
                                        {template.label}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </div>
                    <Input.TextArea
                        className="flex-1 font-mono text-xs"
                        style={{ minHeight: 420 }}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={"async function generateVideo({ prompt, images, params, model, baseUrl, apiKey, http, poll }) {\n  // 创建任务 + 轮询，最后 return 视频 URL\n}"}
                        spellCheck={false}
                    />
                </div>
                <Typography.Text type="secondary">挂载脚本后，该模型在本地渠道模式下由脚本完全接管调用；云端渠道模式不生效。</Typography.Text>
            </div>
        </Modal>
    );
}

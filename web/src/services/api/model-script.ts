import axios from "axios";

import { buildApiUrl } from "@/stores/use-config-store";

export type ModelScriptCapability = "image" | "video" | "audio" | "text";

export type ModelScriptArgs = {
    capability: ModelScriptCapability;
    script: string;
    config: { baseUrl: string; apiKey: string; model?: string; systemPrompt?: string };
    prompt?: string;
    images?: string[];
    videos?: File[];
    audios?: File[];
    messages?: unknown[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

export type ScriptHttpOptions = { headers?: Record<string, string>; params?: Record<string, unknown>; responseType?: "json" | "text" | "blob" | "arraybuffer" };

export type ScriptVariable = { name: string; type: string; desc: string };

export type ScriptTemplate = { label: string; script: string };

function scriptSleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("已取消", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("已取消", "AbortError"));
            },
            { once: true },
        );
    });
}

function scriptUrl(config: ModelScriptArgs["config"], path: string) {
    if (/^https?:/i.test(path)) return path;
    return buildApiUrl(config.baseUrl, path.startsWith("/") ? path : `/${path}`);
}

function createScriptHttp(config: ModelScriptArgs["config"], signal?: AbortSignal) {
    const run = async (method: "get" | "post", path: string, body: unknown, opts?: ScriptHttpOptions) => {
        const isForm = typeof FormData !== "undefined" && body instanceof FormData;
        const response = await axios.request({
            method,
            url: scriptUrl(config, path),
            data: method === "post" ? body : undefined,
            params: opts?.params,
            headers: { ...(opts?.headers || (method === "post" && !isForm && body !== undefined ? { "Content-Type": "application/json" } : {})), Authorization: `Bearer ${config.apiKey}` },
            responseType: opts?.responseType || "json",
            signal,
        });
        return response.data;
    };
    return {
        url: (path: string) => scriptUrl(config, path),
        post: (path: string, body?: unknown, opts?: ScriptHttpOptions) => run("post", path, body, opts),
        get: (path: string, opts?: ScriptHttpOptions) => run("get", path, undefined, opts),
    };
}

/** 原始请求：不加任何默认头，鉴权头自己写；url 相对时按 baseUrl 拼接。 */
function createScriptRequest(config: ModelScriptArgs["config"], signal?: AbortSignal) {
    return async (requestConfig: { method?: string; url: string; headers?: Record<string, string>; params?: Record<string, unknown>; data?: unknown; responseType?: ScriptHttpOptions["responseType"] }) => {
        const response = await axios.request({ ...requestConfig, url: scriptUrl(config, requestConfig.url), signal });
        return response.data;
    };
}

/** 轮询：extract 返回真值即结束并作为结果返回，返回 falsy 继续轮询。 */
function createScriptPoll(signal?: AbortSignal) {
    return async function poll<T, R>(request: () => Promise<T>, extract: (value: T) => R | null | undefined | false, options?: { intervalMs?: number; timeoutMs?: number }): Promise<R> {
        const intervalMs = options?.intervalMs ?? 2500;
        const timeoutMs = options?.timeoutMs ?? 900000;
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            if (signal?.aborted) throw new DOMException("已取消", "AbortError");
            const result = extract(await request());
            if (result !== null && result !== undefined && result !== false) return result;
            if (performance.now() >= deadline) throw new Error("脚本轮询超时");
            await scriptSleep(intervalMs, signal);
        }
    };
}

/**
 * 执行用户编写的模型调用脚本。脚本以 async 函数体运行，变量见 getScriptVariables，必须 return 结果。
 */
export async function runModelScript<T = unknown>(args: ModelScriptArgs): Promise<T> {
    const { config } = args;
    const http = createScriptHttp(config, args.signal);
    const request = createScriptRequest(config, args.signal);
    const poll = createScriptPoll(args.signal);
    const runner = new Function(
        "prompt",
        "images",
        "videos",
        "audios",
        "messages",
        "params",
        "model",
        "baseUrl",
        "apiKey",
        "systemPrompt",
        "http",
        "request",
        "poll",
        "sleep",
        "signal",
        "onDelta",
        `"use strict"; return (async () => {\n${args.script}\n})();`,
    ) as (...fnArgs: unknown[]) => Promise<T>;
    try {
        return await runner(
            args.prompt || "",
            args.images || [],
            args.videos || [],
            args.audios || [],
            args.messages || [],
            args.params || {},
            config.model || "",
            config.baseUrl,
            config.apiKey,
            config.systemPrompt || "",
            http,
            request,
            poll,
            (ms: number) => scriptSleep(ms, args.signal),
            args.signal,
            args.onDelta,
        );
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isCancel(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`模型脚本执行失败：${message}`);
    }
}

export function getScriptVariables(): ScriptVariable[] {
    return [
        { name: "prompt", type: "string", desc: "用户输入的提示词（已拼接系统提示词）" },
        { name: "images", type: "string[]", desc: "参考图 dataURL 数组（图生视频 / 首尾帧时有值，下标 0 为首帧、1 为尾帧）" },
        { name: "videos", type: "File[]", desc: "参考视频 File 数组，可直接 form.append，无则为空数组" },
        { name: "audios", type: "File[]", desc: "参考音频 File 数组，可直接 form.append，无则为空数组" },
        { name: "params", type: "object", desc: "生成参数：{ mode, seconds, ratio, resolution, generateAudio, watermark }，mode 为 frames 首尾帧或 reference 全能参考" },
        { name: "model", type: "string", desc: "模型名称" },
        { name: "baseUrl", type: "string", desc: "渠道接口地址（原样，未拼 /v1）" },
        { name: "apiKey", type: "string", desc: "渠道 API Key，请求头里自己带上" },
        { name: "systemPrompt", type: "string", desc: "系统提示词原文" },
        { name: "http", type: "object", desc: "便捷请求：http.post(path, body, {headers,params,responseType})、http.get(path, opts)、http.url(path)；默认带 Authorization: Bearer apiKey；path 相对时按 baseUrl 拼 /v1" },
        { name: "request", type: "function", desc: "原始请求 request({ method, url, headers, params, data, responseType })，不加任何默认头，鉴权头自己写；url 相对时按 baseUrl 拼接（不加 /v1）" },
        { name: "poll", type: "function", desc: "轮询 poll(request, extract, {intervalMs,timeoutMs})，extract 返回真值即结束" },
        { name: "sleep", type: "function", desc: "sleep(ms) 延时" },
        { name: "signal", type: "AbortSignal", desc: "取消信号，可透传给 http/request" },
    ];
}

export function getScriptReturn() {
    return "脚本内部完成创建和轮询，返回 { url } / { video_url } / { result_url }、{ blob } 或视频 URL 字符串";
}

export function getScriptTemplates(): ScriptTemplate[] {
    return [
        {
            label: "OpenAI 兼容（表单 + 轮询）",
            script: `/**
 * OpenAI 兼容视频：POST /videos（multipart），再轮询 GET /videos/{id}。
 * 使用 FormData 时不要手动设置 Content-Type，交给浏览器带 boundary。
 */
async function generateVideo({ prompt, images, params, model, baseUrl, apiKey, request, poll }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("seconds", String(params.seconds || 5));
  if (params.mode === "frames" && images[0]) {
    form.append("first_frame", await (await fetch(images[0])).blob(), "first.png");
  }
  const created = await request({ method: "POST", url: baseUrl.replace(/\\/+$/, "") + "/videos", headers: { Authorization: "Bearer " + apiKey }, data: form });
  const id = created.id || created.task_id;
  const result = await poll(
    () => request({ method: "GET", url: baseUrl.replace(/\\/+$/, "") + "/videos/" + id, headers: { Authorization: "Bearer " + apiKey } }),
    (data) => {
      if (data.status === "failed") throw new Error(data.error?.message || "生成失败");
      return data.status === "completed" ? data : false;
    },
    { intervalMs: 3000 },
  );
  return result.url || result.video_url || result;
}`,
        },
        {
            label: "JSON 异步任务（如 Agnes）",
            script: `/**
 * JSON 异步任务：POST 创建任务，轮询查询接口直到完成。
 * images 是 dataURL 数组；要求公网 URL 的接口需先自行上传换取直链。
 */
async function generateVideo({ prompt, images, params, model, baseUrl, apiKey, http, poll }) {
  const created = await http.post("/videos", {
    model,
    prompt,
    mode: images.length ? "reference" : "text",
    seconds: String(params.seconds || 5),
    aspect_ratio: params.ratio || "16:9",
  });
  const videoId = created.video_id || created.id;
  const queryUrl = http.url("/agnesapi") + "?video_id=" + encodeURIComponent(videoId) + "&model_name=" + encodeURIComponent(model);
  const result = await poll(
    () => http.get(queryUrl),
    (data) => {
      if (data.status === "failed") throw new Error(data.error?.message || "生成失败");
      return data.status === "completed" ? data.metadata?.url : false;
    },
    { intervalMs: 3000, timeoutMs: 900000 },
  );
  return result;
}`,
        },
    ];
}

export function getScriptAuthoringPrompt(modelName: string, draft = "") {
    const lines = [
        `请为「无限画布」编写一个${modelName ? `「${modelName}」` : ""}视频模型的调用脚本。`,
        "",
        "脚本结构：async 函数体，末尾 return 结果；可用变量如下。",
        "",
        "返回值要求：",
        getScriptReturn(),
        "",
        "可用变量：",
        ...getScriptVariables().map((variable) => `- ${variable.name} (${variable.type}): ${variable.desc}`),
        "",
        "规则：",
        "- 写成 async function，参数列表列出用到的变量；params 拆开写出 seconds、size 等字段，函数上方用 /** */ 注释写清每个字段。",
        "- 用 request({ method, url, headers, params, data, responseType }) 发原始 HTTP 请求；需要自动带 Authorization: Bearer apiKey 时用 http.post / http.get。",
        "- 相对路径：request 按 baseUrl 拼接且不加 /v1；http 的相对 path 会按 baseUrl 拼 /v1。",
        "- 异步视频任务通常先创建再 poll(request, extract, { intervalMs, timeoutMs })，extract 返回真值即结束。",
        "- images 是参考图 dataURL 字符串数组。videos、audios 是参考视频/音频 File 数组，可直接 form.append(字段名, file)；没有参考时为空数组。",
        "- 使用 FormData 时不要手动设置 Content-Type，交给浏览器带 boundary。",
        "- 函数末尾 return 结果，并在文件最后 return await 函数名({ 同样的参数 })。只输出完整脚本，不要解释。",
    ];
    const templates = getScriptTemplates();
    if (templates.length) {
        lines.push("", "完整示例（请按实际接口改写，不要原样照搬）：");
        for (const template of templates) {
            lines.push("", template.label, template.script);
        }
    }
    if (draft.trim()) {
        lines.push("", "用户当前草稿（请在此基础上修改；若为空则从零编写）：", draft.trim());
    }
    return lines.join("\n");
}

# 画布视频节点（Agnes 模型）首次生成报 503 的调研

用户报告：画布新建视频节点、选用 Agnes 模型，第一次点「生成视频」总是提示 503，点【重试】后即可成功。本文结论基于源码阅读，未做线上抓包验证。

## 结论

**这不是本项目前端/画布代码的 bug，而是上游 Agnes 服务对首次请求返回 503（典型原因是模型实例冷启动/预热），项目缺少对它的自动重试，导致错误直接暴露给用户；手动点重试时实例已预热，所以成功。** 属于「上游冷启动 + 项目未做瞬时错误重试」的叠加，可以优化。

## 调用链证据

1. 画布视频节点的生成入口：`web/src/app/(user)/canvas/[id]/canvas-client-page.tsx:3276`（首次生成）与 `:3921`（重试）。两条路径最终都调用同一个 `createVideoGenerationTask(...)`，参数结构一致（仅 `clientTaskId` 后缀不同），因此**首次和重试在代码路径上没有本质差异**——排除「重试按钮走了不同分支」的可能。
2. 任务创建实现：`web/src/services/api/video.ts:111-142`。`createVideoGenerationTask` 通过 `axios.post` 一次性提交到 `/videos`（`video.ts:132`），没有任何针对 429/5xx 的重试逻辑。
3. Agnes 的识别与轮询：`video.ts:811-813`（模型名含 `agnes-video`）、`video.ts:62-69`（用 `video_id` 走 `/agnesapi?video_id=...` 轮询）。Agnes 是「POST 创建任务 → 轮询查询」的异步任务型协议（`web/src/services/api/model-script.ts:205-225` 的官方模板也印证了这一点）。
4. 503 报错来源：`createVideoGenerationTask` 的 catch（`video.ts:137-141`）把 axios 错误包装成 `VideoRequestError`，消息即上游返回的内容（含 503），画布节点随即进入 error 状态（`canvas-client-page.tsx:3230` 附近同样的处理模式）。

## 为什么重试能成功

- Agnes 服务端为异步任务型接口；上游模型实例冷启动期间，首个 POST `/videos` 常见返回 503（Service Unavailable）。这是服务端瞬时状态，稍后实例就绪即正常。
- 项目代码里**图像生成已经有针对 503 的自动重试**：`web/src/services/api/image.ts:379-400` 的 `requestWithTransientRetry`，把 `429/502/503/504` 视为瞬时错误自动重试 2 次（间隔 700ms×attempt），并在 9 处调用点使用。
- **视频生成（`video.ts`）没有使用这套重试**：`video.ts` 中仅一处 `axios.post`（`:132`），未调用 `requestWithTransientRetry`。这是图像与视频两条链路的不一致点，也就是用户「图像没事、视频第一次总失败」体验差异的代码层面解释。

## 定性

- 上游 503：外部服务行为，非本项目代码错误。
- 未自动重试：属于可改进项（鲁棒性缺口），是用户每次都要手动点重试的直接原因。

## 最小修复建议（如需实施）

在 `web/src/services/api/video.ts:132` 的创建任务请求外套用与 `image.ts:387-400` 相同的瞬时错误重试（把 `requestWithTransientRetry` 抽到公共模块或复制一份），对 429/502/503/504 自动重试 1-2 次，即可消除「首次必失败」的体验；轮询逻辑无需改动。

## 来源索引

| 结论 | 来源 |
| --- | --- |
| 首次/重试走同一函数 | `canvas-client-page.tsx:3276`、`:3921` |
| 创建请求无重试 | `video.ts:111-142`（仅 `:132` 一处 axios.post） |
| Agnes 为异步任务协议 | `video.ts:62-69`、`model-script.ts:205-225` |
| 错误包装路径 | `video.ts:137-141` |
| 图像链路已有 503 重试 | `image.ts:379-400` 及 9 处调用点 |

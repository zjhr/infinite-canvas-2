# 视频拼接节点插件

把画布上的多个视频按顺序首尾拼接成一个视频,并内置**帧级修剪台**:每段视频可展开胶片条,拖拽入/出点手柄或逐帧步进(1/30s)精确裁剪,播放头逐帧预览,`I`/`O` 快捷键快速打点。

## 使用

画布 → 底部工具栏「节点插件」→ 本地插件里启用「视频拼接」→ 右键画布或连接菜单创建「视频拼接」节点 → 把视频节点连到它(或在面板里点击候选卡片收集)→ 拖拽排序、✂ 展开帧级裁剪 → 「拼接」。

拼接采用 canvas 重绘 + MediaRecorder 实时录制(零依赖),输出 mp4(不支持时降级 webm),结果存浏览器 localforage,刷新后自动恢复。

## 开发

```bash
cd plugins/canvas/video-concat
bun install
bun run build     # 产物 dist/video-concat.js,并同步到 web/public/plugins/
bun run dev       # watch 构建,刷新画布即最新
bun run typecheck # tsc --noEmit
```

插件契约见 `plugins/canvas/sdk/README.md`(与旧版 infinite-canvas 插件生态同构)。

---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

- 视频拼接节点目前采用 MediaRecorder 实时录制（零依赖），成片时长与裁剪后总时长有约 0.1-0.2s 误差；后续可引入 WebCodecs + mp4 muxer 做帧精确、超实时速度的拼接渲染。

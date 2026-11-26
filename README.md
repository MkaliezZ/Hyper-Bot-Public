# Hyper Bot

[English](README.en.md) · [贡献指南](CONTRIBUTING.md) · [许可范围](LICENSE-NOTE.md)

Hyper Bot 是一个本机运行的专项 Bot 工作区。可以在不同工作区使用同一种 Bot，每组各自保存会话、材料和草稿。会话可主动开启本组共享记忆，预览页显示当轮引用，撤回记忆后新任务停止发送该条内容。

本次源码版本为 `0.1.0-dev.59`。内置十个英语教培 Bot、自媒体口播和素材简报，支持用 Skill 与 Harness 装配新的 Bot。

## 从源码部署

把公库链接交给 Agent，按 [Windows 和 macOS 的 Agent 部署说明](docs/Agent-deployment.md)安装并验收。部署需要 Node.js 24.9 或更新版本及 Python 3.11 或更新版本。启动后在 Bot 市场选择「英语教培」，即可生成互动 HTML、PPTX 和课后练习，也可以维护教培业务记录。

桌面端通过「维护中心 → 本机依赖」配置 DeepSeek 凭据和所需的本机运行时。内置口播和素材简报的依赖状态会显示在 Bot 卡片上。可选择「载入书店演练」查看合成样例。共享记忆在会话中默认关闭。

工作区默认存放在 `%LOCALAPPDATA%\HyperBot`。可以用 `HYPER_BOT_DATA_DIR` 指定独立路径，便于测试。运行 `npm run doctor` 检查本机组件，运行 `npm run check` 执行源码检查。

[Windows 使用说明](docs/Windows%20测试包使用.md) · [源码快照信息](PUBLICATION.json)

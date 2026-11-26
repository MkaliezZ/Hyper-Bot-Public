# Hyper Bot

[简体中文](README.md) · [Contributing](CONTRIBUTING.en.md) · [License scope](LICENSE-NOTE.en.md)

Hyper Bot is a local workspace for task-specific bots. Workspaces can use the same bot while keeping conversations, materials, and drafts separate. A conversation can opt in to workspace memory. The preview shows what was referenced, and new tasks stop sending a memory after it is revoked.

This source snapshot is version `0.1.0-dev.59`. It includes ten English teaching bots, talking-video scripts, and material briefs, with support for assembling new bots from skills and harnesses.

## Run from source

Give the repository link to your agent and ask it to follow the [Windows and macOS deployment guide](docs/Agent-deployment.md). Use Node.js 24.9 or newer and Python 3.11 or newer. The built-in teaching runtime covers interactive lessons, HTML and PPTX exports, student and teacher practice sheets, and local teaching records.

Use **Maintenance → Local dependencies** to configure DeepSeek credentials and register the local runtimes required by a bot. Bot cards show dependency status. The bookstore exercise includes synthetic materials. Workspace memory is off by default.

Workspace data defaults to `%LOCALAPPDATA%\HyperBot`. Set `HYPER_BOT_DATA_DIR` to use a separate test location. Run `npm run doctor` to check local components and `npm run check` to verify the source.

[Windows guide in Chinese](docs/Windows%20测试包使用.md) · [Source snapshot metadata](PUBLICATION.json)

# Hyper Bot

[简体中文](README.md) · [Contributing](CONTRIBUTING.en.md) · [License scope](LICENSE-NOTE.en.md)

Hyper Bot is a local workspace for task-specific bots. Workspaces can use the same bot while keeping conversations, materials, and drafts separate. A conversation can opt in to workspace memory. The preview shows what was referenced, and new tasks stop sending a memory after it is revoked.

This source snapshot is version `0.1.0-dev.67`. The Bot Plaza includes 10 English teaching bots, 20 self-media specialist bots, plus talking-video scripts and material briefs. Hyper Bot supports assembling bots from skills and harnesses. Create a group from the sidebar to chat with or assign tasks to selected bots, share local files, and save outputs to a folder you choose. The personal workspace also supports the Entity archive.

## Run from source

Give this repository link to an agent that can run commands on the target computer. The [Windows and macOS deployment guide](docs/Agent-deployment.md) covers teaching, media editing, transcription, and briefs.

| Dependency | Agent action |
| --- | --- |
| Git, Node.js 24.9+, npm, Python 3.11 | Reuse supported tools. Install the locked JavaScript dependencies, including the DeepSeek Harness SDK and Web Host, with `npm ci`. |
| Built-in English teaching | Run `npm run setup:teaching` to prepare HTML, PPTX, and practice generation. |
| Self Media Workbench and Hermes ACP | Run `npm run setup:integrations` to fetch the pinned checkouts and install dedicated Python environments. |
| FFmpeg, FFprobe, and faster-whisper | Install FFmpeg and FFprobe using the platform instructions. The integration installer downloads multilingual Whisper base weights, validates an offline CPU load, and saves the local runtime paths. |
| DeepSeek | Model features use a user-authorized `DEEPSEEK_API_KEY` from the local service environment. The agent can install and verify local features without it. |

Use **Maintenance → Local dependencies** to configure DeepSeek credentials and register the local runtimes required by a bot. Bot cards show dependency status. The bookstore exercise includes synthetic materials. Workspace memory is off by default.

Workspace data defaults to `%LOCALAPPDATA%\HyperBot` on Windows and `~/.local/share/HyperBot` on macOS. Set `HYPER_BOT_DATA_DIR` to use a separate test location. Run `npm run doctor` to check local components and `npm run check` to verify the source.

[Windows guide in Chinese](docs/Windows%20测试包使用.md) · [Source snapshot metadata](PUBLICATION.json)

# Windows 和 macOS 的 Agent 部署

把 [Hyper Bot 公库](https://github.com/MkaliezZ/Hyper-Bot-Public)交给能在目标电脑上执行命令的 Agent，请它按本说明安装并验收。Hyper Bot 自带英语教培服务和模板。课件、练习和业务记录存放在各自的本机工作区。初次安装需要网络，供 Agent 克隆仓库和下载依赖。

Agent 默认执行完整部署。优先复用符合版本的工具，为缺项执行安装。新部署推荐原生架构的 Python 3.11，各组件使用独立虚拟环境。Hermes ACP 接受 Python 3.11–3.13，已有 Python 3.14 也可继续用于教培。[Git 安装](https://git-scm.com/install/)、[Node.js 下载](https://nodejs.org/en/download)、[Python 下载](https://www.python.org/downloads/)。

## Windows x64

检查 `git --version`、`node --version`、`py -3.11 --version`、`ffmpeg -version` 和 `ffprobe -version`。只为缺失项执行对应的命令。

~~~powershell
winget install --exact --id Git.Git
winget install --exact --id OpenJS.NodeJS.LTS
winget install --exact --id Python.Python.3.11
winget install --exact --id Gyan.FFmpeg
winget install --exact --id "Microsoft.VCRedist.2015+.x64"
~~~

Visual C++ 运行库供 Windows 上的语音识别二进制使用，已有兼容版本时可复用。打开新终端使 PATH 生效。[CTranslate2 安装要求](https://opennmt.net/CTranslate2/installation.html)。

FFmpeg 也可以从本机已有安装复用，设置 `$env:HYPER_BOT_FFMPEG_DIR` 为同时包含 `ffmpeg.exe` 和 `ffprobe.exe` 的绝对目录。Agent 从新或已有的公库源码目录执行部署。如果使用其他受支持的 Python，将 `$hbPython` 指向其实际解释器。

~~~powershell
git clone --branch main https://github.com/MkaliezZ/Hyper-Bot-Public.git
cd Hyper-Bot-Public
$hbPython = (& py -3.11 -c "import sys; print(sys.executable)").Trim()
npm.cmd ci --include=optional
npm.cmd run setup:teaching -- $hbPython
npm.cmd run setup:integrations -- $hbPython
npm.cmd run build
npm.cmd run doctor
npm.cmd run test:teaching
npm.cmd run test:group
npm.cmd start
~~~

在浏览器打开启动命令打印的本机地址。Windows 源码安装也可运行 `npm.cmd run desktop` 启动桌面客户端。

## macOS

Apple Silicon 用 arm64，Intel Mac 用 x86_64。用 `node -p process.arch` 和 `python3.11 -c "import platform; print(platform.machine())"` 检查架构。Homebrew 已可用时，按缺项执行 `brew install git`、`brew install node@24`、`brew install python@3.11` 或 `brew install ffmpeg`。使用 Homebrew 的 `node@24` 时，将 `$(brew --prefix node@24)/bin` 加到终端和启动进程的 PATH 前面。若没有 Homebrew，使用目标电脑可用的系统包管理器或官方安装包，并在执行后确认版本。[FFmpeg 下载](https://ffmpeg.org/download.html)、[Homebrew FFmpeg](https://formulae.brew.sh/formula/ffmpeg)。

~~~sh
git clone --branch main https://github.com/MkaliezZ/Hyper-Bot-Public.git
cd Hyper-Bot-Public
hb_python="$(command -v python3.11)"
npm ci --include=optional
npm run setup:teaching -- "$hb_python"
npm run setup:integrations -- "$hb_python"
npm run build
npm run doctor
npm run test:teaching
npm run test:group
npm start
~~~

在浏览器打开启动命令打印的本机地址。运行中的 `npm start` 进程提供服务。

## 集成安装与验收

`setup:integrations` 会拉取锁定的 Self Media Workbench 与 Hermes Agent 源码，校验 FFmpeg 和 FFprobe，在独立环境安装 `requirements-asr.txt` 和可编辑安装的 `.[acp]`。它会下载锁定的多语种 faster-whisper base 权重并验证 CPU 离线加载。模型权重约 145 MB，首次下载需要留出时间和磁盘空间。重复运行会复用已有的源码、虚拟环境和完整模型文件。首次部署需要访问 GitHub、npm、PyPI 和 Hugging Face。[Self Media Workbench](https://github.com/MkaliezZ/self-media-workbench/tree/59589fc365e084de9b9bd0759714c07eaabd9b7b)、[Hermes ACP](https://github.com/NousResearch/hermes-agent/tree/0a62610f10cc34d696b2239b2c69fa1ba0f1ca63)、[语音模型](https://huggingface.co/Systran/faster-whisper-base/tree/ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66)。

首次下载默认走标准 HTTPS。下载中断后，在同一目录重跑安装命令可复用下载缓存。已有明确配置的 `HF_HUB_DISABLE_XET` 仍然生效。[Hugging Face 下载环境变量](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables#hf_hub_disable_xet)。

路径保存在仓库的 `.hyper-bot/agent-runtimes.env`，启动应用和 `doctor` 时会自动读取。明确设置的启动变量及桌面单独登记的路径优先。若校验指向过时的路径，Agent 检查当前启动环境和登记项。配置仅记录路径和运行选项。模型凭据通过授权的启动环境传入。

1. 从新终端运行 `npm run doctor`。确认 `dsh.installed`、`dsh.webHost`、`workbench.ok`、`hermes.ok`、`teaching.ok` 和 `teaching.lessons.ok` 均为 true。
2. 在「Bot广场 → 自媒体」用合成短视频试跑「自动剪辑」并下载 MP4。再用含清晰语音的合成录音试跑「语音转录」，确认能看到实际逐字稿。Agent 可用 macOS 的 `say` 或 Windows 的 `System.Speech` 生成测试语音。用英文合成录音时，可为隔离测试进程设置 `SELF_MEDIA_LANGUAGE=en`。
3. 复用用户授权的 `DEEPSEEK_API_KEY` 试跑「素材简报」和模型对话。缺少凭据时，可用 `npm run test:integration` 的本机模型协议夹具校验 DSH 和 Hermes。先完成本地验收，再说明哪些在线任务等待凭据。
4. 仅部署英语教培时可跳过 `setup:integrations`。教培课件、练习和记录使用内置运行时。

## 更新已有部署

在现有的公库源码目录检查 `git remote get-url origin`，确认远端指向 [Hyper Bot 公库](https://github.com/MkaliezZ/Hyper-Bot-Public)。在 `main` 分支执行 `git pull --ff-only origin main`，再重复对应平台的依赖安装和构建步骤。退出之前启动的 Hyper Bot 进程，从更新后的源码目录执行启动命令，并使用它打印的地址。

启动后另开终端，在同一个源码目录运行下列命令。Windows PowerShell 使用 `npm.cmd`。如果启动时显示另一个端口，传入那个地址。

~~~sh
npm run verify:deployment -- http://127.0.0.1:4367
~~~

该命令核对前后端的版本和实际提供的 HTML、JS、CSS，并验收工作区接口里的 20 个自媒体专项 Bot 和 10 个英语教培 Bot，以及群组服务。新版「Bot广场」默认在「全部」展示 32 个内置 Bot，包括原有的自媒体口播和素材简报。如果静态文件不一致，检查终端是否继承了指向旧构建的 `HYPER_BOT_FRONTEND_ASSETS`。macOS 可在启动前执行 `unset HYPER_BOT_FRONTEND_ASSETS`，然后用启动输出的地址重新打开页面。

## 验收群组

1. 启动后，打开侧栏「群组 → 新建群组」。填入群名并勾选 Bot。点击「选择文件夹」为群组选择一个已存在的本机目录。macOS 会打开系统目录选择窗口，建议从登录桌面的终端启动 Hyper Bot。选择窗口不可用时，可以输入绝对路径。
2. 用 `@课上互动课件 简述你的功能。` 验证群聊。再上传一份合成 TXT 教材，选择「派发任务」并请同一个 Bot 生成课件。在右栏查看 HTML 和 PPTX，并检查选定目录下的「群组文档」里确实出现了这两份文件。普通追问使用 Hyper Bot 的 DeepSeek 凭据。
3. 已有工作区仍可从「群组」列表打开。首次进入旧工作区时，按提示绑定目录，再到「Bot广场」添加成员。群组对话和文件分开保存。备份还原后，为恢复的群组选一个新目录即可重建文件副本。

## 验收英语教培

1. 在 `npm run doctor` 的 JSON 输出中确认 `teaching.ok` 和 `teaching.lessons.ok` 都为 true。运行 `npm run test:teaching`，检查课件生成、练习生成、教培记录和模型协议测试结果。
2. 打开「Bot广场 → 英语教培 → 课上互动课件」，用一份合成 TXT 教材生成课件，打开互动预览并下载 PPTX。测试时可以用 `HYPER_BOT_DATA_DIR` 指向单独目录。常用工作区保留原来的数据目录。
3. 同一分类下可以打开「课后练习设计」「运营校历」「政策与热点」「续费与跟进」「运营数据导入」「学员档案」「课程段关联」「学习记录」和「教培任务助手」。
4. 使用教培任务助手时，在启动服务的环境中提供已有的 `DEEPSEEK_API_KEY`，重启服务后在「维护中心 → 本机依赖」确认凭据就绪。其余九个教培 Bot 的本机流程可直接验收。政策与热点中的订阅刷新会读取对应来源。

「运营数据导入」支持两种 CSV。续费名单使用以下表头。

~~~csv
id,label,track,endOn,remainingLessons,attendancePct,feedback,issue,state,contactAllowed,lastContactOn
~~~

历史结果使用以下表头。

~~~csv
id,track,asOf,endOn,observedThrough,renewed,arm,randomized,experimentId,feedback,attendancePct,state
~~~

导入续费名单后，可在「续费与跟进」登记联系结果。登记学员后，可在「课程段关联」选取课程段，在「学习记录」选取已生成的课件或练习。

如果 4367 端口已占用，Agent 可以为新进程选用空闲端口并设置 `HYPER_BOT_PORT`，再把实际地址交给用户。依赖检查失败时，先确认当前 Node.js、Python 和仓库路径，再重跑相应的安装步骤。

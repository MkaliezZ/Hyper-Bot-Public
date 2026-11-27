# Windows 和 macOS 的 Agent 部署

把 [Hyper Bot 公库](https://github.com/MkaliezZ/Hyper-Bot-Public)交给能在目标电脑上执行命令的 Agent，请它按本说明安装并验收。Hyper Bot 自带英语教培服务和模板。课件、练习和业务记录存放在各自的本机工作区。初次安装需要网络，供 Agent 克隆仓库和下载依赖。

Agent 应先检查本机的 Git、Node.js 和 Python 版本，缺失时通过系统包管理器或官方安装包补齐，再打开新终端确认命令可用。[Git 安装](https://git-scm.com/install/)、[Node.js 下载](https://nodejs.org/en/download)、[Python 下载](https://www.python.org/downloads/)。

## Windows x64

准备 Git、Node.js 24.9 或更新版本、npm 和 Python 3.11 或更新版本。新装建议选用 Python 3.14 x64，并让 PowerShell 能找到 `python.exe`。

~~~powershell
git clone https://github.com/MkaliezZ/Hyper-Bot-Public.git
cd Hyper-Bot-Public
node --version
python --version
npm.cmd ci
npm.cmd run setup:teaching -- python
npm.cmd run build
npm.cmd run doctor
npm.cmd run test:teaching
npm.cmd start
~~~

在浏览器打开 [Hyper Bot](http://127.0.0.1:4367/)。Windows 源码安装也可以用 `npm.cmd run desktop` 打开桌面窗口。

## macOS

准备 Git、Node.js 24.9 或更新版本、npm 和 Python 3.11 或更新版本。新装建议选用 Python 3.14。Apple Silicon 使用 arm64 的 Node.js 和 Python，Intel Mac 使用 x86_64。Agent 应选实际安装的 Python 命令或绝对路径，例如 `python3.14`。

~~~sh
git clone https://github.com/MkaliezZ/Hyper-Bot-Public.git
cd Hyper-Bot-Public
node --version
python3.14 --version
npm ci
npm run setup:teaching -- python3.14
npm run build
npm run doctor
npm run test:teaching
npm start
~~~

在浏览器打开 [Hyper Bot](http://127.0.0.1:4367/)。这套步骤部署源码和本机浏览器入口。运行中的 `npm start` 进程提供服务。

## 更新已有部署

在现有的公库源码目录检查 `git remote get-url origin`，确认远端指向 [Hyper Bot 公库](https://github.com/MkaliezZ/Hyper-Bot-Public)。在 `main` 分支执行 `git pull --ff-only origin main`，再重复对应平台的依赖安装和构建步骤。退出之前启动的 Hyper Bot 进程，从更新后的源码目录执行启动命令，并使用它打印的地址。

启动后另开终端，在同一个源码目录运行下列命令。Windows PowerShell 使用 `npm.cmd`。如果启动时显示另一个端口，传入那个地址。

~~~sh
npm run verify:deployment -- http://127.0.0.1:4367
~~~

该命令核对前后端的版本和实际提供的 HTML、JS、CSS，并验收工作区接口里的 20 个自媒体专项 Bot 和 10 个英语教培 Bot。新版「Bot广场」默认在「全部」展示 32 个内置 Bot，包括原有的自媒体口播和素材简报。如果静态文件不一致，检查终端是否继承了指向旧构建的 `HYPER_BOT_FRONTEND_ASSETS`。macOS 可在启动前执行 `unset HYPER_BOT_FRONTEND_ASSETS`，然后用启动输出的地址重新打开页面。

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


## 启用自媒体专项 Bot

「自媒体」下的 20 个专项 Bot 使用独立的 Self Media Workbench。使用英语教培时，沿用前面 Hyper Bot 自带的教培依赖。先安装锁定版本的自媒体工作台，并设置其仓库根目录与 Python 解释器，随后重新启动 Hyper Bot。[Self Media Workbench 固定提交](https://github.com/MkaliezZ/self-media-workbench/tree/59589fc365e084de9b9bd0759714c07eaabd9b7b)。

在 Hyper Bot 源码目录打开终端，把工作台克隆到同级目录。

~~~sh
git clone https://github.com/MkaliezZ/self-media-workbench.git ../self-media-workbench
git -C ../self-media-workbench checkout --detach 59589fc365e084de9b9bd0759714c07eaabd9b7b
~~~

macOS 在同一个终端执行以下命令。示例使用工作台支持的 Python 3.11，替换为本机实际安装的命令即可。

~~~sh
export HYPER_BOT_WORKBENCH_ROOT="$(cd ../self-media-workbench && pwd -P)"
python3.11 -m venv "$HYPER_BOT_WORKBENCH_ROOT/.venv"
export HYPER_BOT_WORKBENCH_PYTHON="$HYPER_BOT_WORKBENCH_ROOT/.venv/bin/python"
"$HYPER_BOT_WORKBENCH_PYTHON" -m pip install -r "$HYPER_BOT_WORKBENCH_ROOT/requirements.txt"
npm run doctor
~~~

Windows PowerShell 在同一个终端执行以下命令，使用实际安装的 Python 3.11 或更新版本。

~~~powershell
$env:HYPER_BOT_WORKBENCH_ROOT = (Resolve-Path ../self-media-workbench).Path
python -m venv "$env:HYPER_BOT_WORKBENCH_ROOT/.venv"
$env:HYPER_BOT_WORKBENCH_PYTHON = "$env:HYPER_BOT_WORKBENCH_ROOT/.venv/Scripts/python.exe"
& $env:HYPER_BOT_WORKBENCH_PYTHON -m pip install -r "$env:HYPER_BOT_WORKBENCH_ROOT/requirements.txt"
npm.cmd run doctor
~~~

- 查看 `doctor` 的 `workbench.ok`。账号分析、对标拆解、选题等模型任务还需要在同一启动环境提供自己的 `DEEPSEEK_API_KEY`。
- 剪辑、打点和成片导出需要 FFmpeg 与 FFprobe。确保两个命令在启动进程的 PATH 里，或将 `HYPER_BOT_FFMPEG_DIR` 指向同时包含两者的绝对目录。
- 转录和字幕使用另行安装的语音模型。根据目标电脑安装 Workbench 的 `requirements-asr.txt` 或 Apple Silicon 的 `requirements-mlx.txt`，并在 Hyper Bot 启动环境中设置 `SELF_MEDIA_MODEL`（CTranslate2 模型目录）或 `SELF_MEDIA_MLX_MODEL`（MLX 模型目录）。可选地令 `SELF_MEDIA_ASR_BACKEND` 和 `SELF_MEDIA_DEVICE` 匹配实际设备。[语音模型和平台说明](https://github.com/MkaliezZ/self-media-workbench/blob/59589fc365e084de9b9bd0759714c07eaabd9b7b/README.md)。

确认「Bot广场 → 自媒体」出现 22 个 Bot，再用合成短片试跑「自动剪辑」并下载 MP4。只有启用相应的运行依赖后，对应任务才会执行。

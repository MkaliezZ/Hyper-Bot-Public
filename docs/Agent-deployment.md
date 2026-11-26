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

## 验收英语教培

1. 在 `npm run doctor` 的 JSON 输出中确认 `teaching.ok` 和 `teaching.lessons.ok` 都为 true。运行 `npm run test:teaching`，检查课件生成、练习生成、教培记录和模型协议测试结果。
2. 打开「Bot 市场 → 英语教培 → 课上互动课件」，用一份合成 TXT 教材生成课件，打开互动预览并下载 PPTX。测试时可以用 `HYPER_BOT_DATA_DIR` 指向单独目录。常用工作区保留原来的数据目录。
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

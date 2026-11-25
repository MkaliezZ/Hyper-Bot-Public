# Hyper Bot Windows 11 x64 验收

验收工具与指定的候选包及回滚包配套。工具使用两版发行件里的应用与 Node、固定版 Playwright 和合成工作区。两份应用 ZIP 与校验摘要应随工具一起保留。测试结果写入新建目录。

若该版本提供配套离线介质，可在已授权的干净 Windows 11 挂载镜像，再从光盘根目录运行 `Run-Win11-Qa.ps1 -CleanImage 'Win11-x64-qa-01'`。环境编号按实测设备或快照填写。

## 基础验收

1. 准备一台已授权的 Windows 11 x64 PC，或该系统的干净虚拟机快照。记下测试设备代号或快照编号。在交互式桌面会话运行工具。
2. 将候选 ZIP、回滚 ZIP 和验收工具 ZIP 放到同一目录。用 `Get-FileHash -Algorithm SHA256` 核对归档和随附摘要。解压候选包和验收工具。保留两份应用 ZIP。
3. 在含有「验收清单.json」的验收工具目录打开 PowerShell，用候选包内的 Node 运行命令。归档和候选应用目录放在工具目录的上一层。将 `Win11-x64-qa-01` 改为本次的环境编号。

```powershell
$kit = (Get-Location).Path
$archives = Split-Path -Parent $kit
$plan = Get-Content -LiteralPath (Join-Path $kit '验收清单.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$node = Join-Path (Join-Path $archives $plan.candidate.folder) 'resources\node\node.exe'
$qa = Join-Path $kit 'scripts\test-windows-target.mjs'
& $node $qa --candidate (Join-Path $archives $plan.candidate.name) --previous (Join-Path $archives $plan.previous.name) --clean-image 'Win11-x64-qa-01' --out (Join-Path $archives 'Windows11-基础验收')
```

工具读取系统产品类型、构建号和 x64 架构，同时核对目标包、旧包、工具和合成工作区。使用新的取证目录，并将测试数据放到独立临时目录。基础验收包括空工作区启动、缺依赖提示、原生窗口与托管进程、旧稿读取和回滚、原地址恢复、自动重试与手动重连、Markdown、来源 JSON、单版成果和停用 Bot 历史四种导出的同名另存与授权复查。单版成果包额外验证锁定选中的版本、同名时改名或取消、保存前复查授权，以及退出应用后独立解包。dev.18 起还验证限期备份恢复、到期清理、确认退场和独立导出回读。dev.19 起增加桌面窗口身份、事件流重连和其他窗口拒绝检查。另用本机协议夹具运行 DSH Web Host 与 SDK，检查生成、私有连接、重启回读和停止。dev.30 增加原生凭据配置、加密更换、原地址重连、回滚、备份排除、启动环境回退及假凭据在真实 DSH 请求中的应用。

## 接入工作台和 Hermes 后

按测试包说明准备固定版本的 Self Media Workbench 和 Hermes ACP，并在 PowerShell 中设置 `HYPER_BOT_WORKBENCH_ROOT`、`HYPER_BOT_WORKBENCH_PYTHON`、`HYPER_BOT_HERMES_ROOT` 和 `HYPER_BOT_HERMES_PYTHON`。四个值均使用绝对路径，并让 `git` 可用。用同一命令加 `--integrations`，为 `--out` 换一个新目录。

集成验收使用真实的已登记运行时与工作台，通过本机模型协议夹具验首稿、续稿、写入核对、Hermes 简报、Skill 与 Harness 的版本绑定，以及已授权材料的跨版本续接与撤回。另核对原任务的取消终态、取消连接失联、迟到完成回执及回收子进程后的中断状态。端口被占用时启动应保留原任务记录，释放端口后才恢复原执行结果。成果包用独立样例核对口播版本链、简报同名材料和逐条引用位置。Skill 撤销覆盖引用同一规则的双 Harness、待审批和已开始的写入、候选导入与验证、旧成果导出及回滚。dev.31 增加已安装工作台和 Hermes 的桌面登记。验收用选取结果夹具进入系统选择逻辑，再检查真实锁定版本、Python、原地址重连与原会话续作。dev.32 核对工作台自带口播流程的锁定原件、零 Skill 装配、验证后启用、审批回读及回滚。请将领域读审、真人试用和正式发行验收的记录附在各自的证据中。

## 查看结果

dev.36 的集成回执额外核对口播候选在独立项目的保存与回读、真实工作台拒绝后的启用拦截，以及重启后清理残余演练数据。旧版已启用的配置继续可用，未启用的旧口播候选须补做回读。dev.37 另外核对时长工具摘要、逐镜估算、预留间隔、批准后的实际保存及导出。dev.38 核对审批前退回修改、旧审批失效、同项目单次写入、跨会话隔离与授权撤回。dev.39 验证口播和字幕的依据提示，覆盖候选样例、退回后重算、工作台回读、成果包和回滚后撤回材料。

dev.41 核对确认未写入后带回待审分镜的流程，覆盖项目修订冲突、审批超时和服务重启。再次生成使用原项目当前修订，单独请求写入审批。

dev.42 验证 DSH Web Host 与 Hermes ACP 收到禁用的模型工具响应时以失败结算，保留原始拦截原因。两个合成用例的审批和成果写入均为零。

dev.43 在桌面冷启动前核对实际解压的应用文件。通过 Windows 读取产品名、文件版本及关联图标，并将图标与随包的 Hyper Bot 标记比对。

dev.54 的验收工具还覆盖 DSH Web Host 在会话创建前超时后的单次重启。回执核对候选验证与用户会话的实际提交次数，另检查连续超时、取消、身份拒绝及受理回执丢失。基础验收即可运行这些用例。

dev.55 工具配套 dev.54 回滚包。开启集成验收后，还会在真实工作台的两个准备点分别执行停止。回执记录启动握手和读取项目列表时的停止结算，并核对零项目写入、零模型请求及工作台进程复用。

dev.56 工具配套 dev.55 回滚包。Hermes ACP 使用应用选定的模型，集成验收会核对受控模型请求、取消和 Skill 撤销。

dev.45 的浏览器回归覆盖中文选词确认与主动发送。使用目标系统自带的输入法时，可在书店演练中确认候选词、继续编辑原草稿并用 Shift+Enter 换行。主动按 Ctrl+Enter 后核对任务只有一次受理。

`Windows 验收回执.json` 记录两版包摘要、Windows 构建与架构、操作员提供的环境编号，以及已执行的检查。各脚本日志用来复查具体过程。原生测试自动提供保存对话框的测试路径或取消结果，便于验证实际导出、同名保护和授权复查。

使用 `--rehearsal` 可在开发机演练相同脚本。回执中的 `targetEvidence` 在演练模式保持待验证。真实 Windows 11 现场才会记录相应的目标系统证据。快照是否属于干净环境由现场人员记录。


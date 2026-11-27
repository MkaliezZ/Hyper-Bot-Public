import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { agentRuntimeSettingsFile, HERMES_REVISION, root, WB_REVISION } from '../server/config.mjs';

const runtimeDirectory=path.join(root,'.hyper-bot','agent-runtimes');
const windows=process.platform==='win32';
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='DEEPSEEK_API_KEY'));
const modelFiles=['config.json','model.bin','tokenizer.json','vocabulary.txt'];

function run(program,args,cwd=root) {
  execFileSync(program,args,{cwd,env:environment,stdio:'inherit',windowsHide:true});
}

function capture(program,args) {
  return execFileSync(program,args,{cwd:root,env:environment,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true}).trim();
}

function ffmpegDirectory() {
  const bins=['ffmpeg','ffprobe'].map(name=>name+(windows?'.exe':''));
  const explicit=environment.HYPER_BOT_FFMPEG_DIR;
  const directories=explicit?[explicit]:(environment.PATH??environment.Path??'').split(path.delimiter);
  const chocolatey=windows&&(process.env.ChocolateyInstall??path.join(process.env.ProgramData??'C:\\ProgramData','chocolatey'));
  const candidates=directories.filter(path.isAbsolute).flatMap(directory=>{
    if(explicit||!chocolatey||path.relative(path.join(chocolatey,'bin'),directory))return [directory];
    // Chocolatey's launchers cannot start in Workbench's extended-length Windows paths.
    return ['ffmpeg','ffmpeg-full','ffmpeg-shared'].map(name=>path.join(chocolatey,'lib',name,'tools','ffmpeg','bin'));
  });
  for(const directory of candidates){
    const files=bins.map(bin=>path.join(directory,bin));
    if(!files.every(existsSync))continue;
    try {
      for(const file of files)capture(file,['-version']);
      return directory;
    }catch { /* Try the next directory on PATH. */ }
  }
  throw new Error('找不到可执行的 FFmpeg 和 FFprobe。请按部署说明安装或更正 HYPER_BOT_FFMPEG_DIR，再重跑。');
}

function checkout(name,url,revision) {
  const directory=path.join(runtimeDirectory,name+'-'+revision.slice(0,12));
  mkdirSync(directory,{recursive:true});
  if(!existsSync(path.join(directory,'.git')))run('git',['init','--quiet',directory]);
  let head;
  try {head=capture('git',['-C',directory,'rev-parse','--verify','HEAD']);}
  catch { /* The managed checkout has not fetched any commit yet. */ }
  if(capture('git',['-C',directory,'status','--porcelain','--untracked-files=no'])){
    throw new Error('运行时源码有本地改动。请使用干净的安装目录。'+directory);
  }
  if(head!==revision){
    if(windows)run('git',['-C',directory,'config','core.longpaths','true']);
    run('git',['-C',directory,'fetch','--depth','1',url,revision]);
    run('git',['-C',directory,'checkout','--detach',revision]);
  }
  return directory;
}

function virtualEnvironment(python,source) {
  const directory=source+'-python';
  const executable=path.join(directory,windows?'Scripts/python.exe':'bin/python');
  if(!existsSync(executable))run(python,['-m','venv',directory]);
  return executable;
}

function prepareSpeechModel(python,directory) {
  if(!modelFiles.every(file=>existsSync(path.join(directory,file)))){
    run(python,['-c',[
      'import json, os, sys',
      'os.environ.setdefault("HF_HUB_DISABLE_XET", "1")',
      'from huggingface_hub import snapshot_download',
      'snapshot_download("Systran/faster-whisper-base", revision="ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66", local_dir=sys.argv[1], allow_patterns=json.loads(sys.argv[2]))'
    ].join('\n'),directory,JSON.stringify(modelFiles)]);
  }
  run(python,['-c',
    'from faster_whisper import WhisperModel; import sys; WhisperModel(sys.argv[1], device="cpu", compute_type="int8", local_files_only=True)',
    directory]);
}

function saveSettings(settings) {
  const entries=Object.entries(settings).map(([key,value])=>[
    key,windows&&path.isAbsolute(value)?value.replaceAll('\\','/'):value
  ]);
  const text=entries.map(([key,value])=>{
    const quote=["'","`",'"'].find(mark=>!value.includes(mark));
    if(!quote||/[\r\n]/.test(value))throw new Error('部署路径包含无法写入配置文件的字符。');
    return key+'='+quote+value+quote;
  }).join('\n')+'\n';
  const parsed=parseEnv(text);
  if(entries.some(([key,value])=>parsed[key]!==value)){
    throw new Error('部署路径无法按原样写入配置。');
  }
  const draft=agentRuntimeSettingsFile+'.'+process.pid+'.tmp';
  writeFileSync(draft,text,{mode:0o600});
  renameSync(draft,agentRuntimeSettingsFile);
}

function setup() {
  const python=process.argv[2]??(windows?'python':'python3.11');
  const supported='import sys; sys.exit(not ((3, 11) <= sys.version_info[:2] <= (3, 13)))';
  try {run(python,['-c',supported]);}
  catch {throw new Error('请选择 Python 3.11 至 3.13 的解释器。一般新部署使用 Python 3.11。');}
  const ffmpeg=ffmpegDirectory();
  const workbench=checkout('self-media-workbench','https://github.com/MkaliezZ/self-media-workbench.git',WB_REVISION);
  const workbenchPython=virtualEnvironment(python,workbench);
  run(workbenchPython,['-m','pip','install','--disable-pip-version-check','--only-binary=:all:','-r',path.join(workbench,'requirements-asr.txt')]);
  const hermes=checkout('hermes-agent','https://github.com/NousResearch/hermes-agent.git',HERMES_REVISION);
  const hermesPython=virtualEnvironment(python,hermes);
  run(hermesPython,['-m','pip','install','--disable-pip-version-check','-e','.[acp]'],hermes);
  run(hermesPython,['-B','-c','from acp_adapter.server import HermesACPAgent'],hermes);
  const model=path.join(runtimeDirectory,'faster-whisper-base');
  prepareSpeechModel(workbenchPython,model);
  saveSettings({HYPER_BOT_WORKBENCH_ROOT:workbench,HYPER_BOT_WORKBENCH_PYTHON:workbenchPython,
    HYPER_BOT_HERMES_ROOT:hermes,HYPER_BOT_HERMES_PYTHON:hermesPython,
    HYPER_BOT_FFMPEG_DIR:ffmpeg,SELF_MEDIA_ASR_BACKEND:'faster-whisper',SELF_MEDIA_DEVICE:'cpu',SELF_MEDIA_MODEL:model});
  console.log('已准备自媒体工作台、FFmpeg、faster-whisper 模型和 Hermes ACP。运行 npm run doctor 核对安装结果。');
}

try {
  setup();
} catch(error) {
  console.error('运行时安装未完成。'+error.message);
  process.exitCode=1;
}

import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Problem } from './contracts.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const require=createRequire(import.meta.url);
export const WB_REVISION = '59589fc365e084de9b9bd0759714c07eaabd9b7b';
export const HERMES_REVISION = '0a62610f10cc34d696b2239b2c69fa1ba0f1ca63';
export const DSH_VERSION = '0.2.2-rc.1';

const windowsEnv = new Set(['path','systemroot','windir','comspec','pathext','userprofile','localappdata','appdata',
  'temp','tmp','homedrive','homepath','programfiles','programfiles(x86)','programdata','number_of_processors','processor_architecture',
  'lang','lc_all','node_extra_ca_certs','ssl_cert_file','home']);
export function processEnvironment(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => windowsEnv.has(name.toLowerCase()))),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...extra };
}

async function resolveInstallation() {
  const file=path.join(homedir(),'.codex','skills','media-workbench','location.json');
  try {
    const entry=JSON.parse(await readFile(file,'utf8'));
    return typeof entry?.root==='string'&&entry.root.trim() ? {
      root:entry.root,python:typeof entry.python==='string'?entry.python:undefined
    } : {};
  } catch {return {};}
}

const issue=(code,reason,details={})=>({ok:false,code,reason,...details});
const temporaryProcessError=error=>error?.killed&&error.signal==='SIGTERM' ||
  ['EAGAIN','EBUSY','ETIMEDOUT'].includes(error?.code);
export async function retryLocalCheck(check,signal) {
  signal?.throwIfAborted();
  try { return await check(false); }
  catch(error) {
    signal?.throwIfAborted();
    if (!temporaryProcessError(error)) throw error;
    await delay(200,null,{signal});
    return check(true);
  }
}
const localRuntimes={
  workbench:{entry:'workbench.py',revision:WB_REVISION,modules:['fastapi','uvicorn','pydantic']},
  hermes:{entry:'acp_adapter/server.py',revision:HERMES_REVISION,modules:['acp','dotenv','openai','pydantic'],maxMinor:13}
};

function normalizedPath(value) {
  const normalized=path.normalize(value);
  return process.platform==='win32'?normalized.toLowerCase():normalized;
}

function matchesBlob(bytes,digest) {
  const hash=value=>createHash(digest.length===40?'sha1':'sha256')
    .update('blob '+value.length+'\0').update(value).digest('hex');
  return hash(bytes)===digest || hash(Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n')))===digest;
}

async function installed(directory,entry,expected,signal,retry=false) {
  if(!directory)return issue('unconfigured','未找到已登记的组件。');
  let top,executable;
  try {
    top=await realpath(directory);
    executable=path.join(top,entry);
    const info=await lstat(executable);
    if (!info.isFile() || info.isSymbolicLink() || normalizedPath(await realpath(executable))!==normalizedPath(executable)) {
      return issue('entry_missing','组件入口须位于所选安装目录内。');
    }
    if (info.size>1024*1024) return issue('modified','组件入口与锁定版本不同。');
  } catch {return issue('entry_missing','已配置目录里找不到组件入口。');}
  const git=(args,timeout)=>{
    const command=again=>exec('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',top,...args],
      {windowsHide:true,timeout:again?timeout+5000:timeout,signal,env:processEnvironment()});
    return retry?retryLocalCheck(command,signal):command(false);
  };
  try {
    const {stdout}=await git(['rev-parse','--show-toplevel','HEAD','HEAD:'+entry],3000);
    const [root,revision,digest]=stdout.trim().split(/\r?\n/);
    if (!root || normalizedPath(root)!==normalizedPath(top))return issue('repository_root','请选择该组件的 Git 仓库根目录。');
    if (!/^[a-f0-9]{40,64}$/.test(revision))return issue('revision_unknown','无法确认组件提交。');
    if (revision!==expected)return issue('version_mismatch','当前提交与已锁定版本不同。',{revision});
    if (!/^[a-f0-9]{40,64}$/.test(digest) || !matchesBlob(await readFile(executable),digest)) {
      return issue('modified','组件入口与锁定版本不同。',{revision});
    }
    const modified=await git(['status','--porcelain','--untracked-files=no'],10000);
    if (modified.stdout.trim())return issue('modified','组件有尚未核验的源码改动。',{revision});
    return {ok:true,revision};
  } catch(error) {
    signal?.throwIfAborted();
    if (temporaryProcessError(error)) return issue('revision_check_timeout','组件版本检查暂未完成，请重试。');
    return error.code==='ENOENT'
      ? issue('git_missing','当前启动环境找不到 Git。')
      : issue('revision_unknown','无法确认组件提交。');
  }
}

const pythonProbe=[
  'import importlib.util, json, sys',
  'sys.path = [entry for entry in sys.path if entry]',
  'version = list(sys.version_info[:3])',
  'missing = [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]',
  'print(json.dumps({"version": version, "missing": missing}))'
].join('\n');

async function pythonAvailability(executable,modules,maxMinor) {
  try {
    const {stdout}=await exec(executable,['-E','-B','-X','utf8','-c',pythonProbe,...modules],
      {cwd:root,windowsHide:true,timeout:4500,maxBuffer:32000,env:processEnvironment()});
    const {version,missing}=JSON.parse(stdout);
    if(version.length!==3 || !version.every(Number.isSafeInteger) ||
       !Array.isArray(missing) || !missing.every(name=>modules.includes(name)))throw new Error('Unexpected Python status');
    const python=version.join('.');
    if(version[0]!==3 || (maxMinor && (version[1]<11 || version[1]>maxMinor))) {
      return issue('python_version','Python 版本与组件要求不符。',{python});
    }
    if(missing.length)return issue('python_modules','Python 环境缺少运行模块。',{python,missing});
    return {ok:true,python};
  } catch(error) {
    if (temporaryProcessError(error)) return issue('python_check_timeout','Python 依赖检查暂未完成，请重试。');
    return error.code==='ENOENT'
      ? issue('python_missing','找不到已配置的 Python。')
      : issue('python_unavailable','无法在已配置的 Python 环境完成检查。');
  }
}

async function runtimeHealth(id,directory,python) {
  const {entry,revision,modules,maxMinor}=localRuntimes[id];
  const installation=await installed(directory,entry,revision);
  if (!installation.ok)return installation;
  return {...installation,...await pythonAvailability(python,modules,maxMinor)};
}

export async function requireRuntimeSource(config,id,signal) {
  signal?.throwIfAborted();
  const current=config[id];
  const code=id==='workbench'?'workbench_unavailable':'dependency_unavailable';
  if (!current.ok) throw new Problem(503,current.reason,code);
  const directory=config[id+'Root'];
  const {entry,revision}=localRuntimes[id];
  const checked=await installed(directory,entry,revision,signal,true);
  signal?.throwIfAborted();
  if (checked.ok) return;
  if (checked.code==='revision_check_timeout') throw new Problem(503,checked.reason,code);
  const name=id==='workbench'?'Self Media Workbench':'Hermes ACP';
  const reason=name+' 未通过版本核对。'+checked.reason+'恢复锁定版本后，请在「本机依赖」重新检查。';
  if (config[id]===current && config[id+'Root']===directory) {
    config[id]={...checked,python:current.python,reason};
    config.dependencyCheckedAt=new Date().toISOString();
  }
  throw new Problem(503,reason,code);
}

export async function inspectRuntimeInstallation(id,selection) {
  let directory,python;
  try {directory=await realpath(selection.root);}
  catch {return {health:issue('entry_missing','所选安装目录无法读取。')};}
  // The repository is verified before the selected interpreter is started.
  const {entry,revision,modules,maxMinor}=localRuntimes[id];
  const install=await installed(directory,entry,revision);
  if (!install.ok)return {health:install};
  try {
    python=await realpath(selection.python);
    if (!(await lstat(python)).isFile()) throw new Error('Interpreter is not a file');
  } catch {return {health:issue('python_missing','所选 Python 无法读取。')};}
  return {selection:{root:directory,python},health:{...install,...await pythonAvailability(python,modules,maxMinor)}};
}

async function matchesVersion(loader,id) {
  const file=loader.resolve('@deepseek-ai/'+id+'/package.json');
  return JSON.parse(await readFile(file,'utf8')).version===DSH_VERSION;
}

async function bundledDsh() {
  let sdk=false,dshWeb=false;
  try {
    sdk=await matchesVersion(require,'dsh-sdk-client');
    const loader=createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
    const required=['dsh','dsh-api-session-controller','dsh-api-gateway','dsh-host-webserver','dsh-client-connection','dsh-session-persistence-jsonl'];
    dshWeb=(await Promise.all(required.map(id=>matchesVersion(loader,id)))).every(Boolean);
  } catch { /* The installation is incomplete, or uses another version. */ }
  return {sdk,dshWeb};
}

export async function inspectDependencies(config) {
  const found=config.workbenchRoot?{}:await resolveInstallation();
  const workbenchRoot=config.workbenchRoot||found.root;
  const workbenchPython=config.workbenchRoot ? config.workbenchPython
    : process.env.HYPER_BOT_WORKBENCH_PYTHON||found.python||config.workbenchPython;
  const [workbench,hermes,dsh]=await Promise.all([
    runtimeHealth('workbench',workbenchRoot,workbenchPython),
    runtimeHealth('hermes',config.hermesRoot,config.hermesPython),
    bundledDsh()
  ]);
  return {workbenchRoot,workbenchPython,workbench,hermes,...dsh,dependencyCheckedAt:new Date().toISOString()};
}

const localProfile=()=>process.env.LOCALAPPDATA??path.join(homedir(),'.local','share');

export function workspaceDirectory(data) {
  return path.resolve(data??process.env.HYPER_BOT_DATA_DIR??path.join(localProfile(),'HyperBot'));
}

export async function configFor(options = {}) {
  const platformHome=localProfile();
  const data=workspaceDirectory(options.data);
  const desktop=options.desktopCredential;
  const key=desktop?desktop.key:(options.providerKey??process.env.DEEPSEEK_API_KEY?.trim());
  const provider=desktop?.status??{
    source:key?(options.providerKey!==undefined?'session':'environment'):null,
    local:'missing',canStore:false,environmentFallback:false
  };
  const runtimes=options.desktopInstallations;
  const selected=runtimes?.overrides??{};
  const model = options.model ?? (process.env.HYPER_BOT_MODEL?.trim() || 'deepseek-v4-flash');
  const hermesRoot = process.env.HYPER_BOT_HERMES_ROOT ?? path.join(platformHome, 'hermes', 'hermes-agent');
  const hermesPython = process.env.HYPER_BOT_HERMES_PYTHON ?? path.join(hermesRoot, 'venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const installation=await resolveInstallation();
  const local={workbenchRoot:selected.workbench?.root??(process.env.HYPER_BOT_WORKBENCH_ROOT||installation.root),
    workbenchPython:selected.workbench?.python??(process.env.HYPER_BOT_WORKBENCH_PYTHON||installation.python||(process.platform==='win32'?'python':'python3')),
    hermesRoot:selected.hermes?.root??hermesRoot,hermesPython:selected.hermes?.python??hermesPython};
  return {data,key,provider,model,runtimes,...local,...await inspectDependencies(local),
    originalWorkbenchState:options.originalWorkbenchState ?? process.env.SELF_MEDIA_STATE_DIR,
    originalWorkbenchData:options.originalWorkbenchData ?? process.env.SELF_MEDIA_DATA_DIR,
    temp:tmpdir(),upstream:options.upstream??'https://api.deepseek.com',timeoutMs:options.timeoutMs??90000};
}

const missingKey='未配置 DeepSeek 模型凭据。';
export function dependencies(config) {
  return {
    dsh: !config.sdk ? '未安装已锁定的 DSH SDK。' : !config.key ? missingKey : '',
    'dsh-web': !config.dshWeb ? '缺少固定版本的 DSH Web Host 组件。' : !config.key ? missingKey : '',
    hermes: !config.hermes.ok ? config.hermes.reason : !config.key ? missingKey : '',
    workbench: config.workbench.ok ? '' : config.workbench.reason
  };
}

export function dependencyStatus(config) {
  const bundled=(ok,reason)=>ok?{ok,version:DSH_VERSION}:issue('bundle',reason,{version:DSH_VERSION});
  const safe=(id,{ok,code,reason,revision,python,missing})=>({ok,code,reason,revision,python,missing,
    expected:localRuntimes[id].revision,source:config.runtimes?.overrides[id]?'desktop':'automatic'});
  const needs=dependencies(config);
  const {source,local,canStore,environmentFallback}=config.provider;
  return {checkedAt:config.dependencyCheckedAt,runtimeSetup:!!config.runtimes,runtimeSetupIssue:!!config.runtimes?.issue,checks:{
    provider:{...(config.key?{ok:true}:issue('credential',missingKey)),source,local,canStore,environmentFallback},
    'dsh-web':bundled(config.dshWeb,needs['dsh-web']),
    dsh:bundled(config.sdk,needs.dsh),
    hermes:safe('hermes',config.hermes),
    workbench:safe('workbench',config.workbench)
  }};
}


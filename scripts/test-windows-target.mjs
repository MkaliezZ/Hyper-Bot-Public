import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const exec=promisify(execFile);
const args=parseArgs({options:{
  candidate:{type:'string'},previous:{type:'string'},out:{type:'string'},
  'clean-image':{type:'string'},rehearsal:{type:'boolean'},integrations:{type:'boolean'}
}}).values;
const manifestName='验收清单.json';
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const systemRoot=process.env.SystemRoot??'C:/Windows';
const system32=path.join(systemRoot,'System32');

function relativeFile(parent,name) {
  const parts=name.split('/');
  assert.ok(parts.every(part=>part&&part!=='.'&&part!=='..'&&!/[\\:\u0000-\u001f]/.test(part)),'文件清单含无效路径。');
  return path.join(parent,...parts);
}

async function digest(file) {
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(file))hash.update(bytes);
  return hash.digest('hex');
}

async function verifyFile(file,{bytes,sha256}) {
  const stat=await lstat(file);
  assert.ok(stat.isFile(),'清单条目必须是普通文件。');
  assert.equal(stat.size,bytes,'文件大小不符 '+path.basename(file));
  assert.equal(await digest(file),sha256,'文件摘要不符 '+path.basename(file));
}

async function tree(dir,prefix='') {
  const names=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const key=prefix+entry.name;
    if(entry.isDirectory()&&!entry.isSymbolicLink())names.push(...await tree(path.join(dir,entry.name),key+'/'));
    else {
      assert.ok(entry.isFile(),'验收目录中存在链接或特殊文件。');
      names.push(key);
    }
  }
  return names.sort();
}

async function verifyTree(dir,rows,except) {
  const expected=[...rows.map(row=>row.path),except].sort();
  assert.equal(new Set(expected.map(name=>name.toLowerCase())).size,expected.length,'清单含重复路径。');
  assert.deepEqual(await tree(dir),expected,'目录内容与清单不符。');
  for(const row of rows)await verifyFile(relativeFile(dir,row.path),row);
}

async function platform() {
  assert.equal(process.platform,'win32','请在 Windows 上运行。');
  const powershell=path.join(system32,'WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-Command',
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $os=Get-CimInstance Win32_OperatingSystem; "+
    "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; "+
    "[pscustomobject]@{caption=$os.Caption;build=[int]$os.BuildNumber;productType=[int]$os.ProductType;"+
    "architecture=[int]$cpu.Architecture} | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:15000});
  const result=JSON.parse(stdout);
  assert.ok(process.arch==='x64'&&result.architecture===9,'验收需要 x64 Windows 客户端。');
  return {...result,nodeArchitecture:process.arch,
    windows11:result.productType===1&&result.build>=22000&&/Windows 11\b/i.test(result.caption)};
}

async function extract(input,release,working,label) {
  const target=path.join(working,label);
  await mkdir(target);
  await exec(path.join(system32,'tar.exe'),['-xf',input,'-C',target],
    {windowsHide:true,timeout:180000,maxBuffer:2*1024*1024});
  const names=await readdir(target);
  assert.deepEqual(names,[release.folder],'归档根目录与版本清单不符。');
  const app=path.join(target,release.folder);
  const summary='包内文件摘要.json';
  assert.equal(await digest(path.join(app,summary)),release.fileManifestSha256,'包内文件清单摘要不符。');
  const index=await json(path.join(app,summary));
  assert.equal(index.schema,1);
  assert.equal(index.files.length,release.files);
  await verifyTree(app,index.files,summary);
  const metadata=await json(path.join(app,'发布候选清单.json'));
  assert.equal(metadata.version,release.version);
  return app;
}

function environment(working) {
  const allow=new Set(['systemroot','comspec','windir','temp','tmp','userprofile','localappdata','appdata',
    'programdata','programfiles','programfiles(x86)','homedrive','homepath','pathext','processor_architecture','number_of_processors']);
  const values=Object.fromEntries(Object.entries(process.env).filter(([name])=>allow.has(name.toLowerCase())));
  // A fresh profile and a minimal PATH keep cold checks independent of developer installations.
  for(const name of Object.keys(values))if(/^(temp|tmp|appdata|localappdata)$/i.test(name))delete values[name];
  return {...values,TEMP:working,TMP:working,APPDATA:working,LOCALAPPDATA:working,PATH:system32,
    HYPER_BOT_WORKBENCH_ROOT:path.join(working,'missing-workbench'),
    HYPER_BOT_HERMES_ROOT:path.join(working,'missing-hermes'),
    HYPER_BOT_TEST_PLAYWRIGHT:path.join(root,'node_modules','playwright')};
}

async function integrationEnvironment(env) {
  const names=['HYPER_BOT_WORKBENCH_ROOT','HYPER_BOT_WORKBENCH_PYTHON','HYPER_BOT_HERMES_ROOT','HYPER_BOT_HERMES_PYTHON'];
  const settings={};
  for(const name of names) {
    const value=process.env[name];
    assert.ok(value&&path.isAbsolute(value),'集成验收需为 '+name+' 提供绝对路径。');
    await access(value);
    settings[name]=value;
  }
  // Every integration suite creates its own temp directory. Avoid nesting it under the archives.
  return {...env,...settings,TEMP:tmpdir(),TMP:tmpdir(),PATH:process.env.PATH??system32};
}

async function suite(node,name,argv,env,out) {
  try {
    const {stdout,stderr}=await exec(node,[path.join(root,'scripts',name),...argv],
      {env,encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:2*1024*1024});
    await writeFile(path.join(out,name+'.log'),stdout+stderr,{flag:'wx'});
    return JSON.parse(stdout.split(/\r?\n/).findLast(line=>line.startsWith('{')));
  } catch(error) {
    if(error.stdout||error.stderr)await writeFile(path.join(out,name+'.log'),(error.stdout??'')+(error.stderr??''),{flag:'wx'});
    throw error;
  }
}

async function run() {
  assert.ok(args.candidate&&args.previous&&args.out,'请指定 --candidate、--previous 和 --out。');
  const host=await platform();
  if(!args.rehearsal) {
    assert.ok(host.windows11,'目标验收只接受 Windows 11 x64。当前机器可用 --rehearsal 演练。');
    assert.ok(args['clean-image']?.trim(),'请用 --clean-image 记录本次使用的干净系统或快照编号。');
  }

  const plan=await json(path.join(root,manifestName));
  assert.equal(plan.schema,1);
  assert.equal(await digest(process.execPath),plan.nodeExeSha256,'请使用候选包内的 node.exe 执行验收。');
  await verifyTree(root,plan.files,manifestName);

  const out=path.resolve(args.out);
  // Report in a new folder outside the immutable toolkit.
  const relative=path.relative(root,out);
  assert.ok(relative&&(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)),
    '请把回执保存到验收工具目录之外。');
  await mkdir(out);
  const working=await mkdtemp(path.join(tmpdir(),'hbqa-'));
  const report={schema:1,checkedAt:new Date().toISOString(),mode:args.rehearsal?'rehearsal':'target',
    platform:host,cleanImageDeclaredByOperator:args['clean-image']?.trim()||null,
    candidate:plan.candidate,previous:plan.previous,toolkitManifestSha256:await digest(path.join(root,manifestName)),
    model:'local protocol fixture',checks:{native:{status:'pending'},dsh:{status:'pending'},
      integrations:{status:args.integrations?'pending':'notRun'}}};
  let current='archive';
  try {
    const input=path.resolve(args.candidate), previousInput=path.resolve(args.previous);
    await verifyFile(input,plan.candidate);
    await verifyFile(previousInput,plan.previous);
    const app=await extract(input,plan.candidate,working,'candidate');
    const previous=await extract(previousInput,plan.previous,working,'previous');
    const node=path.join(app,'resources','node','node.exe');
    const fixture=path.join(working,'fixture');
    await cp(path.join(root,'fixture'),fixture,{recursive:true,force:false,errorOnExist:true});
    const env={...environment(working),HYPER_BOT_TEST_APP_ROOT:path.join(app,'resources','app')};

    current='native';
    const native=await suite(node,'test-windows-package.mjs',[app,previous,path.join(previous,'Hyper Bot.exe'),
      fixture,'--repeat-host-restart','--host-start-retry','--history-navigation','--recovery-navigation',
      '--readiness','--receipts','--history-export','--artifact-bundle',
      ...(plan.candidate.workspaceCleanup?['--workspace-cleanup']:[]),
      ...(plan.candidate.windowAccess?['--window-access']:[])],env,out);
    assert.equal(native.clean.version,plan.candidate.version);
    if (plan.candidate.windowsIdentity) {
      assert.equal(native.executableIdentity?.product,plan.candidate.windowsIdentity.product);
      assert.equal(native.executableIdentity?.version,plan.candidate.windowsIdentity.version);
    }
    assert.equal(native.rolledBack.artifacts.length,2);
    assert.equal(native.hostRestarts,2);
    assert.ok(native.offlineExportAndCollision&&native.historyNavigation&&native.receiptNavigation);
    const recovery=native.hostStartRetry;
    assert.ok(recovery.firstAttemptRefused&&recovery.automaticRecovery&&recovery.explicitRecovery&&recovery.sameOrigin&&
      recovery.eventStreamRecovered&&recovery.savedOfflineDraft&&recovery.restoredKeyboardFocus&&
      recovery.reopenedWithoutHostRestart&&recovery.attemptedBeforeManual===4);
    const bundle=native.artifactBundle;
    assert.ok(bundle.openedWhenHostExited&&bundle.selectionPinned&&bundle.collisionRenamed&&
      bundle.collisionCancelled&&bundle.withdrawalRechecked&&bundle.manifestCollisionRenamed&&bundle.citations>0);
    assert.ok(native.retirement.extractedWithWindowsTarAfterHostExit&&native.retirement.collisionRenamed);
    if (plan.candidate.workspaceCleanup) {
      const cleanup=native.retirement.cleanup;
      assert.ok(cleanup.removedWorkspace&&cleanup.purgedBackup&&cleanup.retainedBackupAndExport);
      assert.ok(cleanup.restoredBeforeExpiry&&cleanup.expiredRestoreRefused&&['cutoff','format-block'].includes(cleanup.rollbackRetention));
    }
    if (plan.candidate.windowAccess) {
      const access=native.clean.windowAccess;
      assert.ok(access.unownedWindowDenied&&access.credentialHiddenFromPreload&&access.unownedReconnectDenied&&access.unauthorizedRoutes===4);
      assert.equal(native.reconnectedEventStreams,2);
    }
    let credentials;
    if (plan.candidate.desktopCredentialSetup) {
      credentials=await suite(node,'test-provider-setup.mjs',[app,previous],env,out);
      assert.equal(credentials.version,plan.candidate.version);
      assert.equal(credentials.previousVersion,plan.previous.version);
      assert.ok(credentials.checks.length===9 && credentials.native.encrypted &&
        credentials.native.credentialsInWorkspaceBackup===false && credentials.provider.paidRequests===0);
    }
    report.checks.native={status:'passed',coldStart:native.clean,retainedVersions:native.rolledBack.artifacts.length,
      ...(native.executableIdentity?{executableIdentity:native.executableIdentity}:{}),
      ...(credentials?{credentialSetup:credentials}:{}),
      ...(plan.candidate.windowAccess?{reconnectedEventStreams:native.reconnectedEventStreams}:{}),
      hostRestarts:native.hostRestarts,historyNavigation:native.historyNavigation,
      receiptNavigation:native.receiptNavigation,offlineExportAndCollision:native.offlineExportAndCollision,
      retirement:native.retirement,artifactBundle:bundle,hostStartRetry:recovery};

    current='dsh';
    const probe=await suite(node,'probe-dsh-web.mjs',[],env,out);
    assert.ok(probe.fixture&&probe.checks.length===4);
    let startupRecovery;
    if (plan.candidate.dshStartupRecovery) {
      startupRecovery=await suite(node,'test-dsh-start-retry.mjs',[],env,out);
      assert.deepEqual(startupRecovery.startup,{workers:2,requests:1,retryAudited:true});
      assert.deepEqual(startupRecovery.connect,{workers:2,prompts:1,requests:1,state:'succeeded',retryAudited:true});
      assert.deepEqual(startupRecovery['connect-twice'],{workers:2,prompts:0,requests:0,state:'failed',retryAudited:true});
      assert.ok(startupRecovery.cancel.state==='cancelled'&&startupRecovery.cancel.workers===1&&startupRecovery.cancel.prompts===0);
      assert.ok(startupRecovery['identity-denied'].workers===1&&startupRecovery['identity-denied'].prompts===0);
      assert.ok(startupRecovery['lost-ack'].workers===1&&startupRecovery['lost-ack'].prompts===1);
    }
    report.checks.dsh={status:'passed',harness:probe.harness,checks:probe.checks,modelRequests:probe.providerCalls,
      ...(startupRecovery?{startupRecovery}:{})};

    if(args.integrations) {
      current='integrations';
      const setup=await integrationEnvironment(env);
      const integration=await suite(node,'integration.mjs',[],setup,out);
      assert.equal(integration.mode,'本机协议夹具');
      assert.equal(integration.checks.length,11);
      assert.deepEqual(integration.blockedModelResponses,[
        {driver:'dsh-web',protocol:'messages',state:'failed',approvals:0,artifacts:0},
        {driver:'hermes',protocol:'chat-completions',state:'failed',approvals:0,artifacts:0}
      ]);
      const stop=await suite(node,'test-run-stop.mjs',['--no-ui'],setup,out);
      assert.ok(stop.fixture&&stop.version===plan.candidate.version&&stop.checks.length===7);
      assert.equal(stop.proofs.webConfirmed.outcome,'confirmed');
      assert.equal(stop.proofs.lostCancel.state,'interrupted');
      assert.equal(stop.proofs.lateCompletion.terminal,'completed');
      const exported=await suite(node,'test-artifact-export.mjs',['--no-ui'],setup,out);
      assert.ok(exported.fixture&&exported.version===plan.candidate.version&&exported.checks.length===5);
      assert.equal(exported.brief.sameNames,2);
      assert.deepEqual(exported.package.entries,['稿件.md','版本与来源.json']);
      const recovered=await suite(node,'test-generation-recovery.mjs',['--no-ui'],setup,out);
      assert.ok(recovered.checks.length===9 && recovered.requestsDuringRecovery===0);
      assert.ok(recovered.checks.some(value=>value.includes('端口不可用时')));
      const revoked=await suite(node,'test-skill-revocation.mjs',['--no-ui'],{
        ...setup,HYPER_BOT_TEST_PREVIOUS_APP_ROOT:path.join(previous,'resources','app')
      },out);
      assert.equal(revoked.applicationVersion,plan.candidate.version);
      assert.equal(revoked.rollback?.version,plan.previous.version);
      assert.ok(revoked.checks.length===8 && revoked.referenceCandidates.some(bot=>bot.driver==='hermes'));
      let runtimes;
      if (plan.candidate.desktopRuntimeSetup) {
        runtimes=await suite(node,'test-runtime-setup.mjs',[app,previous],setup,out);
        assert.equal(runtimes.version,plan.candidate.version);
        assert.equal(runtimes.previous,plan.previous.version);
        assert.ok(runtimes.checks.length===7 && runtimes.selection.dualRuntime && runtimes.integration.modelCalls===2);
      }
      let workflow;
      if (plan.candidate.domainWorkflow) {
        workflow=await suite(node,'test-domain-workflow.mjs',['--no-ui'],{
          ...setup,HYPER_BOT_TEST_PREVIOUS_APP_ROOT:path.join(previous,'resources','app')
        },out);
        assert.equal(workflow.version,plan.candidate.version);
        assert.equal(workflow.previousVersion,plan.previous.version);
        assert.ok(workflow.checks.length===8 && workflow.provider.workflowRequests===3 && workflow.provider.paidRequests===0);
        assert.match(workflow.verification.workbenchRevision,/^[a-f0-9]{40}$/);
        assert.deepEqual(workflow.timing.checked.shots[0],{characters:120,fastSeconds:24,slowSeconds:30,fitsSlow:false});
      }
      const approvalRevision=await suite(node,'test-approval-revision.mjs',['--no-ui'],{
        ...setup,HYPER_BOT_TEST_PREVIOUS_APP_ROOT:path.join(previous,'resources','app')
      },out);
      assert.equal(approvalRevision.version,plan.candidate.version);
      assert.equal(approvalRevision.previousVersion,plan.previous.version);
      assert.ok(approvalRevision.checks.length===6 && approvalRevision.modelCalls===3 && approvalRevision.paidRequests===0);
      report.checks.integrations={status:'passed',checks:integration.checks,modelRequests:integration.providerCalls,
        blockedModelResponses:integration.blockedModelResponses,approvalRevision,
        ...(workflow?{domainWorkflow:workflow}:{}),
        generationRecovery:recovered,skillRevocation:revoked,...(runtimes?{runtimeSetup:runtimes}:{}),
        stop:{checks:stop.checks,proofs:stop.proofs,modelRequests:stop.modelRequests},
        artifactExport:{checks:exported.checks,package:exported.package,positions:exported.brief.positions}};
    }
  } catch(error) {
    report.failure={step:current,message:error.message.split(/\r?\n/)[0]};
    if(current!=='archive')report.checks[current]={status:'failed'};
    process.exitCode=1;
  }
  const target=report.mode==='target'&&host.windows11;
  report.targetEvidence={
    nativeOffline:target&&report.checks.native.status==='passed',
    dshTransports:target&&report.checks.dsh.status==='passed',
    workbenchAndHermes:target&&report.checks.integrations.status==='passed'
  };
  const result=path.join(out,'Windows 验收回执.json');
  await writeFile(result,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({report:result,mode:report.mode,platform:host,checks:report.checks,targetEvidence:report.targetEvidence,
    ...(report.failure?{failure:report.failure}:{})}));
}

run().catch(error=>{console.error(error.message);process.exitCode=1;});


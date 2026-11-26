import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CircleAlert, RefreshCw } from 'lucide-react';
import { api, clock, day } from './client.js';
import { ProviderCredential } from './provider-credentials.jsx';
import { RuntimeInstallation } from './runtime-installation.jsx';

const labels={provider:'DeepSeek 模型凭据','dsh-web':'DSH Web Host',dsh:'DSH SDK',hermes:'Hermes ACP',workbench:'Self Media Workbench',teaching:'内置英语教培','teaching-lessons':'课件与练习生成组件'};
const variables={
  hermes:['HYPER_BOT_HERMES_ROOT','HYPER_BOT_HERMES_PYTHON'],
  workbench:['HYPER_BOT_WORKBENCH_ROOT','HYPER_BOT_WORKBENCH_PYTHON']
};

function recoveryText(id,code) {
  if(id==='teaching')return '从完整的 Hyper Bot 安装目录启动后重新检查。';
  if(id==='teaching-lessons')return <>用 Python 3.11 或更新版本执行 <code>npm run setup:teaching</code>，然后重新检查。</>;
  const [folder,python]=variables[id]??[];
  switch(code) {
    case 'bundle':return '重新解压完整的 Hyper Bot 测试包，从新目录启动。';
    case 'unconfigured':
      return <>完成 {labels[id]} 的本机安装与登记，或在启动环境中设置 <code>{folder}</code> 后重启应用。</>;
    case 'repository_root':return '选择组件的 Git 仓库根目录。';
    case 'entry_missing':
      return <>补齐当前目录中的已审核组件。切换安装目录时，更新 <code>{folder}</code> 后重启应用。</>;
    case 'git_missing':return '把 Git 加入应用启动环境的 PATH 后重新打开 Hyper Bot。';
    case 'version_mismatch':return '换用已锁定提交的安装副本，再重新检查。';
    case 'modified':return '保留现有源码改动，使用已锁定提交的独立副本并重新启动。';
    case 'python_version':
      return <>为此组件配置 {id==='hermes'?'Python 3.11–3.13':'可运行此组件依赖的 Python 3'}。修改 <code>{python}</code> 后重启应用。</>;
    case 'python_modules':return '按组件的安装说明，在当前 Python 环境补齐缺少的模块，再重新检查。';
    case 'python_missing':
    case 'python_unavailable':
      return <>恢复当前 Python 后点「重新检查」。更换解释器时，更新 <code>{python}</code> 并重新启动。</>;
    default:return '确认组件位于完整的 Git 工作目录，并能读取当前提交。';
  }
}

function DependencyRow({id,check,children,canRegister}) {
  const heading='dependency-'+id;
  const actual=check.revision&&check.expected&&check.revision!==check.expected;
  return <section className="dependency-row" aria-labelledby={heading}>
    <div className="dependency-row-head">
      <h3 id={heading} tabIndex={id==='provider'?-1:undefined}>{labels[id]}</h3>
      <span className={'chip '+(check.ok?'success':'wait')}>
        {check.ok?<Check size={13}/>:<CircleAlert size={13}/>}
        {id==='provider'&&check.ok?'已配置':check.ok?'就绪':'待处理'}
      </span>
    </div>
    {!check.ok&&<p className="dependency-reason">{check.reason}</p>}
    <div className="dependency-meta">
      {check.version&&<span>随包版本 <code>{check.version}</code></span>}
      {check.expected&&<span title={check.expected}>锁定提交 <code>{check.expected.slice(0,10)}</code></span>}
      {actual&&<span title={check.revision}>当前提交 <code>{check.revision.slice(0,10)}</code></span>}
      {check.python&&<span>Python <code>{check.python}</code></span>}
      {check.missing?.length>0&&<span>缺少 <code>{check.missing.join('、')}</code></span>}
    </div>
    {id!=='provider'&&!check.ok&&(!canRegister||check.code==='git_missing')&&<p>{recoveryText(id,check.code)}</p>}
    {children}
  </section>;
}

export function LocalDependencies({workspace,bot,room,online,refresh,notify}) {
  const [checking,setChecking]=useState(false);
  const heading=useRef(null);
  const status=workspace.localDependencies;
  const canRegister=!!status?.runtimeSetup&&!!window.hyperBot?.runtimeSetup;
  const ids=bot?.kind==='teaching'
    ? bot.target==='bot'?['provider']:['teaching',...(['classroom','practice'].includes(bot.target)?['teaching-lessons']:[])]
    : bot?['provider',bot.driver,...(bot.kind==='script'?['workbench']:[])]:Object.keys(labels);
  const driver=bot&&workspace.drivers.find(item=>item.id===bot.driver);
  const target=room?'#chat/'+room.id:bot?.status==='enabled'?'#bots/'+bot.id:'#manage';
  const targetLabel=room?'返回会话':bot?.status==='enabled'?'返回 '+bot.name:'返回 Bot 版本';
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[bot?.id,bot?.revision,room?.id]);
  async function recheck() {
    setChecking(true);
    try {
      await api('/dependencies',{});
      await refresh();
    } catch(error) {notify(error.message);}
    finally {setChecking(false);}
  }

  return <section className="manage-card dependency-card tab-in" aria-labelledby="dependency-title">
    <div className="dependency-header">
      <div><h2 id="dependency-title" ref={heading} tabIndex={-1}>本机依赖</h2>
        {bot&&<p>{bot.name} <span className="version">r{bot.revision}</span></p>}
      </div>
      <div className="manage-actions">
        <button type="button" className="button primary" disabled={checking||!online||!!workspace.active} onClick={recheck}>
          <RefreshCw size={16}/>{checking?'正在检查…':'重新检查'}
        </button>
        {bot&&<a className="button" href={target}><ArrowLeft size={16}/>{targetLabel}</a>}
      </div>
    </div>
    <div className="dependency-stamp" role="status">
      {checking?'正在读取已配置的本机组件。':workspace.active?'当前任务结束后可以重新检查。':status?.checkedAt
        ? <>上次检查 <time dateTime={status.checkedAt}>{day(status.checkedAt)} {clock(status.checkedAt)}</time></>:'等待读取配置。'}
    </div>
    {status&&<>
      {canRegister&&status.runtimeSetupIssue&&<p className="credential-issue" role="status">
        本机组件登记无法读取。可为当前工作区重新配置。
      </p>}
      {ids.filter(id=>status.checks[id]).map(id=><DependencyRow key={id} id={id}
        check={status.checks[id]} canRegister={canRegister&&Object.hasOwn(variables,id)}>
        {id==='provider'&&<ProviderCredential check={status.checks[id]} online={online}
          busy={checking||!!workspace.active} refresh={refresh} notify={notify}/>}
        {Object.hasOwn(variables,id)&&<RuntimeInstallation id={id} label={labels[id]} check={status.checks[id]}
          available={canRegister} online={online} busy={checking||!!workspace.active} refresh={refresh} notify={notify}/>}
      </DependencyRow>)}
      {driver&&!driver.registered&&<section className="dependency-row">
        <div className="dependency-row-head"><h3>Harness 登记</h3><span className="chip wait">待登记</span></div>
        <p>当前 Bot 需要登记 {driver.name}。 <a className="dependency-link" href="#manage/skills">查看已审核 Harness</a></p>
      </section>}
      <p className="dependency-foot">检查读取本机配置。模型连通性在发起任务时验证。</p>
    </>}
  </section>;
}


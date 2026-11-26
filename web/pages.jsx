import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, ChevronRight, Download, FilePlus2, FileText, FlaskConical, FolderOpen, GitBranch,
  PackageCheck, Plus, Search, ShieldCheck, X } from 'lucide-react';
import { api, apiPath, browseHref, day, dependencyHref, downloadFile, needsReassembly, routeTo } from './client.js';
import { LocalDependencies } from './dependencies.jsx';
import { RunReceipts } from './run-receipts.jsx';
import { SkillVersions } from './skill-versions.jsx';
import { BotMark } from './components.jsx';
import { SampleReview } from './sample-review.jsx';

export function NewConversation({bot,roomReady,onClose,originalWorkbench=true}) {
  const modal=useRef();
  const [title,setTitle]=useState('');
  const [current,setCurrent]=useState('');
  const [projects,setProjects]=useState([]);
  const [original,setOriginal]=useState(null);
  const [connecting,setConnecting]=useState(false);
  const titleEdited=useRef(false);
  const [saving,setSaving]=useState(false);
  const [closing,setClosing]=useState(false);
  const closeTimer=useRef();
  const [error,setError]=useState('');
  useEffect(()=>{
    const node=modal.current;
    node.showModal();
    return ()=>{clearTimeout(closeTimer.current);if(node.open)node.close();};
  },[]);
  useEffect(()=>{
    if(bot.kind!=='script'||bot.blocked)return;
    const controller=new AbortController();
    api('/projects',undefined,{signal:controller.signal}).then(rows=>setProjects(rows.map(row=>({...row,key:'managed:'+row.id}))))
      .catch(problem=>{if(problem.name!=='AbortError')setError(problem.message);});
    return ()=>controller.abort();
  },[bot.kind,bot.blocked]);
  function close() {
    if(closing||saving)return;
    const finish=()=>{modal.current?.close();onClose();};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)finish();
    else {setClosing(true);closeTimer.current=setTimeout(finish,120);}
  }
  async function connectOriginal() {
    setConnecting(true);
    setError('');
    try {
      const rows=await api('/projects/original');
      const entries=rows.map(row=>({...row,key:'original:'+row.storage+':'+row.id}));
      setOriginal(entries);
      if (current.startsWith('original:') && !entries.some(row=>row.key===current)) {
        setError('刚才选中的原项目已不在列表中。请另选项目。');
      }
    } catch(error) {setError(error.message);}
    finally {setConnecting(false);}
  }
  function chooseProject(value) {
    setCurrent(value);
    const item=[...projects,...(original??[])].find(project=>project.key===value);
    if (item&&!titleEdited.current) setTitle(item.title.replace(/ · [0-9a-f]{8}$/,'').slice(0,100));
  }
  async function create(example) {
    if(saving || closing || (!example && !title.trim()))return;
    setSaving(true);setError('');
    try {
      const project=example?null:[...projects,...(original??[])].find(item=>item.key===current);
      if (!example && current && !project) throw new Error('请重新选择工作台项目。');
      const {id}=await api('/rooms',{botId:bot.id,revision:bot.revision,example,
        title:example?(bot.exampleTitle||'书店开门前'):title.trim(),
         ...(project?{project:project.id,simulation:project.simulation,
          ...(project.key.startsWith('original:')?{projectScope:'original',projectStorage:project.storage}:{})}:{})});
      roomReady(id);
    } catch(error) {setError(error.message);setSaving(false);}
  }
  return <dialog className={'modal new-conversation'+(closing?' closing':'')} ref={modal} onCancel={e=>{e.preventDefault();close();}} aria-labelledby="new-chat-title">
    <div className="modal-head"><h2 id="new-chat-title">新建{bot.name}会话</h2><button type="button" className="icon-button"
      aria-label="关闭新建会话" onClick={close}><X size={19}/></button></div>
    <form onSubmit={e=>{e.preventDefault();void create(false);}}>
      <label>会话标题<input autoFocus maxLength={100} value={title} onChange={e=>{titleEdited.current=true;setTitle(e.target.value);}} placeholder={bot.kind==='script'?'例如 街角书店开门前':'例如 创作素材核对'}/></label>
      {bot.kind==='script'&&<div className="project-picker">
        <div className="project-picker-label"><label htmlFor="conversation-project">工作台项目</label>
          {originalWorkbench&&<button type="button" className="text-button" disabled={saving||connecting} onClick={()=>void connectOriginal()}>
            {connecting?'正在连接…':original?'刷新独立工作台':'连接独立工作台'}</button>}</div>
        <select id="conversation-project" value={current} onChange={e=>chooseProject(e.target.value)}>
          <option value="">首次派活时创建项目</option>
          {projects.length>0&&<optgroup label="Hyper Bot 工作区">
            {projects.map(p=><option key={p.key} value={p.key}>{p.title} {p.simulation?'· 合成演练':''}</option>)}
          </optgroup>}
          {original?.length>0&&<optgroup label="独立 Self Media Workbench">
            {original.map(p=><option key={p.key} value={p.key}>{p.title} {p.simulation?'· 合成演练':''}</option>)}
          </optgroup>}
        </select>
        {original?.length===0&&<p className="muted" role="status">独立工作台当前没有项目。</p>}
        {current.startsWith('original:')&&<p className="muted">会话将绑定所选原项目，保存前显示写入范围。</p>}
      </div>}
      {error&&<p role="alert" className="form-error">{error}</p>}
      <div className="modal-actions">{bot.exampleTitle!==null&&<button type="button" className="button"
        onClick={()=>void create(true)} disabled={saving||!!bot.blocked}>
        <FlaskConical size={16}/>{bot.exampleTitle?'载入 Bot 演练':'载入书店演练'}</button>}
        <button type="submit" className="button primary" disabled={saving||!title.trim()||!!bot.blocked}>
          <Plus size={16}/>开始会话</button></div>
    </form>
  </dialog>;
}

export function Directory({workspace,selected,home,refresh,online}) {
  const [opening,setOpening]=useState(null);
  const [search,setSearch]=useState('');
  const [category,setCategory]=useState('');
  const [adding,setAdding]=useState(null);
  const [error,setError]=useState('');
  const bots=workspace.bots.filter(bot=>bot.status==='enabled');
  const earlier=workspace.conversations.slice(0,5);
  const highlight=selected?bots.find(bot=>bot.id===selected):null;
  const installed=new Set(workspace.installedBots??bots.map(bot=>bot.id));
  const searchText=search.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
  const categories=[...new Set(bots.map(bot=>bot.category))];
  const visible=(highlight?[highlight]:bots).filter(bot=>(!home||installed.has(bot.id))&&
    (highlight||home||!category||bot.category===category)&&
    [bot.name,bot.category,bot.subcategory,bot.subtitle,bot.description,bot.output].join(' ').normalize('NFKC').toLocaleLowerCase('zh-CN').includes(searchText));
  useEffect(()=>setOpening(null),[selected]);
  async function install(bot) {
    if (adding || !online) return;
    setAdding(bot.id);setError('');
    try {
      const {id}=await api('/bot-instances',{botId:bot.id});
      routeTo('chat/'+id);
      void refresh();
    } catch(error) {setError(error.message);}
    finally {setAdding(null);}
  }
  return <>
    <div className="section-head"><div><h1>{highlight?.name ?? (home?workspace.workspace.name:'Bot 市场')}</h1>
      <p>{highlight?.subtitle ?? (home?'继续一个对话，或在市场添加专项 Bot。':'按用途找 Bot，添加到「'+workspace.workspace.name+'」。')}</p></div>
      {home&&<a href="#bots" className="button">打开 Bot 市场<ArrowRight size={16}/></a>}</div>
    {!home&&!highlight&&<div className="browse-search market-search"><Search size={17}/>
      <input type="search" aria-label="搜索 Bot" placeholder="搜索用途或 Bot 名称" maxLength={100} value={search}
        onChange={event=>setSearch(event.target.value)}/></div>}
    {!home&&!highlight&&<div className="market-categories" role="group" aria-label="Bot 分类">
      {['',...categories].map(item=><button key={item} type="button" className="button" aria-pressed={category===item}
        onClick={()=>setCategory(item)}>{item||'全部'}</button>)}
    </div>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="directory-grid market-grid">
      {visible.map(bot=>{
        const room=workspace.conversations.find(room=>room.botId===bot.id);
        return <section className="directory-card" key={bot.id}>
        <div className="directory-card-head"><BotMark kind={bot.kind} className="large"/><div><h2>{bot.name}</h2><p>{bot.subtitle}</p></div>
          <span className={'chip '+(bot.blocked?'wait':'success')}><i className="phase-dot"/>{needsReassembly(bot)?'待重新装配':bot.blocked?'依赖待配置':'可用'}</span></div>
        <p>{bot.description}</p>
        <dl><dt>需要</dt><dd>{bot.input}</dd><dt>交付</dt><dd>{bot.output}</dd></dl>
        {bot.blocked&&<p className="muted">{bot.blocked} <a href={dependencyHref(bot)}>{needsReassembly(bot)?'查看 Bot 版本':'检查依赖'}</a></p>}
        <div className="directory-actions">
          {room?<a className="button primary" href={'#chat/'+room.id}>打开对话<ArrowRight size={16}/></a>
            :<button className="button primary" disabled={!!adding||!online} onClick={()=>void install(bot)}><Plus size={17}/>
              {adding===bot.id?'正在添加…':installed.has(bot.id)?'打开对话':'添加到工作区'}</button>}
          {installed.has(bot.id)&&<button className="button" disabled={!!bot.blocked||!online} onClick={()=>setOpening(bot)}>新建会话</button>}
        </div>
      </section>;})}
      {!visible.length&&<p className="muted" role="status">{searchText?'没有匹配的 Bot。':home?'这个工作区还没有专项 Bot。':'当前没有启用的专项 Bot。'}</p>}
    </div>
    {home&&earlier.length>0&&<section className="page-list"><div className="page-list-heading"><h2>最近会话</h2>
      <a className="text-button" href="#history">查看全部<ChevronRight size={15}/></a></div>{earlier.map(room=>
      <a className="page-row" key={room.id} href={'#chat/'+room.id}><BookOpen size={18}/><span>{room.title}
        <small>{workspace.bots.find(bot=>bot.id===room.botId&&bot.revision===room.revision)?.name||room.botId}</small></span>
        <small>{day(room.updatedAt)}</small><ChevronRight size={16}/></a>)}</section>}
    {opening&&<NewConversation bot={opening} originalWorkbench={workspace.originalWorkbench} onClose={()=>setOpening(null)}
      roomReady={id=>{setOpening(null);routeTo('chat/'+id);void refresh();}}/>}
  </>;
}

async function utf8(file,limit) {
  if (file.size>limit) throw new Error('文件「'+file.name+'」超过大小限制。');
  try {
    return new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
  } catch {
    throw new Error('文件「'+file.name+'」需要使用 UTF-8 编码。');
  }
}

function ImportSkill({submit,busy}) {
  const [name,setName]=useState(''),[slug,setSlug]=useState(''),[origin,setOrigin]=useState(''),[version,setVersion]=useState('1.0.0');
  const [outputKind,setOutputKind]=useState('');
  const [entries,setEntries]=useState([]),[reviewed,setReviewed]=useState(false);
  const [selectionError,setSelectionError]=useState('');
  const folderInput=useRef(),fileInput=useRef(),guide=useId();
  function select(event,isFolder) {
    const files=[...event.target.files];
    event.target.value='';
    if(!files.length)return;
    const root=isFolder?files[0].webkitRelativePath.split('/')[0]+'/':'';
    const picked=files.map(file=>({file,name:isFolder
      ? (file.webkitRelativePath.startsWith(root)?file.webkitRelativePath.slice(root.length):'')
      : file.name==='SKILL.md'?file.name:'references/'+file.name}));
    const invalid=picked.find(item=>item.name!=='SKILL.md'&&!/^references\/.+\.md$/i.test(item.name));
    const error=invalid?'请选择 SKILL.md 和 references/ 下的 Markdown 文档。'
      : !picked.some(item=>item.name==='SKILL.md')?'请选择根目录含有 SKILL.md 的 Skill。'
      : picked.length>7?'每个 Skill 最多导入 6 份引用文档。'
      : new Set(picked.map(item=>item.name.toLowerCase())).size!==picked.length?'引用文件名重复。':'';
    if(isFolder&&!error) picked.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    setSelectionError(error);
    setEntries(error?[]:picked);
    setReviewed(false);
  }
  return <form className="management-form" onSubmit={e=>{e.preventDefault();void submit(async ()=>{
    const main=entries.find(item=>item.name==='SKILL.md');
    if(!main)throw new Error('请选择 SKILL.md。');
    const references=await Promise.all(entries.filter(item=>item!==main)
      .map(async item=>({name:item.name,text:await utf8(item.file,48000)})));
    return api('/skills',{slug,version,name,origin,content:await utf8(main.file,48000),references,outputKind:outputKind||null,reviewed});
  },'已登记 Skill 版本。');}}>
    <div className="field-grid"><label>Skill 名称<input required value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>Skill ID<input required pattern="[a-z0-9][a-z0-9\-]{1,59}" value={slug} onChange={e=>setSlug(e.target.value)}/></label>
      <label>版本<input required value={version} onChange={e=>setVersion(e.target.value)}/></label>
      <label>使用依据<input required value={origin} onChange={e=>{setOrigin(e.target.value);setReviewed(false);}}/></label></div>
    <label>适用成果<select value={outputKind} onChange={e=>setOutputKind(e.target.value)}>
      <option value="">通用文字</option><option value="brief">素材简报</option><option value="script">口播分镜</option>
    </select></label>
    <fieldset className="skill-file-picker"><legend>Skill 文件</legend>
      <input aria-label="Skill 文件夹" type="file" webkitdirectory="" ref={folderInput} className="sr" tabIndex={-1}
        disabled={busy} onChange={event=>select(event,true)}/>
      <input aria-label="SKILL.md 与引用文件" type="file" multiple accept=".md" ref={fileInput} className="sr" tabIndex={-1}
        disabled={busy} onChange={event=>select(event,false)}/>
      <div className="sample-file-row">
        <button className="button" type="button" disabled={busy} aria-describedby={guide} onClick={()=>folderInput.current.click()}>
          <FolderOpen size={16}/>选择 Skill 文件夹</button>
        <button className="text-button" type="button" disabled={busy} onClick={()=>fileInput.current.click()}>选择文件</button>
      </div>
      <p className="muted" id={guide}>根目录放 SKILL.md，引用文档放在 references/。也可一次选中主文件和同层引用。</p>
      {selectionError&&<p role="alert" className="form-error">{selectionError}</p>}
      <div aria-live="polite">
        {!!entries.length&&<ul className="skill-file-list status-in" aria-label="待导入文件">{entries.map(item=>
          <li key={item.name}><FileText size={14}/><span>{item.name}</span></li>)}</ul>}
      </div>
    </fieldset>
    <label className="checkbox"><input type="checkbox" checked={reviewed} disabled={busy||!entries.length}
      onChange={e=>setReviewed(e.target.checked)}/>已审阅文本及使用依据。</label>
    <button className="button" disabled={busy||!reviewed||!entries.length} type="submit"><FilePlus2 size={16}/>导入 Skill</button>
  </form>;
}

async function fixtureFrom(form,kind) {
  if (form.get('sample-source')!=='custom') return undefined;
  const selected=form.getAll('sample-files').filter(file=>file.name);
  const minimum=kind==='brief'?2:1;
  if (selected.length<minimum || selected.length>6) throw new Error('请为样例选取 '+minimum+'–6 份文字材料。');
  const files=await Promise.all(selected.map(async file=>({name:file.name,content:await utf8(file,64000)})));
  const expectedQuote=form.get('sample-quote').trim() || undefined;
  return {title:form.get('sample-title'),prompt:form.get('sample-prompt'),files,expectedQuote,
    useInChat:form.has('sample-for-chat'),authorized:form.has('sample-authorized')};
}

function SampleFiles() {
  const fileId=useId(), summaryId=useId(), input=useRef();
  const [names,setNames]=useState([]);
  return <div className="sample-file-picker">
    <label htmlFor={fileId}>样例材料</label>
    <input id={fileId} ref={input} className="sr" tabIndex={-1} name="sample-files" type="file" multiple accept=".md,.txt"
      onChange={event=>setNames(Array.from(event.target.files,file=>file.name))}/>
    <div className="sample-file-row">
      <button className="button" type="button" aria-describedby={summaryId} onClick={()=>input.current.click()}>
        <FilePlus2 size={16}/>选择文字材料
      </button>
      <span id={summaryId} className="muted" aria-live="polite">{names.length?names.join('、'):'未选择材料'}</span>
    </div>
  </div>;
}

function SampleFields({origin,kind,reuseKey}) {
  const inherited=origin?.kind===kind?origin.verificationFixture:null;
  const [choice,setChoice]=useState(()=>inherited?'inherited':'builtin');
  const source=choice==='inherited'&&!inherited?'builtin':choice;
  return <fieldset className="sample-fields"><legend>验证样例</legend>
    <label>样例来源<select name="sample-source" value={source} onChange={e=>setChoice(e.target.value)}>
      {inherited&&<option value="inherited">沿用 r{origin.revision} 的自备样例</option>}
      <option value="builtin">内置书店样例</option><option value="custom">自备样例</option>
    </select></label>
    {source==='inherited'&&<div key={reuseKey} className="sample-fields status-in">
      <p className="muted">{inherited.title} · {inherited.fileCount} 份材料 · {origin.exampleTitle?'会话可载入':'仅候选验证'}</p>
      <label className="checkbox"><input name="sample-authorized" type="checkbox" required/>已获授权将此样例用于新版本验证。</label>
    </div>}
    {source==='custom'&&<div className="sample-fields status-in">
      <label>样例名称<input name="sample-title" required maxLength={100}/></label>
      <label>样例任务<textarea name="sample-prompt" required rows={3} maxLength={8000}/></label>
      <SampleFiles/>
      <label>指定引用原文（可选）<textarea name="sample-quote" rows={2} maxLength={460}/></label>
      <label className="checkbox"><input name="sample-authorized" type="checkbox" required/>已获授权将这些文字用于模型验证。</label>
      <label className="checkbox"><input name="sample-for-chat" type="checkbox"/>允许在该 Bot 的会话中载入此样例。</label>
    </div>}
  </fieldset>;
}

const revisionText=revision=>/^[a-f0-9]{40,64}$/i.test(revision)?revision.slice(0,12):revision??'待核对';
const assemblyScope=kind=>kind==='script'?'读取授权文字，确认后写入工作台':'读取授权文字，保存本机简报';

function ComposeBot({workspace,submit,origin,busy,online}) {
  const [name,setName]=useState(origin?.name??''),[id,setId]=useState(origin?.id??''),[description,setDescription]=useState(origin?.description??'');
  const [kind,setKind]=useState(origin?.kind??'brief'),[driver,setDriver]=useState(origin?.driver??'dsh');
  const [selected,setSelected]=useState(origin?.skills??['material-brief']);
  const [workflowId,setWorkflowId]=useState(origin?.workflow?.id??'');
  const heading=useRef(null),moveFocus=useRef(null),harnessDetails=useId(),workflowDetails=useId();
  const selectedDriver=workspace.drivers.find(item=>item.id===driver);
  const workflows=selectedDriver?.workflows?.filter(item=>item.kind===kind)??[];
  const workflow=workflows.find(item=>item.id===workflowId);
  useLayoutEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
  function updateKind(value) {
    setKind(value);
    setWorkflowId('');
    setSelected([value==='script'?'talking-script':'material-brief']);
    if(value==='script')setDriver(workspace.drivers.some(item=>item.id==='dsh-web')?'dsh-web':'dsh');
  }
  const available=workspace.skills.filter(skill=>(!skill.outputKind||skill.outputKind===kind) &&
    (!skill.revokedAt||selected.includes(skill.id)||origin?.skills.includes(skill.id)));
  const byId=new Map(available.map(skill=>[skill.id,skill]));
  const ordered=[...selected.map(id=>byId.get(id)).filter(Boolean),...available.filter(skill=>!selected.includes(skill.id))];
  const atLimit=selected.length>=6;
  useLayoutEffect(()=>{
    moveFocus.current?.focus({preventScroll:true});
    moveFocus.current=null;
  },[selected]);
  function moveSkill(id,offset,control) {
    const index=selected.indexOf(id), next=index+offset;
    if(index<0||next<0||next>=selected.length)return;
    const destination=next===0?'down':next===selected.length-1?'up':control.dataset.direction;
    moveFocus.current=control.parentElement.querySelector('[data-direction="'+destination+'"]');
    const reordered=selected.slice();
    [reordered[index],reordered[next]]=[reordered[next],reordered[index]];
    setSelected(reordered);
  }
  const hasRevoked=!workflow&&available.some(skill=>skill.revokedAt&&selected.includes(skill.id));
  const needsMethod=!workflow&&!selected.length;
  async function save(event) {
    event.preventDefault();
    if (hasRevoked || needsMethod) return;
    const startingLocation=location.hash;
    const form=new FormData(event.currentTarget);
    const saved=await submit(async()=>api('/bots',{id,name,description,kind,driver,skills:workflow?[]:selected,workflow:workflow?.id,
      sourceRevision:origin?.revision,fixture:await fixtureFrom(form,kind),
      reuseSample:form.get('sample-source')==='inherited'?{authorized:form.has('sample-authorized')}:undefined}),
    '已保存候选版本。');
    if(saved&&location.hash===startingLocation)routeTo(browseHref('manage',{bot:saved.id,revision:String(saved.revision)}));
  }
  return <form className={'management-form view-in'+(origin?' derived-assembly':'')} onSubmit={save}>
    {origin&&<div className="assembly-origin"><h2 ref={heading} tabIndex={-1}>基于 {origin.name} r{origin.revision} 装配</h2>
      <p className="muted">保存后须通过样例验证，才可启用新版本。</p></div>}
    <div className="field-grid"><label>Bot 名称<input required value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>稳定 ID<input required value={id} readOnly={!!origin} onChange={e=>setId(e.target.value)} placeholder="例如 materials"/></label>
      <label className="assembly-kind">成果类型<select value={kind} onChange={e=>updateKind(e.target.value)}><option value="brief">素材简报</option><option value="script">口播分镜</option></select></label>
      <div className="assembly-harness"><label>Harness<select value={driver} aria-describedby={harnessDetails}
        onChange={e=>{setDriver(e.target.value);setWorkflowId('');}}>{workspace.drivers.map(item=>
        <option key={item.id} value={item.id} disabled={kind==='script'&&!item.capabilities.includes('script')}>{item.name}</option>)}</select></label>
        <p className="binding-note" id={harnessDetails} aria-live="polite">{selectedDriver
          ? <>将绑定 <code title={selectedDriver.revision}>{revisionText(selectedDriver.revision)}</code></>
          : '请选择本机的 Harness。'}</p></div></div>
    <label>用途说明<textarea required rows={2} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <div className="assembly-details">
      <fieldset><legend>{workflows.length?'任务规则':'引用已审阅的 Skill'}</legend>
        {!!workflows.length&&<label>规则来源<select className="workflow-select" value={workflow?.id??''} aria-describedby={workflow?workflowDetails:undefined}
          onChange={e=>setWorkflowId(e.target.value)}>
          <option value="">引用已审阅的 Skill</option>
          {workflows.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
        {workflow?<p id={workflowDetails} className="binding-note status-in">
          来源提交 <code title={workflow.sourceRevision}>{revisionText(workflow.sourceRevision)}</code>
        </p>:<>
          {selected.length>1&&<p className="binding-note">选中的 Skill 按下列顺序提交。</p>}
          <div className="assembly-skills">{ordered.map(skill=>{
            const index=selected.indexOf(skill.id), checked=index>=0;
            const label=skill.name+' '+skill.version;
            return <div className="assembly-skill" key={skill.id}>
              <label className="checkbox">
                <input type="checkbox" checked={checked} disabled={!checked&&(!!skill.revokedAt||atLimit)}
                  onChange={event=>{
                    const include=event.target.checked;
                    setSelected(current=>include?[...current,skill.id]:current.filter(id=>id!==skill.id));
                  }}/>
                <span>{skill.name} · {skill.version}{skill.revokedAt&&<span className="skill-ended"> · 已撤销</span>}</span>
              </label>
              {checked&&selected.length>1&&<div className="skill-order">
                <button className="icon-button" type="button" data-direction="up" aria-label={'上移 '+label} disabled={index===0}
                  onClick={event=>moveSkill(skill.id,-1,event.currentTarget)}><ArrowUp size={16} aria-hidden="true"/></button>
                <button className="icon-button" type="button" data-direction="down" aria-label={'下移 '+label} disabled={index===selected.length-1}
                  onClick={event=>moveSkill(skill.id,1,event.currentTarget)}><ArrowDown size={16} aria-hidden="true"/></button>
              </div>}
            </div>;
          })}</div>
          {atLimit&&<p className="binding-note">本版已选满 6 个 Skill。</p>}
        </>}
        {hasRevoked&&<p className="binding-note">请取消勾选已撤销的 Skill，再保存候选。</p>}
        {needsMethod&&<p className="binding-note">请选择已审阅的 Skill 或自带流程。</p>}
      </fieldset>
      <SampleFields origin={origin} kind={kind} reuseKey={driver+'/'+(workflow?.id??selected.join(','))}/>
    </div>
    <div className="assembly-permissions" role="group" aria-label="授权范围"><ShieldCheck size={16}/><span>{assemblyScope(kind)}</span></div>
    <button className="button primary" disabled={busy||!online||hasRevoked||needsMethod} type="submit"><Plus size={16}/>
      {origin?'保存下一候选版':'保存候选版本'}</button>
  </form>;
}

async function downloadHistory(bot) {
  if (window.hyperBot) return window.hyperBot.exportBotHistory(bot.id,bot.revision);
  const response=await fetch(apiPath('/bots/'+bot.id+'/'+bot.revision+'/history-export'),{
    cache:'no-store',headers:{'X-Hyper-Bot':'1'}
  });
  if (response.status===410) return {status:'material-ended'};
  if (!response.ok) throw new Error((await response.json()).error || '历史成果暂无法导出。');
  downloadFile(await response.blob(),bot.history.filename);
  return {status:'started',count:Number(response.headers.get('X-Hyper-Bot-Exported'))};
}

function historyNotice({status,count}) {
  if (status==='saved') return '已导出 '+count+' 份历史成果。';
  if (status==='started') return '已开始下载 '+count+' 份历史成果。';
  if (status==='exists') return '已有同名文件。请选择不同的文件名。';
  if (status==='material-ended') return '此版本暂无授权有效的成果可导出。';
}

const sections=[['versions','Bot 版本'],['compose','装配 Bot'],['skills','Skill 与 Harness'],
  ['dependencies','本机依赖'],['receipts','运行回执']];

export function Manage({workspace,refresh,notify,requestedSection,botId,revision,roomId,online}) {
  const [busy,setBusy]=useState(false);
  const [retired,setRetired]=useState('');
  const [sampleRun,setSampleRun]=useState('');
  const retiredHeading=useRef(null),versionHeading=useRef(null);
  useEffect(()=>{
    if (!retiredHeading.current) return;
    if (document.activeElement===document.body) retiredHeading.current.focus({preventScroll:true});
    setRetired('');
  },[retired,workspace.version]);
  const section=sections.some(([key])=>key===requestedSection)?requestedSection:'versions';
  const selectedSample=section==='versions'&&workspace.bots.find(bot=>bot.samplePreviewAvailable&&bot.sample?.runId===sampleRun);
  const drivers=new Map(workspace.drivers.map(driver=>[driver.id,driver]));
  const bot=workspace.bots.find(bot=>bot.id===botId&&String(bot.revision)===revision);
  const versionKey=bot?bot.id+'/'+bot.revision:'';
  useEffect(()=>{
    if(section!=='versions'||!versionKey)return;
    const frame=requestAnimationFrame(()=>{
      const target=versionHeading.current;
      target?.scrollIntoView({block:'nearest',behavior:'instant'});
      target?.focus({preventScroll:true});
    });
    return ()=>cancelAnimationFrame(frame);
  },[section,versionKey]);
  const room=bot&&workspace.conversations.find(room=>room.id===roomId&&room.botId===bot.id&&room.revision===bot.revision);
  async function submit(fn,message) {
    if(busy)return;
    setBusy(true);
    try {
      const result=await fn();
      const notice=result?.ok===false?result.reason:typeof message==='function'?message(result):message;
      if (notice) notify(notice);
      await refresh();
      return result;
    } catch(error) {notify(error.message);}
    finally {setBusy(false);}
  }
  return <>
    <div className="section-head"><div><h1>维护中心</h1><p>选择任务规则与 Harness，验证并管理 Bot 版本。</p></div></div>
    <div className="manage-tabs">{sections.map(([id,label])=><button key={id} aria-pressed={section===id} className="button"
      onClick={()=>routeTo(id==='versions'?'manage':'manage/'+id)}>{label}</button>)}</div>
    {busy&&<p className="muted" role="status">正在处理维护操作…</p>}
    {section==='versions'&&<div className="management-stack">{workspace.bots.filter(bot=>bot.kind!=='teaching').reverse().map(bot=><section className="manage-card" key={bot.id+'/'+bot.revision}>
      <div className="manage-head"><BotMark kind={bot.kind}/><h2
        ref={bot.status==='disabled'&&retired===bot.id+'/'+bot.revision?retiredHeading:
          versionKey===bot.id+'/'+bot.revision?versionHeading:null} tabIndex={-1}>{bot.name} <span className="version">r{bot.revision}</span></h2>
        <span className={'chip '+(bot.status==='enabled'&&!needsReassembly(bot)?'success':'wait')}>
        {bot.status==='enabled'&&needsReassembly(bot)?'待重新装配':({enabled:'已启用',disabled:'已停用',draft:'候选'})[bot.status]}
      </span></div>
      <dl><dt>Harness</dt><dd className="harness-binding"><span>{drivers.get(bot.driver)?.name??bot.driver}</span>
        <code title={bot.driverRevision??undefined}>{revisionText(bot.driverRevision)}</code></dd>
        {bot.harnessChanged&&drivers.has(bot.driver)&&<><dt>本机版本</dt><dd className="harness-binding">
          <code title={drivers.get(bot.driver).revision}>{revisionText(drivers.get(bot.driver).revision)}</code>
        </dd></>}
        {bot.workflow?<><dt>自带流程</dt><dd className="harness-binding">
          <span>{bot.workflow.name}</span><code title={bot.workflow.sourceRevision}>{revisionText(bot.workflow.sourceRevision)}</code>
        </dd></>:<><dt>{bot.skills.length>1?'Skill 顺序':'Skill'}</dt><dd>{bot.skills.map(id=>workspace.skills.find(s=>s.id===id)?.name??id).join('、')||'旧版通用规则'}</dd></>}
        <dt>授权范围</dt><dd>{assemblyScope(bot.kind)}</dd>
        {bot.sourceRevision&&<><dt>来源版本</dt><dd>
          <a className="dependency-link" href={browseHref('manage',{bot:bot.id,revision:String(bot.sourceRevision)})}>r{bot.sourceRevision}</a>
        </dd></>}
        {bot.verificationFixture&&<><dt>样例</dt><dd>{bot.verificationFixture.title} · {bot.verificationFixture.fileCount} 份材料
          {bot.verificationFixture.checksReference?' · 核对指定引用':''}</dd></>}</dl>
      {bot.blocked&&<p className="muted">{bot.blocked}{!needsReassembly(bot)&&<> <a className="dependency-link" href={dependencyHref(bot)}>检查依赖</a></>}</p>}
      {bot.sample&&<p className={'sample-receipt '+(bot.sample.ok&&bot.sampleReady&&!needsReassembly(bot)?'success':'')} role="status">
        {bot.sample.ok?(bot.skillRevoked?'撤销前样例通过 · '+bot.sample.summary:
          bot.sampleReady?(needsReassembly(bot)?'原版本样例通过 · ':'样例已通过 · ')+bot.sample.summary+
            (bot.sample.workbenchRevision?' · 工作台回读成功':'')+
            (bot.sample.evidenceReviewShots?' · '+bot.sample.evidenceReviewShots+' 镜待核对原文':''):
          bot.kind==='script'&&!bot.sample.workbenchRevision?'请重新验证样例，确认工作台可保存并回读。':
          '当前配置需要重新验证样例。'):bot.sample.reason}</p>}
      <div className="manage-actions">
        <a className="button" href={browseHref('manage/compose',{bot:bot.id,revision:String(bot.revision)})}>
          {bot.status==='draft'?'打开装配草稿':'基于此版装配'}
        </a>
        {bot.samplePreviewAvailable&&<button type="button" className="button" disabled={!online}
          onClick={()=>setSampleRun(bot.sample.runId)}><BookOpen size={16}/>查看样例成果</button>}
        {bot.status==='draft'&&<><button className="button" disabled={busy||!!bot.blocked} onClick={()=>submit(
          ()=>api('/bots/'+bot.id+'/'+bot.revision+'/verify',{}),sample=>sample.workbenchRevision?
            '已在独立演练项目保存并回读样例。':'样例已经生成并通过结构与引用校验。')}><FlaskConical size={16}/>验证样例</button>
          <button className="button primary" disabled={busy||!bot.sampleReady||!!bot.blocked} onClick={()=>submit(
            ()=>api('/bots/'+bot.id+'/'+bot.revision+'/publish',{}),'已启用候选版本。')}><PackageCheck size={16}/>启用此版</button></>}
        {bot.status==='disabled'&&<button className="button" disabled={busy||!!bot.blocked} onClick={()=>submit(
          ()=>api('/bots/'+bot.id+'/'+bot.revision+'/restore',{}),'已恢复此版本。')}>恢复此版</button>}
        {bot.status==='enabled'&&<button className="button" disabled={busy} onClick={()=>submit(
          async ()=>{
            await api('/bots/'+bot.id+'/'+bot.revision+'/disable',{});
            setRetired(bot.id+'/'+bot.revision);
          },'已停用此版，待确认的写入授权已撤销。')}>停用此版</button>}
      </div>
      {bot.history&&<div className="retired-history">
        <dl><dt>历史会话</dt><dd>{bot.history.conversations?bot.history.conversations+' 个可在本机打开':'此版暂无会话'}</dd>
          <dt>成果版本</dt><dd>{bot.history.exportable} 份可导出
            {bot.history.unavailable>0&&'，'+bot.history.unavailable+' 个仅保留版本记录'}</dd></dl>
        {bot.history.exportable>0&&<p className="muted retired-format">ZIP 包含 Markdown 稿件、版本记录与引用出处。</p>}
        {!!bot.history.conversations&&<div className="manage-actions">
          <a className="button" href={browseHref('history',{bot:bot.id,revision:String(bot.revision)})}>查看此版会话</a>
          <button type="button" className="button" disabled={busy||!online||!bot.history.exportable}
            onClick={()=>submit(()=>downloadHistory(bot),historyNotice)}><Download size={16}/>导出历史成果</button>
        </div>}
      </div>}
    </section>)}</div>}
    {selectedSample&&<SampleReview key={sampleRun} bot={selectedSample}
      harness={drivers.get(selectedSample.driver)?.name??selectedSample.driver} onClose={()=>setSampleRun('')}/>} 
    {section==='compose'&&((botId||revision)&&!bot
      ? <div className="empty-page"><h2>找不到所选版本</h2><a className="text-button" href="#manage">返回 Bot 版本</a></div>
      : <ComposeBot key={versionKey} workspace={workspace} submit={submit} origin={bot} busy={busy} online={online}/>)}
    {section==='dependencies'&&<LocalDependencies workspace={workspace} bot={bot} room={room} online={online} refresh={refresh} notify={notify}/>}
    {section==='receipts'&&<RunReceipts workspace={workspace} online={online} refresh={refresh} notify={notify}/>}
    {section==='skills'&&<div className="management-stack">
      <section className="manage-card"><h2>已审核 Harness</h2>{workspace.drivers.map(driver=><div className="manage-driver" key={driver.id}>
        <GitBranch size={17}/><span><strong>{driver.name}</strong><small>{driver.revision.substring(0,14)} · {driver.blocked||'可连接'}</small></span>
        <button className="button compact" disabled={busy||!!driver.blocked} onClick={()=>submit(()=>api('/harnesses/'+driver.id,{}),'已登记当前适配器。')}>
          {driver.registered?'核验登记':'登记'}</button></div>)}</section>
      <SkillVersions workspace={workspace} online={online} busy={busy} refresh={refresh} notify={notify}/>
      <section className="manage-card"><h2>导入文本型 Skill</h2><ImportSkill submit={submit} busy={busy}/></section>
    </div>}
  </>;
}


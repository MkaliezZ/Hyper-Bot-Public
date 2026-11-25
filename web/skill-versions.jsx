import React, { useEffect, useId, useRef, useState } from 'react';
import { FileText, ShieldOff, X } from 'lucide-react';
import { api } from './client.js';

function RevokeSkill({skill,affected,drafts,writing,onClose,onRevoked,online}) {
  const dialog=useRef(null), cancel=useRef(null), timer=useRef(null), title=useId();
  const [saving,setSaving]=useState(false),[leaving,setLeaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    const node=dialog.current;
    node.showModal();
    cancel.current?.focus({preventScroll:true});
    return ()=>{clearTimeout(timer.current);if(node.open)node.close();};
  },[]);

  function close(revoked=false) {
    if(leaving)return;
    const finish=()=>{dialog.current?.close();onClose(revoked);};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)finish();
    else {setLeaving(true);timer.current=setTimeout(finish,120);}
  }

  async function confirm(event) {
    event.preventDefault();
    if(saving||leaving||!online)return;
    setSaving(true);setError('');
    try {
      await api('/skills/'+encodeURIComponent(skill.id)+'/revoke',{confirmed:true});
      close(true);
      onRevoked();
    } catch(error) {
      setError(error.message);
    } finally {setSaving(false);}
  }

  return <dialog className={'modal skill-dialog'+(leaving?' closing':'')} ref={dialog} aria-labelledby={title}
    onCancel={event=>{event.preventDefault();if(!saving)close();}}>
    <header className="modal-head"><h2 id={title}>撤销 Skill 版本</h2>
      <button className="icon-button" type="button" aria-label="关闭撤销确认" disabled={saving} onClick={()=>close()}><X size={19}/></button>
    </header>
    <form onSubmit={confirm}>
      <p className="material-name">{skill.name} <span className="version">{skill.version}</span></p>
      {affected.length>0&&<div className="skill-impact">
        <p>这些 Bot 版次将停用，待写入审批随即失效。</p>
        <ul>{affected.map(bot=><li key={bot.id+'/'+bot.revision}>{bot.name} <span className="version">r{bot.revision}</span></li>)}</ul>
      </div>}
      {drafts>0&&<p>{drafts} 个候选版本需换用 Skill 后再验证。</p>}
      {affected.length>0&&<p className="muted">已保存的成果仍可查看和导出。</p>}
      {writing&&<p className="muted">已提交的写入按原项目回执结算。</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" ref={cancel} disabled={saving} onClick={()=>close()}>取消</button>
        <button type="submit" className="button danger" disabled={saving||leaving||!online}><ShieldOff size={16}/>确认撤销</button>
      </div>
    </form>
  </dialog>;
}

export function SkillVersions({workspace,online,busy,refresh,notify}) {
  const [selection,setSelection]=useState(null), headings=useRef(new Map());
  const skill=workspace.skills.find(item=>item.id===selection?.id);
  const enabled=workspace.bots.filter(bot=>bot.status==='enabled');
  const affected=skill?enabled.filter(bot=>bot.skills.includes(skill.id)):[];
  const drafts=skill?workspace.bots.filter(bot=>bot.status==='draft'&&bot.skills.includes(skill.id)).length:0;
  const active=workspace.active;
  const writing=active?.state==='saving'&&affected.some(bot=>bot.id===active.botId&&bot.revision===active.botRevision);

  return <section className="manage-card skill-versions" aria-labelledby="skill-versions">
    <h2 id="skill-versions">Skill 版本</h2>
    {workspace.skills.map(item=>{
      const count=enabled.filter(bot=>bot.skills.includes(item.id)).length;
      return <div className="manage-driver skill-row" key={item.id}>
        <FileText size={17} aria-hidden="true"/>
        <div className="skill-info">
          <h3 tabIndex={-1} ref={node=>{
            if(node)headings.current.set(item.id,node);
            else headings.current.delete(item.id);
          }}>{item.name}</h3>
          <small>{item.version}{count>0&&' · '+count+' 个 Bot 版本使用'}</small>
        </div>
        {item.revokedAt?<span className="chip wait">已撤销</span>:<button type="button" className="button compact"
          disabled={busy||!online} aria-label={'撤销 '+item.name+' '+item.version}
          onClick={event=>setSelection({id:item.id,opener:event.currentTarget})}>撤销…</button>}
      </div>;
    })}
    {skill&&<RevokeSkill skill={skill} affected={affected} drafts={drafts} writing={writing} online={online}
      onClose={revoked=>{
        setSelection(null);
        (revoked?headings.current.get(skill.id):selection.opener)?.focus();
      }}
      onRevoked={()=>{notify('Skill 版本已撤销。');void refresh();}}/>}
  </section>;
}


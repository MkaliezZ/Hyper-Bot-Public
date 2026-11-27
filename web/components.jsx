import React from 'react';
import { AudioLines, ChevronRight, FileText, GraduationCap, ShieldCheck, Video } from 'lucide-react';
import { phases, runHref } from './client.js';

export function BotMark({bot,kind=bot?.kind,className=''}) {
  if(bot?.avatar)return <span className={'bot-mark illustrated '+className} aria-hidden="true">
    <img src={bot.avatar} alt="" width="128" height="128" draggable={false}/>
  </span>;
  return <span className={'bot-mark '+kind+' '+className} aria-hidden="true">
    {kind==='brief'?<FileText/>:kind==='teaching'?<GraduationCap/>:kind==='workbench'?<Video/>:<AudioLines/>}
  </span>;
}

export function ActiveRunLink({run,owner}) {
  const approval=run.state==='waiting_approval';
  const label=approval?'查看写入审批':phases[run.state];
  return <a className={'button compact task-link'+(approval?' requires-approval':'')} href={runHref(run)}
    aria-label={owner?label+' · '+owner:label} title={owner?label+' · '+owner:undefined}>
    {approval&&<ShieldCheck size={15}/>}<span>{label}</span><ChevronRight size={15}/>
  </a>;
}


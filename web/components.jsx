import React from 'react';
import { AudioLines, ChevronRight, FileText, ShieldCheck } from 'lucide-react';
import { phases, runHref } from './client.js';

export function BotMark({kind,className=''}) {
  return <span className={'bot-mark '+kind+' '+className} aria-hidden="true">
    {kind==='brief'?<FileText/>:<AudioLines/>}
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


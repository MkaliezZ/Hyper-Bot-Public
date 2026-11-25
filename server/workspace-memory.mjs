import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Problem, botKey, id } from './contracts.mjs';

const fields={
  title:z.string().trim().min(1).max(60).refine(value=>!/[\p{Cc}]/u.test(value)),
  content:z.string().trim().min(1).max(800).refine(value=>!value.includes('\0')),
  bots:z.array(botKey).default([]),
  confirmed:z.literal(true)
};
const createInput=z.strictObject({...fields,source:z.strictObject({room:id,run:id}).optional()});
const version=z.number().int().positive();
const editInput=z.strictObject({...fields,revision:version});
const revokeInput=z.strictObject({revision:version,confirmed:z.literal(true)});

export const memoryChanged=new Problem(409,'本轮使用的工作区记忆已修改或撤回，请重新发起。','memory_changed');
const matchesBot=(entry,bot)=>!entry.bots.length||entry.bots.includes(bot);

export function listMemories(state) {
  return (state.memories??[]).filter(entry=>!entry.revokedAt).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}

export function memoryRefsFor(state,bot) {
  return listMemories(state).filter(entry=>matchesBot(entry,bot))
    .map(({id,revision,title})=>({id,revision,title}));
}

function boundEntries(state,run) {
  return (run.memoryRefs??[]).map(ref=>(state.memories??[]).find(entry=>entry.id===ref.id&&
    entry.revision===ref.revision&&!entry.revokedAt&&matchesBot(entry,run.botId)));
}

export function currentMemory(state,run) {
  return boundEntries(state,run).every(Boolean);
}

export function memoryContext(state,run) {
  const entries=boundEntries(state,run);
  if (entries.some(entry=>!entry)) throw memoryChanged;
  return entries.map(({title,content})=>({title,content}));
}

export function changeMemory(state,raw,key,revoking,now) {
  const input=(revoking?revokeInput:key?editInput:createInput).parse(raw);
  const records=state.memories??=[];
  if (input.bots?.some(bot=>!state.bots.some(item=>item.id===bot))) {
    throw new Problem(422,'请选择当前工作区已有的 Bot。','memory_scope');
  }
  if (!key) {
    const {title,content,bots,source}=input;
    if (source && !state.runs.some(run=>run.id===source.run&&run.conversation===source.room&&!run.endedAt)) {
      throw new Problem(404,'来源消息在当前工作区不可用。','not_found');
    }
    const item={id:randomUUID(),title,content,bots:[...new Set(bots)],revision:1,author:'本机用户',
      createdAt:now,updatedAt:now,...(source?{source}:{})};
    records.push(item);
    return item;
  }
  const item=records.find(entry=>entry.id===key);
  if (!item||item.revokedAt) throw new Problem(404,'该记忆在当前工作区不可用。','not_found');
  if (item.revision!==input.revision) throw new Problem(409,'记忆已更新，请刷新后再操作。','memory_conflict');
  if (revoking) Object.assign(item,{content:'',revokedAt:now,updatedAt:now});
  else Object.assign(item,{title:input.title,content:input.content,bots:[...new Set(input.bots)],
    revision:item.revision+1,updatedAt:now});
  return item;
}

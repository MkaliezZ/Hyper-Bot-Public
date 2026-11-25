import { z } from 'zod';
import { ALLOWED, Problem } from './contracts.mjs';

const queries=z.strictObject({
  category:z.enum(['work','simulation','verification']).default('work'),
  days:z.enum(['7','30','90','all']).default('30')
});
const shortReference=z.string().trim().max(160).nullable().default(null);
const accountingInput=z.strictObject({
  expectedRevision:z.number().int().nonnegative().default(0),
  activeSeconds:z.number().int().nonnegative().max(31536000).nullable().default(null),
  relationshipUses:z.number().int().nonnegative().max(10000).nullable().default(null),
  relationshipRef:shortReference,
  amountCny:z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/).nullable().default(null),
  billRef:shortReference
});
const tokenKeys=['input','output','cached'];
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const live=run=>Object.hasOwn(ALLOWED,run.state);
const total=rows=>{
  const known=rows.filter(value=>value!==null);
  return {total:known.length?known.reduce((sum,n)=>sum+n,0):null,missing:rows.length-known.length};
};
export const upstreamMode = config => config.upstream==='https://api.deepseek.com'?'deepseek':'test';

export function legacyVerification(bot) {
  const sample=bot.sample;
  if (!sample?.runId||!sample.at) return null;
  return {id:sample.runId,botId:bot.id,botRevision:bot.revision,driver:bot.driver,driverRevision:sample.driverRevision,role:'maintainer',
    state:sample.ok?'succeeded':'failed',error:sample.reason,createdAt:sample.at,finishedAt:sample.at,
    legacyDuration:true,model:sample.model,usage:sample.usage??null};
}

function verifiedRuns(state) {
  const records=state.verifications??[];
  const ids=new Set(records.map(row=>row.id));
  return [...records,...state.bots.map(legacyVerification).filter(row=>row&&!ids.has(row.id))];
}

function usageOf(run) {
  const usage=run.usage;
  const requests=count(usage?.requests);
  const input=count(usage?.input), output=count(usage?.output), cached=count(usage?.cached);
  if (requests===0&&!live(run)) return {requests,input:0,output:0,cached:0,status:'no_call'};
  const reference={requestId:usage?.requestId??null,responseId:usage?.responseId??null,protocol:usage?.protocol??null};
  if (usage?.schema!==1) return {requests,input,output,cached,...reference,status:usage?'legacy':live(run)?'pending':'missing'};
  if (!usage.terminal) return {requests,input:null,output:null,cached:null,...reference,status:live(run)?'pending':'missing'};
  return {requests,input,output,cached,cacheWrite:count(usage.cacheWrite),...reference,
    status:[input,output,cached].includes(null)?'missing':'reported'};
}

function billKey(run,accounting=run.accounting) {
  if (accounting?.amountCny==null||!accounting.billRef) return null;
  const source=run.modelMode==='test'?'fixture':'provider';
  return source+':'+accounting.billRef.normalize('NFC');
}

function rowOf(run,category,billConflict) {
  const ended=run.finishedAt??(live(run)?null:run.updatedAt);
  const elapsed=ended?Date.parse(ended)-Date.parse(run.createdAt):null;
  const delivered=category!=='verification'&&!!run.artifact;
  return {
    id:run.id,conversation:run.conversation??null,botId:run.botId,botRevision:run.botRevision,
    driver:run.driver,driverRevision:run.driverRevision??null,model:run.model??null,modelMode:run.modelMode??null,category,
    role:run.role??'user',createdAt:run.createdAt,finishedAt:ended??null,
    elapsedMs:!run.legacyDuration?count(elapsed):null,retryOf:run.retryOf??null,
    state:run.state,delivered,reconciled:!!run.reconciled,recoveryPending:run.recovery==='required',
    reason:run.endedAt?null:run.error??null,usage:usageOf(run),accounting:run.accounting??null,
    ...(billConflict?{billConflict:true}:{}),
    ...(run.stop?{stop:run.stop}:{})
  };
}

function toMicros(value) {
  const [whole,decimal='']=value.split('.');
  return BigInt(whole)*1000000n+BigInt(decimal.padEnd(6,'0'));
}

function fromMicros(value) {
  const whole=value/1000000n;
  const decimal=(value%1000000n).toString().padStart(6,'0').replace(/0+$/,'');
  return decimal?whole.toString()+'.'+decimal:whole.toString();
}

function summarize(rows) {
  const delivered=rows.filter(row=>row.delivered).length;
  const active=rows.filter(live).length;
  const terminal=rows.length-active;
  const failed=rows.filter(row=>!row.delivered&&['failed','interrupted'].includes(row.state)).length;
  const missing=rows.filter(row=>['missing','legacy'].includes(row.usage.status)).length;
  const tokens=Object.fromEntries(tokenKeys.map(field=>[field,total(rows.map(row=>
    ['legacy','pending'].includes(row.usage.status)?null:row.usage[field]
  ))]));
  const billed=rows.filter(row=>row.accounting?.amountCny!=null&&!row.billConflict);
  const billConflicts=rows.filter(row=>row.billConflict).length;
  const cashMissing=rows.filter(row=>row.usage.requests!==0&&row.accounting?.amountCny==null).length;
  const cash=billed.reduce((sum,row)=>sum+toMicros(row.accounting.amountCny),0n);
  return {
    total:rows.length,delivered,active,failed,
    cancelled:rows.filter(row=>row.state==='cancelled').length,
    verified:rows.filter(row=>row.category==='verification'&&row.state==='succeeded').length,
    retries:rows.filter(row=>row.retryOf).length,missing,
    failureRate:terminal?failed/terminal:null,
    requests:total(rows.map(row=>row.usage.requests)),tokens,
    averageTokens:delivered&&!active&&!tokens.input.missing&&!tokens.output.missing
      ? (tokens.input.total+tokens.output.total)/delivered:null,
    accounting:{
      activeSeconds:total(rows.map(row=>row.accounting?.activeSeconds??null)),
      relationshipUses:total(rows.map(row=>row.accounting?.relationshipUses??null)),
      amountCny:billed.length?fromMicros(cash):null,cashMissing,billConflicts,
      averageCny:delivered&&!active&&!cashMissing&&!billConflicts&&billed.length
        ? fromMicros((cash+BigInt(Math.floor(delivered/2)))/BigInt(delivered)):null
    }
  };
}

export function receiptReport(state,raw,now=Date.now()) {
  const filters=queries.parse(raw);
  const through=new Date(now).toISOString();
  const from=filters.days==='all'?null:new Date(now-Number(filters.days)*86400000).toISOString();
  const simulations=new Set(state.conversations.filter(room=>room.simulation).map(room=>room.id));
  const verifications=verifiedRuns(state);
  const counts=new Map();
  for (const run of [...state.runs,...verifications]) {
    const key=billKey(run);
    if (key) counts.set(key,(counts.get(key)??0)+1);
  }
  const rows=filters.category==='verification' ? verifications :
    state.runs.filter(run=>(
      simulations.has(run.conversation)||run.modelMode==='test'?'simulation':'work'
    )===filters.category);
  const window=rows.filter(row=>row.createdAt<=through&&(!from||row.createdAt>=from))
    .map(run=>rowOf(run,filters.category,counts.get(billKey(run))>1))
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  return {filters,from,through,summary:summarize(window),rows:window};
}

export function storeAccounting(store,id,input) {
  const {expectedRevision,...values}=accountingInput.parse(input);
  values.billRef=values.billRef||null;
  values.relationshipRef=values.relationshipRef||null;
  if (values.amountCny!==null&&!values.billRef) {
    throw new Problem(422,'请填写已核对的账单条目编号。','bill_reference');
  }
  if (values.relationshipUses>0&&!values.relationshipRef) {
    throw new Problem(422,'请填写关系动用记录编号。','relationship_reference');
  }
  return store.change((state,emit)=>{
    let run=state.runs.find(row=>row.id===id)??state.verifications?.find(row=>row.id===id);
    if (!run) {
      run=verifiedRuns(state).find(row=>row.id===id);
      if (!run) throw new Problem(404,'找不到此任务回执。','not_found');
      (state.verifications??=[]).push(run);
    }
    if(live(run)) throw new Problem(409,'任务结束后可以登记实际记录。','state_conflict');
    const revision=run.accounting?.revision??0;
    if(revision!==expectedRevision) throw new Problem(409,'核对记录已更新。请重新打开后再编辑。','accounting_conflict');
    const key=billKey(run,values);
    if (key && (key!==billKey(run)||values.amountCny!==run.accounting?.amountCny)) {
      const duplicate=[...state.runs,...(state.verifications??[])].find(row=>row.id!==run.id&&billKey(row)===key);
      if (duplicate) throw new Problem(409,'该账单条目已登记到任务 '+duplicate.id.slice(0,8)+'。请核对本轮条目。','bill_entry_conflict');
    }
    run.accounting={...values,revision:revision+1,recordedAt:new Date().toISOString()};
    emit(run,'accounting_recorded',{role:'maintainer',accounting:run.accounting});
    return run.accounting;
  });
}


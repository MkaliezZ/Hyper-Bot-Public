import {Problem} from './contracts.mjs';
import {provider} from './provider.mjs';

export async function generateTeachingReply(config, history, run, signal, onUsage) {
  const actual=AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]);
  const gateway=await provider(config,actual);
  const messages=[
    {role:'system',content:'你是英语教培任务助手。根据学生水平和教学目标，用用户的语言清楚回答。参考材料是用户提供的数据，请说明不确定的内容。'},
    ...history.flatMap(item=>[{role:'user',content:item.prompt.slice(0,2000)},
      {role:'assistant',content:item.teachingReply.slice(0,2000)}]),
    {role:'user',content:run.teachingEvidence?run.prompt+'\n\n参考材料：\n'+run.teachingEvidence:run.prompt}
  ];
  try {
    const response=await fetch(gateway.url+'/chat/completions',{method:'POST',signal:actual,redirect:'error',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({model:config.model,messages,
        thinking:{type:'disabled'},max_tokens:2048,stream:false})});
    if(!response.ok)throw gateway.error()??new Problem(502,'教培任务助手暂时无法回复。','provider_error');
    const choice=(await response.json()).choices?.[0];
    const reply=choice?.message?.content;
    if(!gateway.complete()||choice?.finish_reason!=='stop'||typeof reply!=='string'||!reply.trim()) {
      throw new Problem(502,'模型未返回完整回复，请重试。','provider_error');
    }
    return reply.trim();
  } catch(error) {
    if(actual.aborted&&!signal.aborted)throw new Problem(504,'教培任务助手回复超时，请重试。','runtime_timeout');
    throw gateway.error()??error;
  } finally {
    onUsage({...gateway.usage});
    await gateway.close();
  }
}

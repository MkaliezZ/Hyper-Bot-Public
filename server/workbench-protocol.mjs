import { Problem, sha } from './contracts.mjs';

export const projectId = /^[a-f0-9]{32}$/;
export const sourceId = /^E[a-f0-9]{32}$/;
export const scriptId = /^A[a-f0-9]{32}$/;
const sortFields = value => {
  if (Array.isArray(value)) return value.map(sortFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortFields(value[key])]));
  }
  return value;
};
export const payloadHash = value => sha(JSON.stringify(sortFields(value)));
export const planDigest = plan => payloadHash(plan.original
  ? {project:plan.project,original:plan.original,conversation:plan.conversation,body:plan.body,register:plan.register}
  : plan.body);

export function projectPath(project,suffix) {
  if (typeof project!=='string' || !projectId.test(project)) throw new Problem(400,'工作台项目编号无效。');
  return '/api/agent/v1/projects/'+project+suffix;
}

export async function workbenchRequest(origin,method,route,body,signal,headers={}) {
  let response;
  try {
    const timeout=AbortSignal.timeout(15000);
    response=await fetch(origin+route,{method,redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
      headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body)});
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new Problem(503,'工作台连接中断。','workbench_transport');
  }
  const result=await response.json().catch(()=>null);
  if (!response.ok || result===null) {
    const status=response.status;
    const code=status===409?'workbench_conflict':status===422?'workbench_validation':
      status===404?'workbench_missing':'workbench_transport';
    const reason=status===409?'原项目在审批期间发生变化，请核对后重新生成。':
      status===422?'工作台校验未通过，已有稿件仍可查看。':
      status===404?'原工作台项目无法打开。':'工作台未返回可确认的结果。';
    throw new Problem(status>=400?status:502,reason,code);
  }
  return result;
}


import assert from 'node:assert/strict';

export function windowRequest(page,route,body) {
  assert.ok(route.startsWith('/api/')&&!route.startsWith('//'));
  return page.evaluate(async ({route,body})=>{
    const response=await fetch(route,{signal:AbortSignal.timeout(5000),
      ...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},
        body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  },{route,body});
}

export async function readWindow(page,route) {
  const {status,data}=await windowRequest(page,route);
  assert.equal(status,200,'Expected a successful desktop read for '+route+' ('+data.code+')');
  return data;
}

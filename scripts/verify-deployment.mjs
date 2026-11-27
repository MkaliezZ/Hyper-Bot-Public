import { readFile } from 'node:fs/promises';
import packageInfo from '../package.json' with { type:'json' };

const dist=new URL('../dist/',import.meta.url);
const timeout=()=>AbortSignal.timeout(5000);

async function request(url) {
  const response=await fetch(url,{redirect:'error',cache:'no-store',signal:timeout()}).catch(error=>{
    throw new Error('无法连接 '+url.origin+'。请核对新服务启动时打印的地址。',{cause:error});
  });
  if(!response.ok)throw new Error(url.pathname+' 返回 HTTP '+response.status+'。');
  return response;
}

async function compareFile(origin, route, filename) {
  const file=new URL(filename,dist);
  const expected=await readFile(file).catch(error=>{
    if(error.code==='ENOENT')throw new Error('本地构建缺少 '+filename+'。请先运行 npm run build。');
    throw error;
  });
  const response=await request(new URL(route,origin));
  const actual=Buffer.from(await response.arrayBuffer());
  if(!expected.equals(actual)){
    throw new Error(route+' 与当前目录下的构建产物不同。请检查实际访问地址和 HYPER_BOT_FRONTEND_ASSETS。');
  }
  return expected.toString('utf8');
}

async function verify() {
  const origin=new URL(process.argv[2]??('http://127.0.0.1:'+(process.env.HYPER_BOT_PORT??4367)));
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.pathname!=='/'||
    origin.search||origin.hash||origin.username||origin.password){
    throw new Error('请传入 npm start 打印的本机地址，例如 http://127.0.0.1:4367。');
  }
  const html=await compareFile(origin,'/','index.html');
  const builtVersion=html.match(/<meta name="hyper-bot-version" content="([^"]+)"/)?.[1];
  if(builtVersion!==packageInfo.version){
    throw new Error('本地前端尚未构建为 '+packageInfo.version+'。请运行 npm run build。');
  }
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css))"/g)].map(match=>match[1]);
  if(!assets.some(asset=>asset.endsWith('.js'))||!assets.some(asset=>asset.endsWith('.css'))){
    throw new Error('dist/index.html 缺少已构建的前端入口。请重新运行 npm run build。');
  }
  await Promise.all(assets.map(asset=>compareFile(origin,asset,asset.slice(1))));

  const workspace=await request(new URL('/api/workspace',origin)).then(response=>response.json());
  if(workspace.appVersion!==packageInfo.version){
    throw new Error('运行中的后端版本为 '+(workspace.appVersion??'旧版')+'，预期为 '+packageInfo.version+'。请从更新后的目录重新启动。');
  }
  const media=workspace.bots?.filter(bot=>bot.kind==='workbench'&&bot.status==='enabled')??[];
  if(media.length!==20){
    throw new Error('工作区接口返回 '+media.length+' 个自媒体专项 Bot，预期为 20 个。请检查当前运行的后端源码。');
  }
  const teaching=workspace.bots?.filter(bot=>bot.kind==='teaching'&&bot.status==='enabled')??[];
  if(teaching.length!==10){
    throw new Error('工作区接口返回 '+teaching.length+' 个内置教培 Bot，预期为 10 个。请检查当前运行的后端源码。');
  }
  if(!workspace.localDependencies?.checks?.['teaching-lessons']?.ok){
    throw new Error('课件依赖未就绪。请运行 npm run setup:teaching 并重新启动服务。');
  }
  console.log('已验证 '+origin.origin+' 运行 '+packageInfo.version+'，首页、JS 和 CSS 与本地构建一致。目录含 20 个自媒体专项 Bot 和 10 个英语教培 Bot，课件依赖已就绪。');
}

try {
  await verify();
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}

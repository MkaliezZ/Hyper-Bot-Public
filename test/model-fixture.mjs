import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

function extract(body) {
  const chunks=body.messages?.filter(row=>row.role==='user').flatMap(row=>
    Array.isArray(row.content)?row.content.map(part=>part.text ?? ''):[String(row.content)]) ?? [];
  const value=chunks.join('\n');
  const marker='授权材料（只读）：\n';
  const index=value.lastIndexOf(marker);
  return { text:value, sources:index<0?[]:JSON.parse(value.slice(index+marker.length,value.lastIndexOf(']')+1)) };
}

export function sample({text,sources}) {
  const [a,b]=sources;
  const quote='我每天先把门口那排书摆好，再开灯。';
  const aQuote=a?.content.includes(quote)?quote:a?.content.split('\n').at(-1);
  const bQuote=b?.content.split('\n').at(-1);
  if (text.includes('分歧或缺项') && !text.includes('"segments"')) {
    return {title:'书店开门前的素材简报',points:[{name:'开门准备',text:'店主先摆书再开灯。',
      evidence:[{material:a.id,quote:aQuote}]},{name:'拍摄顺序',text:'按现场动作保留声画线索。',
      evidence:[{material:b.id,quote:bQuote}]}],notes:['拍摄时核对现场可收录的声音。']};
  }
  const first=text.includes('这次只改开场')?'今天，从店主摆好第一排书开始。':'“'+aQuote+'”';
  const list=[
    ['开门',0,6,first,'钥匙和门把手近景，门开后停半秒。','街角书店开门前',a,aQuote],
    ['摆书',6,18,'门边的书一本本排好，人行道上的脚步声从画外过去。','近拍店主摆书，接门口书架。','先把门口的书摆好',b,bQuote],
    ['开灯',18,32,'书摆好了，他才伸手开灯。刚才看不清的书脊，这时慢慢显出来。','跟手拍开关，再拍亮起的书架。','然后开灯',b,bQuote],
    ['翻书',32,45,'翻开一本书，等纸划过指尖，再听一次翻页声。','固定机位拍桌面和纸页，留两秒原声。','书店开门了',b,bQuote]
  ];
  return {title:'书店开门前的 45 秒',segments:list.map(([name,start,end,spoken,visual,subtitle,source,quote])=>({
    name,start,end,spoken,visual,subtitle,evidence:source?[{material:source.id,quote}]:[]
  })),notes:[]};
}

export async function modelFixture({observe,respond=sample,reportedUsage,beforeResponse}={}) {
  const calls=[];
  const server=http.createServer(async (request,response)=>{
    try {
      const input=[];
      for await(const part of request)input.push(part);
      const body=JSON.parse(Buffer.concat(input));
      const prompt=extract(body);
      observe?.(prompt);
      calls.push({route:request.url, tools:body.tools?.length??0, materialCount:prompt.sources.length, model:body.model});
      const paused=beforeResponse?.(prompt,response);
      if(paused)await paused;
      else if(prompt.text.includes('慢速取消'))await sleep(3200);
      if(response.destroyed)return;
      const content=JSON.stringify(respond(prompt));
      response.writeHead(200,{'Content-Type':'text/event-stream','X-Request-Id':'fixture-request-'+calls.length});
      const write=(event,data)=>response.write((event?'event: '+event+'\n':'')+'data: '+JSON.stringify(data)+'\n\n');
      if(request.url.includes('/messages')) {
        write('message_start',{type:'message_start',message:{id:'hb-fixture',type:'message',role:'assistant',
          model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:180,output_tokens:0,cache_read_input_tokens:0}}});
        write('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
        write('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:content}});
        write('content_block_stop',{type:'content_block_stop',index:0});
        const usage=reportedUsage ? reportedUsage(prompt,'messages')
          : {input_tokens:180,output_tokens:180,cache_read_input_tokens:0,cache_creation_input_tokens:0};
        write('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage});
        write('message_stop',{type:'message_stop'});
      } else {
        const chunk={id:'hb-fixture',object:'chat.completion.chunk',created:1,model:body.model};
        write(null,{...chunk,choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]});
        write(null,{...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]});
        const usage=reportedUsage ? reportedUsage(prompt,'chat-completions')
          : {prompt_tokens:180,completion_tokens:180,prompt_cache_hit_tokens:0};
        write(null,{...chunk,choices:[],usage});
        response.write('data: [DONE]\n\n');
      }
      response.end();
    } catch(error) {
      console.error('Hyper Bot protocol fixture:',error.name,error.message);
      if(!response.headersSent)response.writeHead(422);response.end();
    }
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {origin:'http://127.0.0.1:'+server.address().port,calls,async close() {
    const done=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await done;
  }};
}


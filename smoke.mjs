import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base=process.env.COPILOT_BASE_URL||'http://127.0.0.1:8787';
const headers={'Content-Type':'application/json; charset=utf-8'};
if(process.env.COPILOT_API_KEY)headers.Authorization=`Bearer ${process.env.COPILOT_API_KEY}`;
async function request(path,body){
  const response=await fetch(base+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
  const data=await response.json();
  if(!response.ok)throw new Error(JSON.stringify({status:response.status,...data},null,2));
  return data;
}
try{
  const state=await request('/status');assert.equal(state.state,'ready',JSON.stringify(state));
  const token='COPILOT_HTTP_'+randomUUID().replaceAll('-','');
  const body={prompt:'请只回复下一行的字符串，不要添加其他内容：\n'+token,request_id:token};
  const answer=await request('/chat',body);assert.equal(answer.state,'completed');assert.equal(answer.answer.trim(),token);
  const repeated=await request('/chat',body);assert.equal(repeated.answer,answer.answer);
  const token2='COPILOT_OPENAI_'+randomUUID().replaceAll('-','');
  const openai=await request('/v1/chat/completions',{model:'copilot-web',stream:false,messages:[{role:'user',content:'Reply with exactly this string and nothing else: '+token2}]});
  assert.equal(openai.choices[0].message.content.trim(),token2);
  console.log(JSON.stringify({passed:true,chat:answer,openai},null,2));
  console.log('PASS: HTTP -> Playwright CLI -> existing Edge -> Copilot -> answer -> HTTP');
}catch(e){console.error(e.message);process.exitCode=1;}

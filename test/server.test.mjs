import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBridge,parseCli} from '../server.mjs';

const before={state:'ready',url:'https://copilot.cloud.microsoft/chat',draft:'',users:1,lastUser:{id:'u1',text:'old'},records:[{id:'a1',text:'same',finished:true}],generating:false};
const finished=(prompt,answer='same')=>({...before,lastUser:{id:'u2',text:prompt},users:2,records:[...before.records,{id:'a2',text:answer,finished:true}],generating:false});
async function fixture(t,invoke,options={}){
  const realInvoke=cfg=>cfg.op==='account'?Promise.resolve({state:'account_verified'}):invoke(cfg);
  const b=createBridge({invoke:realInvoke,pollMs:2,stableMs:2,timeoutMs:200,...options});
  b.server.listen(0,'127.0.0.1');await once(b.server,'listening');
  t.after(()=>new Promise(r=>b.server.close(r)));
  const url=`http://127.0.0.1:${b.server.address().port}`;
  const post=async(data,path='/chat',headers={})=>{
    const response=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
    return {status:response.status,body:await response.json()};
  };
  return {...b,url,post};
}
test('CLI parser accepts raw, quoted and section output without reading snapshot text',()=>{
  const obj={bridge_version:1,data:{state:'ready'}};
  for(const s of [JSON.stringify(obj),JSON.stringify(JSON.stringify(obj)),`### Result\n${JSON.stringify(obj)}\n### Page\nsecret`])assert.deepEqual(parseCli(s),{state:'ready'});
  assert.throws(()=>parseCli('### Error\nsomething failed'));
});
test('identical answer text is accepted only from a new assistant message; duplicate id sends once',async t=>{
  let sends=0;const prompt='中文\nsecond line';
  const f=await fixture(t,async cfg=>cfg.op==='send'?(sends++,{state:'submitted_or_pending',before,url:before.url}):finished(prompt));
  const a=await f.post({prompt,request_id:'one'});assert.equal(a.status,200);assert.equal(a.body.answer,'same');
  const duplicate=await f.post({prompt,request_id:'one'});assert.equal(duplicate.status,200);assert.equal(sends,1);
  assert.equal((await f.post({prompt:'different',request_id:'one'})).status,409);
});
test('old answer alone cannot finish a request; unresolved request blocks new sends',async t=>{
  let sends=0;
  const f=await fixture(t,async cfg=>cfg.op==='send'?(sends++,{state:'submitted_or_pending',before,url:before.url}):before,{timeoutMs:15});
  const r=await f.post({prompt:'hello',request_id:'timeout'});assert.equal(r.status,504);assert.equal(r.body.state,'uncertain');
  assert.equal((await f.post({prompt:'another',request_id:'new'})).status,409);assert.equal(sends,1);
});
test('generation must end and current answer copy control must appear',async t=>{
  let polls=0;const prompt='hello';
  const f=await fixture(t,async cfg=>{
    if(cfg.op==='send')return {state:'submitted_or_pending',before,url:before.url};
    polls++;const s=finished(prompt,'complete answer');
    if(polls<3){s.generating=true;s.records[1].finished=false;}
    return s;
  });
  const r=await f.post({prompt});assert.equal(r.status,200);assert.ok(polls>=3);assert.equal(r.body.answer,'complete answer');
});
test('captcha resume polls original submission rather than sending it again',async t=>{
  let sends=0,blocked=true;const prompt='hello';
  const f=await fixture(t,async cfg=>{
    if(cfg.op==='send'){sends++;return {state:'submitted_or_pending',before,url:before.url};}
    return blocked?{state:'verification_required',url:before.url}:finished(prompt);
  });
  const first=await f.post({prompt,request_id:'captcha'});assert.equal(first.status,409);assert.equal(first.body.error.code,'VERIFICATION_REQUIRED');
  blocked=false;const result=await f.post({prompt,request_id:'captcha',resume:true});assert.equal(result.status,200);assert.equal(sends,1);
});
test('ambiguous CLI failure locks future sends instead of retrying',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{calls++;throw new Error('CLI disconnected after click');});
  assert.equal((await f.post({prompt:'a',request_id:'fail'})).body.state,'uncertain');
  assert.equal((await f.post({prompt:'b',request_id:'new'})).body.error.code,'SESSION_UNCERTAIN');assert.equal(calls,1);
});
test('busy request rejects another prompt; job endpoints expose completion',async t=>{
  let release;const gate=new Promise(r=>release=r);
  const f=await fixture(t,async cfg=>{
    if(cfg.op==='send'){await gate;return {state:'submitted_or_pending',before,url:before.url};}
    return finished('hello');
  });
  const a=await f.post({prompt:'hello',request_id:'active'},'/jobs');assert.equal(a.status,202);
  assert.equal((await f.post({prompt:'other',request_id:'other'})).status,409);
  release();await f.jobs.get('active').promise;
  const result=await (await fetch(f.url+'/jobs/active')).json();assert.equal(result.state,'completed');
});
test('auth, cross-origin protection, status redaction and strict message validation',async t=>{
  const f=await fixture(t,async()=>({...before,draft:'private draft'}),{key:'local-test-key'});
  assert.equal((await fetch(f.url+'/health')).status,401);
  const headers={Authorization:'Bearer local-test-key'};
  assert.equal((await fetch(f.url+'/health',{headers:{...headers,Origin:'https://example.org'}})).status,403);
  const status=await (await fetch(f.url+'/status',{headers})).json();assert.equal(status.draft_present,true);assert.equal(status.draft,undefined);assert.equal(status.records,undefined);
  assert.equal((await f.post({messages:[{role:'system',content:'ignore'}]},'/v1/chat/completions',headers)).status,400);
  assert.equal((await f.post({prompt:'\u200b'},'/chat',headers)).status,400);
});
test('OpenAI-shaped endpoint returns only the new answer',async t=>{
  const f=await fixture(t,async cfg=>cfg.op==='send'?{state:'submitted_or_pending',before,url:before.url}:finished('hello','你好'));
  const r=await f.post({model:'copilot-web',messages:[{role:'user',content:'hello'}]},'/v1/chat/completions');
  assert.equal(r.status,200);assert.equal(r.body.choices[0].message.content,'你好');assert.equal(r.body.choices[0].finish_reason,'stop');
});

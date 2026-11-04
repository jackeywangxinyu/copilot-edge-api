import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import flow from '../browser-flow.mjs';

// Locator stubs verify driver decisions. These are not live browser tests.
function fixture({draft='',clickTimeout=false,count=1,account='you@example.com'}={}){
  let clicks=0,fills=0,evaluatedEmpty=false;
  const input={isVisible:async()=>true,innerText:async()=>draft,fill:async s=>{draft=s;fills++;},click:async()=>{}};
  const empty={count:async()=>0,last:()=>({evaluate:async()=>{evaluatedEmpty=true;throw new Error('No message');}})};
  const assistants={evaluateAll:async callback=>callback([])};
  const send={isVisible:async()=>true,isEnabled:async()=>true,click:async()=>{clicks++;if(clickTimeout)throw new Error('Timeout after dispatch');}};
  const signOut={isVisible:async()=>true,waitFor:async()=>{},getAttribute:async()=>`Sign out from ${account}`};
  const tab={url:()=> 'https://copilot.cloud.microsoft/chat',
    locator:selector=>{
      if(selector==='#m365-chat-editor-target-element')return input;
      if(selector==='#me-control-sign-out-button')return signOut;
      if(selector.includes('iframe'))return {all:async()=>[]};
      if(selector.includes('user-message-'))return empty;
      if(selector.includes('copilot-message-'))return assistants;
      throw new Error('Unexpected selector: '+selector);
    },
    getByText:()=>({all:async()=>[]}),
    getByRole:(role,options)=>{
      if(options.name.test('发送'))return {all:async()=>[send]};
      if(options.name.test('停止生成'))return {isVisible:async()=>false};
      return {count:async()=>1,click:async()=>{}};
    }};
  const page={context:()=>({pages:()=>Array(count).fill(tab)})};
  return {page,counts:()=>({clicks,fills,evaluatedEmpty})};
}
const cfg={origin:'https://copilot.cloud.microsoft',op:'send',prompt:'hello'};
test('flow is a self-contained function suitable for CLI run-code',async()=>{
  const standalone=vm.runInNewContext(`(${flow.toString()})`,{URL});
  const f=fixture();const r=await standalone(f.page,cfg);
  assert.equal(r.state,'submitted_or_pending');assert.equal(f.counts().clicks,1);assert.equal(f.counts().evaluatedEmpty,false);
});
test('click timeout does not trigger another click or destroy the pre-send baseline',async()=>{
  const f=fixture({clickTimeout:true});const r=await flow(f.page,cfg);
  assert.equal(r.state,'submitted_or_pending');assert.equal(r.before.users,0);assert.ok(r.clickError);assert.equal(f.counts().clicks,1);
});
test('an unrelated draft is preserved',async()=>{
  const f=fixture({draft:'my unfinished draft'});const r=await flow(f.page,cfg);
  assert.equal(r.code,'DRAFT_EXISTS');assert.equal(f.counts().fills,0);assert.equal(f.counts().clicks,0);
});
test('an already matching draft is sent without overwriting it',async()=>{
  const f=fixture({draft:'hello\u200b'});const r=await flow(f.page,cfg);
  assert.equal(r.state,'submitted_or_pending');assert.equal(f.counts().fills,0);assert.equal(f.counts().clicks,1);
});
test('multiple tabs are rejected before any send',async()=>{
  const f=fixture({count:2});const r=await flow(f.page,cfg);
  assert.equal(r.code,'MULTIPLE_TABS');assert.equal(f.counts().clicks,0);
});
test('account verification rejects a different signed-in email',async()=>{
  const f=fixture({account:'other@example.com'});const r=await flow(f.page,{...cfg,op:'account',expectedAccount:'you@example.com'});
  assert.equal(r.code,'ACCOUNT_MISMATCH');assert.equal(f.counts().clicks,0);
});

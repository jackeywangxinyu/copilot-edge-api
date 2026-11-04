import http from 'node:http';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import browserFlow from './browser-flow.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(r=>setTimeout(r,ms));
const CLI = 'playwright-cli';
const CLI_INSTALL = 'npm install -g @playwright/cli@0.1.23';
const ORIGIN = process.env.COPILOT_ORIGIN || 'https://copilot.cloud.microsoft';
export class BridgeError extends Error {
  constructor(code,message,status=502,extra={}) {super(message);Object.assign(this,{code,status,extra});}
}

export function parseCli(text) {
  const value = text.trim().replace(/^\ufeff/,'');
  const candidates = [value];
  const section = value.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
  if (section) candidates.push(section[1].trim());
  for (const candidate of candidates) {
    try {
      let result = JSON.parse(candidate);
      if (typeof result === 'string') result = JSON.parse(result);
      if (result?.bridge_version === 1) return result.data;
    } catch {}
  }
  throw new BridgeError('CLI_RESULT_INVALID','Playwright CLI did not return a bridge result. Check the CLI session and version.');
}

// Windows installs a global npm command as a .cmd file, which runs only through a shell.
const spawnCli = (args,options) => process.platform==='win32'
  ? spawn(`${CLI}.cmd`,args.map(a=>`"${a}"`),{...options,shell:true})
  : spawn(CLI,args,{...options,shell:false});

export async function createCli({cwd=ROOT,session=process.env.COPILOT_SESSION||'msedge',
  target=process.env.COPILOT_CDP||'msedge',cliTimeout=60000}={}) {
  const scratch = await mkdtemp(join(tmpdir(),'copilot-edge-api-'));
  const env = {...process.env};
  // A stale implicit endpoint can override the explicitly selected session.
  delete env.PLAYWRIGHT_CLI_SESSION;
  const run = args => new Promise((resolveCommand,reject)=>{
    const child=spawnCli(args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='',settled=false;
    const fail=e=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}};
    const timer=setTimeout(()=>{child.kill();fail(new BridgeError('CLI_TIMEOUT','CLI timed out; submission may already have occurred. Do not blindly retry.',504));},cliTimeout);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>{out+=s;if(out.length>4_000_000){child.kill();fail(new BridgeError('CLI_OUTPUT_LIMIT','CLI output exceeded limit.'));}});
    child.stderr.on('data',s=>{err=(err+s).slice(-8000);});
    child.on('error',fail);
    child.on('close',code=>{
      if(settled)return;settled=true;clearTimeout(timer);
      const detail=(out.match(/### Error\s*\n([^\n]+)/)?.[1]||err.trim()||out.trim().split('\n')[0]||'').slice(0,400);
      if(code!==0) reject(new BridgeError('CLI_FAILED',`Playwright CLI exited ${code}. ${detail}`));
      else resolveCommand(out);
    });
  });
  const command=args=>run([`-s=${session}`,...args]);
  const version=async()=>{
    try {return (await run(['--version'])).trim();}
    catch(e) {throw new BridgeError('CLI_MISSING',`Install the global command once: ${CLI_INSTALL} (${e.message})`,503);}
  };
  const invoke=async cfg=>{
    const file=join(scratch,`${randomUUID()}.js`);
    const code=`async (page) => ({bridge_version:1,data:await (${browserFlow.toString()})(page,${JSON.stringify(cfg)})})`;
    await writeFile(file,code,{encoding:'utf8',mode:0o600});
    try {return parseCli(await command(['--raw','run-code',`--filename=${file}`]));}
    finally {await rm(file,{force:true});}
  };
  const attach=async()=>{await command(['attach',`--cdp=${target}`]);};
  return {version,invoke,attach,close:()=>rm(scratch,{recursive:true,force:true})};
}

// Reads the attached browser state. Attaches first only if the session has no browser.
export async function connect(cli) {
  const status={op:'status',origin:ORIGIN,url:process.env.COPILOT_TAB_URL||undefined};
  try {return await cli.invoke(status);}
  catch {await cli.attach();return cli.invoke(status);}
}

export function createBridge({invoke,origin=ORIGIN,tabUrl='',
  timeoutMs=180000,pollMs=1200,stableMs=1800,key=process.env.COPILOT_API_KEY||'',
  expectedAccount=process.env.COPILOT_EXPECTED_ACCOUNT||''}={}) {
  if(!invoke)throw new Error('invoke is required');
  const jobs=new Map();let active=null;let poisoned=false;
  const config=(op,extra={})=>({op,origin,url:tabUrl||undefined,...extra});
  const errorFor=s=>{
    if(s.state==='verification_required')return new BridgeError('VERIFICATION_REQUIRED','Complete the verification in the attached Edge, then resume this request_id. Do not submit the prompt again.',409);
    if(s.state==='login_or_ui_required')return new BridgeError('LOGIN_REQUIRED','Complete login in the attached Edge.',401);
    if(s.state==='error')return new BridgeError(s.code,s.message,409);
    return null;
  };
  const monitor=async job=>{
    const deadline=Date.now()+timeoutMs;let last='',stableSince=Date.now();
    while(Date.now()<deadline){
      const state=await invoke(config('poll',{url:job.url||tabUrl||undefined}));
      if(state.url)job.url=state.url;
      const problem=errorFor(state);
      if(problem){job.state='blocked';job.error=problem;return;}
      const oldIds=new Set(job.before.records.map(r=>r.id));
      const fresh=state.records.filter(r=>r.id&&!oldIds.has(r.id));
      const newUser=state.lastUser && state.lastUser.id!==job.before.lastUser?.id && state.lastUser.text===job.prompt.trim();
      if(newUser)job.sent=true;
      // Both a new user message and a new assistant message must exist.
      const answer=fresh.at(-1);
      if(answer?.text!==last){last=answer?.text||'';stableSince=Date.now();}
      if(job.sent&&answer?.text&&answer.finished&&!state.generating&&Date.now()-stableSince>=stableMs){
        job.state='completed';job.answer=answer.text;job.completed_at=Date.now();job.error=null;return;
      }
      await delay(pollMs);
    }
    job.state='uncertain';
    job.error=new BridgeError('RESPONSE_TIMEOUT','Submission or response could not be confirmed. Resume the same request_id; the server will not send it again.',504);
  };
  const run=async job=>{
    active=job.id;job.state='running';job.error=null;
    try{
      if(!job.before){
        // Optional guard: only checked when COPILOT_EXPECTED_ACCOUNT is set. The bridge never signs in itself.
        if(expectedAccount){
          const account=await invoke(config('account',{expectedAccount}));
          const accountError=errorFor(account);
          if(accountError){job.state='blocked';job.error=accountError;return;}
          if(account.state!=='account_verified')throw new BridgeError('ACCOUNT_UNVERIFIED','Account verification did not complete.');
        }
        const result=await invoke(config('send',{prompt:job.prompt}));
        const problem=errorFor(result);
        if(problem){job.state='blocked';job.error=problem;return;}
        if(!result.before)throw new BridgeError('SEND_STATE_INVALID','Missing pre-send snapshot.');
        job.before=result.before;job.url=result.url;
      }
      await monitor(job);
    }catch(e){
      job.state='uncertain';job.error=e instanceof BridgeError?e:new BridgeError('BROWSER_ERROR',e.message);
      if(!job.before)poisoned=true;
    }finally{active=null;}
  };
  const view=job=>({request_id:job.id,state:job.state,sent:job.sent,url:job.url||null,
    ...(job.answer?{answer:job.answer}:{}),...(job.error?{error:{code:job.error.code,message:job.error.message}}:{})});
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const authorized=req=>{
    if(!key)return true;
    const a=Buffer.from(req.headers.authorization||'');const b=Buffer.from(`Bearer ${key}`);
    return a.length===b.length&&timingSafeEqual(a,b);
  };
  const body=async req=>{
    let size=0;const chunks=[];
    for await(const c of req){size+=c.length;if(size>1_000_000)throw new BridgeError('BODY_TOO_LARGE','Request exceeds 1 MB.',413);chunks.push(c);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BridgeError('INVALID_JSON','Invalid JSON body.',400);}
  };
  const server=http.createServer(async(req,res)=>{
    try{
      // Prevent cross-origin web pages from operating the local browser bridge.
      if(req.headers.origin)throw new BridgeError('BROWSER_ORIGIN_DENIED','Use an HTTP API client, not a cross-origin web page.',403);
      const allowedHost=/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host||'');
      if(!allowedHost)throw new BridgeError('HOST_DENIED','Use localhost or 127.0.0.1.',403);
      if(!authorized(req))throw new BridgeError('UNAUTHORIZED','Bearer token required.',401);
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,active_request_id:active,poisoned});
      if(req.method==='GET'&&path==='/status'){
        if(active)throw new BridgeError('BUSY','A request is active.',409);
        const state=await invoke(config('status'));
        return json(res,200,{state:state.state,url:state.url||null,code:state.code,message:state.message,
          draft_present:!!state.draft,generating:!!state.generating,answer_count:state.records?.length||0});
      }
      if(req.method==='GET'&&path.startsWith('/jobs/')){
        const job=jobs.get(decodeURIComponent(path.slice(6)));
        if(!job)throw new BridgeError('NOT_FOUND','Unknown request_id.',404);
        return json(res,200,view(job));
      }
      if(req.method!=='POST'||!['/chat','/jobs','/v1/chat/completions'].includes(path))throw new BridgeError('NOT_FOUND','Unknown endpoint.',404);
      const data=await body(req);
      if(data.stream===true)throw new BridgeError('STREAM_UNSUPPORTED','Only stream:false is supported.',400);
      let prompt=data.prompt;
      if(path==='/v1/chat/completions'){
        if(!Array.isArray(data.messages)||data.messages.length!==1||data.messages[0].role!=='user'||typeof data.messages[0].content!=='string'){
          throw new BridgeError('MESSAGES_UNSUPPORTED','This adapter uses the existing web conversation; send exactly one text user message. System roles, tools and history replay are not implemented.',400);
        }
        if(data.model&&data.model!=='copilot-web')throw new BridgeError('MODEL_UNSUPPORTED','Use model: copilot-web. The web UI selects the model.',400);
        prompt=data.messages[0].content;
      }
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>50000)throw new BridgeError('INVALID_PROMPT','prompt must contain 1 to 50000 characters.',400);
      prompt=prompt.replace(/\r\n/g,'\n').replace(/[\u200b-\u200d\ufeff]/g,'').trim();
      if(!prompt)throw new BridgeError('INVALID_PROMPT','prompt cannot contain only invisible characters.',400);
      const id=data.request_id||req.headers['idempotency-key']||randomUUID();
      if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(id))throw new BridgeError('INVALID_REQUEST_ID','Invalid request_id.',400);
      let job=jobs.get(id);
      if(job&&job.prompt!==prompt)throw new BridgeError('IDEMPOTENCY_CONFLICT','This request_id belongs to another prompt.',409);
      if(!job){
        if(poisoned)throw new BridgeError('SESSION_UNCERTAIN','A CLI failure left submission unknown. Inspect Edge and restart the server before sending anything else.',409);
        const unresolved=[...jobs.values()].find(j=>j.before&&j.state!=='completed');
        if(unresolved)throw new BridgeError('UNRESOLVED_REQUEST',`Resume existing request_id: ${unresolved.id}`,409);
        if(active)throw new BridgeError('BUSY','Another browser request is active.',409);
        if(jobs.size>=200){for(const [k,v]of jobs){if(v.state==='completed')jobs.delete(k);if(jobs.size<150)break;}}
        if(jobs.size>=200)throw new BridgeError('JOB_LIMIT','Too many unresolved jobs. Inspect and resolve them before sending new tasks.',503);
        job={id,prompt,state:'pending',sent:false};jobs.set(id,job);job.promise=run(job);
      }else if(['blocked','uncertain'].includes(job.state)&&data.resume===true){
        if(poisoned&&!job.before)throw new BridgeError('SESSION_UNCERTAIN','Inspect Edge and restart the server; do not resubmit blindly.',409);
        if(active)throw new BridgeError('BUSY','Another browser request is active.',409);
        job.promise=run(job);
      }
      if(path==='/jobs')return json(res,job.state==='completed'?200:202,view(job));
      await job.promise;
      if(job.state!=='completed')return json(res,job.error?.status||409,view(job));
      if(path==='/v1/chat/completions')return json(res,200,{id:`chatcmpl-${job.id}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:'copilot-web',request_id:job.id,choices:[{index:0,message:{role:'assistant',content:job.answer},finish_reason:'stop'}]});
      return json(res,200,view(job));
    }catch(e){json(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR',message:e.message}});}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  return {server,jobs};
}

async function main(){
  const cli=await createCli({cwd:ROOT});
  await cli.version();
  const state=await connect(cli);
  const port=Number(process.env.PORT||8787);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  const bridge=createBridge({invoke:cli.invoke,tabUrl:process.env.COPILOT_TAB_URL||'',timeoutMs:Number(process.env.COPILOT_TIMEOUT_MS||180000)});
  bridge.server.listen(port,'127.0.0.1',()=>{
    console.log(`Copilot Edge API: http://127.0.0.1:${port}`);
    console.log(`Session: ${process.env.COPILOT_SESSION||'msedge'}; browser state: ${state.state}`);
    if(state.state!=='ready')console.log('Open/finish login in the attached Edge, then GET /status.');
  });
  const shutdown=()=>bridge.server.close(async()=>{await cli.close();process.exit(0);});
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(`${e.code||'STARTUP_ERROR'}: ${e.message}`);process.exitCode=1;});

// Executed by Playwright CLI run-code. No imports, globals or private web APIs.
export default async function browserFlow(page, cfg) {
  const clean = s => String(s ?? '').replace(/\r\n/g,'\n').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  const matchesOrigin = p => {
    try { return new URL(p.url()).origin === cfg.origin; } catch { return false; }
  };
  let tab;
  const pages = page.context().pages().filter(matchesOrigin);
  if (cfg.url) tab = pages.find(p => p.url() === cfg.url);
  if (!tab && pages.length === 1) tab = pages[0];
  if (!tab && pages.length > 1) return {state:'error',code:'MULTIPLE_TABS',message:'Multiple Copilot tabs: close extras or set COPILOT_TAB_URL.'};
  if (!tab) return {state:'error',code:'TAB_NOT_FOUND',message:'Open the Copilot chat in the attached Edge. Do not open a new browser profile.'};
  const input = tab.locator('#m365-chat-editor-target-element');
  const stop = tab.getByRole('button', {name:/^(停止生成|停止回應|生成を停止|応答の生成を停止|Stop generating|Stop responding|Stop generation)$/i});
  const users = tab.locator('[role="article"][aria-labelledby^="user-message-"]');
  const assistants = tab.locator('[role="article"][aria-labelledby^="copilot-message-"]');
  if (cfg.op === 'account') {
    if (!(await input.isVisible().catch(()=>false))) return {state:'login_or_ui_required',url:tab.url()};
    const signOut=tab.locator('#me-control-sign-out-button');
    try {
      if (!(await signOut.isVisible().catch(()=>false))) {
        const account=tab.getByRole('button',{name:/,\s*.*(帐户|帳戶|账户|アカウント|account)/i});
        if(await account.count()!==1)return {state:'error',code:'ACCOUNT_UNVERIFIED',message:'Cannot identify the signed-in account menu.'};
        await account.click({timeout:5000});
      }
      await signOut.waitFor({state:'visible',timeout:10000});
      const label=await signOut.getAttribute('aria-label');
      const email=(label||'').match(/[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
      await input.click({timeout:5000});
      if(email?.toLowerCase()!==cfg.expectedAccount.toLowerCase())return {state:'error',code:'ACCOUNT_MISMATCH',message:'The attached Edge is not signed in with the configured expected account.'};
      return {state:'account_verified',account:email,url:tab.url()};
    } catch {
      await input.click({timeout:1000}).catch(()=>{});
      return {state:'error',code:'ACCOUNT_UNVERIFIED',message:'Could not verify the account. Inspect the account menu in Edge.'};
    }
  }
  const snapshot = async () => {
    // This is visible-page inspection only. No cookies, tokens or private APIs.
    const challenge = await tab.getByText(/^(需要验证|驗證您是人類|验证您是人类|Verify you are human|Verification required)$/i).all();
    let blocked = false;
    for (const item of challenge) if (await item.isVisible().catch(()=>false)) blocked = true;
    for (const frame of await tab.locator('iframe[src*="challenges.cloudflare.com"]').all()) {
      if (await frame.isVisible().catch(()=>false)) blocked = true;
    }
    if (blocked) return {state:'verification_required',url:tab.url()};
    if (!(await input.isVisible().catch(()=>false))) return {state:'login_or_ui_required',url:tab.url()};
    const userCount=await users.count();
    const lastUser = userCount ? await users.last().evaluate(el => {
      const heading = el.querySelector('h5,h6');
      return {id:heading?.id ?? null,text:el.querySelector('[data-testid="chatOutput"]')?.innerText ?? ''};
    }).catch(()=>null) : null;
    const records = await assistants.evaluateAll(els => els.map(el => {
      const content = [...el.querySelectorAll('[data-testid="markdown-reply"]')];
      const heading = el.querySelector('h6,h5');
      return {id:heading?.id ?? null,text:content.map(e=>e.innerText).join('\n\n').trim(),
        finished:!!el.querySelector('[data-testid="CopyButtonTestId"]')};
    }));
    return {state:'ready',url:tab.url(),draft:clean(await input.innerText()),
      users:userCount,lastUser:lastUser ? {...lastUser,text:clean(lastUser.text)} : null,
      records, generating:await stop.isVisible().catch(()=>false)};
  };
  if (cfg.op === 'status' || cfg.op === 'poll') return snapshot();
  if (cfg.op !== 'send') throw new Error('Unknown browser operation');
  const before = await snapshot();
  if (before.state !== 'ready') return before;
  if (before.generating) return {state:'error',code:'PAGE_BUSY',message:'Copilot is already generating a response.'};
  if (before.draft && before.draft !== clean(cfg.prompt)) {
    return {state:'error',code:'DRAFT_EXISTS',message:'The Copilot input contains another unsent draft. It was not overwritten.'};
  }
  if (!before.draft) await input.fill(cfg.prompt, {timeout:10000});
  const actual = clean(await input.innerText());
  if (actual !== clean(cfg.prompt)) return {state:'error',code:'INPUT_MISMATCH',message:'The editor did not accept the complete prompt.'};
  const buttons = await tab.getByRole('button', {name:/^(发送|發送|送信|Send|Send message)$/i}).all();
  const visible = [];
  for (const b of buttons) if (await b.isVisible()) visible.push(b);
  if (visible.length !== 1) return {state:'error',code:'SEND_BUTTON_NOT_UNIQUE',message:'Cannot identify one visible Send button.'};
  if (!(await visible[0].isEnabled())) return {state:'error',code:'SEND_DISABLED',message:'Send button is disabled.'};
  let clickError = null;
  // A click timeout does not mean a failed submission. Never click a second time.
  try { await visible[0].click({timeout:5000}); }
  catch (e) { clickError = e.message.split('\n')[0]; }
  return {state:'submitted_or_pending',before,clickError,url:tab.url()};
}

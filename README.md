# Copilot 网页 → Playwright CLI → 本地 HTTP API

使用你已经在 Edge 中登录好的企业 SSO 账号。本服务不登录、不切换任何账号。默认端口 `8787`，默认 Playwright CLI 会话 `msedge`。

## 1. 准备你本机已有的 Edge

使用你此前已经连接成功的 Edge，打开 `https://copilot.cloud.microsoft/chat`。只保留一个 Copilot 标签页，其他普通网页无需关闭。

Edge 必须已用企业 SSO 账号登录，并已开启远程调试（例如启动参数 `--remote-debugging-port=9222`）。本服务只使用这个已登录的浏览器，不会登录任何其他账号。登录和人机验证在 Edge 页面由你完成。若设置了可选的 `COPILOT_EXPECTED_ACCOUNT`，每个新任务前会核对账号菜单中的邮箱，不一致则返回 `ACCOUNT_MISMATCH`；不设置则不核对。

这份代码只附加到已有 Edge。没有 `launchPersistentContext`，不会创建 `.copilot-browser` 或切到 Chrome。

## 2. 启动 API

将整个文件夹解压到一个固定目录，在这个目录的 PowerShell 中运行：

```powershell
$env:COPILOT_CDP = "http://127.0.0.1:9222"   # 你的 Edge 远程调试地址
.\start.cmd
```

Playwright CLI 使用全局安装，项目目录不安装任何依赖，也不安装额外的浏览器。`start.cmd` 只在全局没有 Playwright 时安装一次（`npm install -g playwright@1.62.1`），之后不再安装。实际入口是全局的 `playwright\cli.js cli ...`，不把提示词交给 PowerShell/CMD。

启动器先尝试读取 `msedge` 会话；不存在时调用对应命令：

```powershell
playwright cli -s=msedge attach --cdp=msedge
```

看到 `Copilot Edge API: http://127.0.0.1:8787` 后保留窗口。如果出现找不到可附加 Edge 的错误，说明本机的 CLI 还未连接到 Edge；服务不会另开一个空白登录配置。需要恢复此前已成功的本机连接方式。现有 CLI 与新目录的 CLI 若不能共享命名会话，也需要在本目录重新 attach，但这仍然连接原 Edge，不重建登录。

## 3. 测试

另开一个 PowerShell，在同一目录运行：

```powershell
npm test
```

它通过 API 真实发送一个问题：今天东京天气怎么样。收到回答就打印回答；失败时打印 `FAIL` 和错误内容，并以非零状态退出。

## 4. 业务调用

Node.js / 浏览器以外的 HTTP 客户端：

```javascript
const response = await fetch('http://127.0.0.1:8787/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    request_id: 'my-task-001',
    prompt: '请用中文解释 RxJS switchMap，并给一个业务例子。'
  })
});
const result = await response.json();
if (!response.ok) throw new Error(JSON.stringify(result));
console.log(result.answer);
```

`request_id` 应由调用方保存并唯一标识任务；相同 ID、相同提示词在本进程内复用结果，不再次发送。相同 ID 对应不同问题会被拒绝。

### OpenAI 格式的有限适配

```javascript
const response = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'copilot-web',
    stream: false,
    messages: [{ role: 'user', content: '你好，请用中文回答。' }]
  })
});
const result = await response.json();
console.log(result.choices[0].message.content);
```

这是 HTTP 返回结构适配，底层仍是当前网页对话。当前只支持一条文本 user 消息、非流式返回；不支持 system/developer 消息、工具调用、多模态、模型切换或重放整个 messages 历史。服务会明确拒绝不支持的参数，而不是忽略。不能把它直接当成通用 OpenAI API 的完全替代品。

## 人机验证和超时后的恢复

若返回 `VERIFICATION_REQUIRED`，在**本机被附加的 Edge** 中完成验证，再用相同 `request_id`、相同 `prompt`，加上 `resume: true`：

```javascript
// 使用上次保留的 task 内容；不要分配新 request_id。
const response = await fetch('http://127.0.0.1:8787/chat', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({...task, resume:true})
});
```

如果第一次点击已经发生，恢复操作只观察原来的提交，不再点击发送。`RESPONSE_TIMEOUT` 同样采用此方式继续等待。未解决的请求会阻止另一个提示词发送，以免把回答配错任务。

若 CLI 在返回发送前快照以前断开，服务无法知道点击是否发生，会返回 `SESSION_UNCERTAIN` 并阻止新发送。这时先查看 Edge 的真实消息状态，再决定重启服务；不要自动重试。

请求记录保存在进程内。重启会清空幂等记录，所以重启前应确认所有已发送任务的结果。完成记录会在容量接近上限时淘汰，不能把旧 request_id 当永久幂等键。

## 异步任务接口

`POST /jobs` 接受与 `/chat` 相同的 body，立即返回 `request_id`；使用 `GET /jobs/<request_id>` 查询状态。验证码恢复也向 `POST /jobs` 提交相同内容及 `resume: true`。适合不希望维持几分钟 HTTP 连接的调用方。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | 本机 API 端口 |
| `COPILOT_SESSION` | `msedge` | Playwright CLI 会话名 |
| `COPILOT_CDP` | `msedge` | 已运行 Edge 的 channel，或远程调试地址，例如 `http://127.0.0.1:9222` |
| `COPILOT_EXPECTED_ACCOUNT` | 空（不核对） | 可选。设置后，每次新任务前核对已登录账号的邮箱 |
| `COPILOT_TAB_URL` | 空 | 有多个标签页时精确指定 URL；推荐只保留一个 Copilot 标签页，避免导航后 URL 改变 |
| `COPILOT_TIMEOUT_MS` | `180000` | 每次等待回答的上限 |
| `COPILOT_API_KEY` | 空 | 可选的本机 Bearer token；配置后所有接口均要求 Authorization |
| `COPILOT_CLI_JS` | 全局 Playwright 的 cli.js | 可选的既有 Playwright CLI JS 入口；此入口须支持 `cli` 子命令 |

服务仅监听 `127.0.0.1`，拒绝带 Origin 的跨站网页请求。相同时间仅运行一个网页任务；其他提示词返回 `BUSY`。发送期间请勿手动更改聊天、切换账号或发送别的问题。API 保留当前网页的历史上下文；开始独立任务前，在 Edge 新建聊天并确保输入框为空。

## 修改点

- 原脚本只寻找包含固定问题的未发送草稿；现在 API 接收任意问题并负责输入。
- 发送按钮依据实际可见标签匹配中/日/英，不固定为日语 `送信`。
- 输入框使用已验证的 `#m365-chat-editor-target-element`；不再从多个 textbox 中盲取最后一个。
- 点击报超时后不重复点击，改查新用户消息和新回答标识。
- 回答从 assistant article 中的 `data-testid="markdown-reply"` 提取；不再截取整个 main，也不再使用 `lastIndexOf(prompt)`。
- 必须看到新用户消息、新回答正文、该回答自己的复制控件、生成结束和短暂稳定，才返回 completed。
- 没有 20 字最小限制或 4000 字截断，短回答也可完成。
- 验证码只检测并报告，不尝试绕过。

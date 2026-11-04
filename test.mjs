// Real test: global CLI, then the attached Edge, then one question through the API.
import {once} from 'node:events';
import {connect,createBridge,createCli} from './server.mjs';

const cli = await createCli();
let bridge;
try {
  console.log(`1/3 playwright-cli ${await cli.version()}`);

  const state = await connect(cli);
  console.log(`2/3 Edge: ${state.state} ${state.url || ''}`);
  if (state.state !== 'ready') throw new Error(state.message || 'Copilot page is not ready.');

  bridge = createBridge({invoke: cli.invoke, key: '', tabUrl: process.env.COPILOT_TAB_URL || ''});
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  const response = await fetch(`http://127.0.0.1:${bridge.server.address().port}/chat`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json; charset=utf-8'},
    body: JSON.stringify({prompt: '今天东京天气怎么样？请用中文回答。'}),
  });
  const result = await response.json();
  if (!response.ok || !result.answer?.trim()) throw new Error(JSON.stringify(result));
  console.log(`3/3 Copilot:\n${result.answer}`);
} catch (e) {
  console.error(`FAIL: ${e.code ? `${e.code}: ` : ''}${e.message}`);
  process.exitCode = 1;
} finally {
  bridge?.server.close();
  await cli.close();
}

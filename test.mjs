// Sends one real question through the running API and prints the answer.
const base = process.env.COPILOT_BASE_URL || 'http://127.0.0.1:8787';
const headers = {'Content-Type': 'application/json; charset=utf-8'};
if (process.env.COPILOT_API_KEY) headers.Authorization = `Bearer ${process.env.COPILOT_API_KEY}`;

try {
  const response = await fetch(`${base}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({prompt: '今天东京天气怎么样？请用中文回答。'}),
    signal: AbortSignal.timeout(240000),
  });
  const result = await response.json();
  if (!response.ok || !result.answer?.trim()) throw new Error(JSON.stringify(result));
  console.log(result.answer);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
}

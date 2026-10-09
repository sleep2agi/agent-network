// Real exported client + real Hub HTTP. Only OS/Tauri IPC is adapted in-page.
// Bootstrap credentials arrive on stdin, never argv, artifact files or logs.
import assert from 'node:assert/strict';
import { serveExport, TEST_LOCALE } from '/client-plumbing/harness.mjs';
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const bootstrap = JSON.parse(Buffer.concat(chunks).toString());
const { hub, token, networkId, nodeId, daemonId, baseRevision, action = 'model' } = bootstrap;
assert.ok(['model', 'stop', 'start'].includes(action));
assert.equal(hub, 'http://127.0.0.1:9287');
assert.equal(process.env.CLIENT_SOURCE_COMMIT, process.env.EXPECTED_CLIENT_SOURCE_COMMIT);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const web = await serveExport('/client-web');
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium' });
const trace = []; const updates = []; let lifecycleResult;
try {
  const ctx = await browser.newContext({ locale: TEST_LOCALE, viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.exposeBinding('__realHubHttp', async (_, c) => {
    const u = new URL(c.url); assert.equal(u.origin, hub, 'HTTP stays inside owned Hub');
    const body = c.data ? Buffer.from(c.data) : undefined;
    const response = await fetch(u, { method: c.method || 'GET', headers: c.headers,
      body, signal: AbortSignal.timeout(7000), redirect: 'error' });
    const text = await response.text();
    trace.push({ path: u.pathname, status: response.status });
    if (u.pathname === '/mcp' && body) {
      const request = JSON.parse(body.toString());
      if (request.params?.name === 'update_node_config') {
        assert.deepEqual(request.params.arguments, {
          node_id: nodeId, base_revision: baseRevision,
          patch: { model: 'stub/stub-model-next' }, network_id: networkId,
        });
        const envelope = JSON.parse(text.split('\n').find(l => l.startsWith('data: '))?.slice(6) ?? text);
        const result = JSON.parse(envelope.result.content[0].text);
        assert.equal(result.ok, true); updates.push(request.params.arguments);
      }
      if (request.params?.name === `${action}_node`) {
        assert.deepEqual(request.params.arguments, action === 'stop'
          ? { child_node_id: nodeId, network_id: networkId }
          : { node_id: nodeId, daemon_node_id: daemonId, network_id: networkId });
        const envelope = JSON.parse(text.split('\n').find(l => l.startsWith('data: '))?.slice(6) ?? text);
        lifecycleResult = JSON.parse(envelope.result.content[0].text);
        assert.equal(lifecycleResult.ok, true); assert.ok(lifecycleResult.request_id);
        updates.push(request.params.arguments);
      }
    }
    return { status: response.status, statusText: response.statusText, url: response.url,
      headers: [...response.headers], data: [...new TextEncoder().encode(text)] };
  });
  await page.addInitScript(({ hub, token, networkId }) => {
    const profile = { serverUrl: hub, token, username: 't829', profileId: 'real829', displayName: 't829', networkId };
    let rid = 0; const reqs = new Map(), bodies = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: cb => { const id = ++rid; window[`_${id}`] = cb; return id; }, convertFileSrc: p => p,
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'load_active_desktop_profile': return JSON.stringify(profile);
          case 'save_desktop_profile': return args.sessionJson;
          case 'get_theme_preference': return 'light';
          case 'plugin:event|listen': return 0;
          case 'plugin:http|fetch': { const id = ++rid; reqs.set(id, args.clientConfig); return id; }
          case 'plugin:http|fetch_send': {
            const c = reqs.get(args.rid); reqs.delete(args.rid);
            const { data, ...r } = await window.__realHubHttp(c);
            const id = ++rid; bodies.set(id, data); return { ...r, rid: id };
          }
          case 'plugin:http|fetch_read_body': {
            const data = bodies.get(args.rid); bodies.delete(args.rid); return data ? [...data, 0] : [1];
          }
          case 'plugin:window|get_all_windows': return ['main'];
          case 'plugin:webview|get_all_webviews': return [{ windowLabel: 'main', label: 'main' }];
          default: return null;
        }
      },
    };
  }, bootstrap);
  await page.goto(`${web.url}?safeAreaSim=0,0,0,0`);
  try {
    await page.waitForFunction(() => !!window.__anetLayoutSweep);
    // Navigation only; directory, capability, mutation and readback are real.
    await page.evaluate(() => window.__anetLayoutSweep.setScreen({ name: 'nodeDetail', alias: 'oc829' }));
    if (action === 'model') {
    await page.getByRole('tab', { name: '模型与运行时', exact: true }).click();
    await page.getByPlaceholder(/模型 id\(provider\/model\)/).fill('stub/stub-model-next');
    await page.getByText('切换模型', { exact: true }).click();
    await page.getByText('已切换到 stub/stub-model-next', { exact: true }).waitFor({ timeout: 95000 });
    assert.equal(updates.length, 1, 'one user click, one config mutation');
    assert.ok(trace.some(t => t.path === '/api/nodes/' + nodeId + '/config' && t.status === 200));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/artifacts/model-client-success.png' });
    console.log(`PASS rendered model change via real Hub; client=${process.env.CLIENT_SOURCE_COMMIT}`);
    console.log('MODEL_CLIENT_RESULT ' + JSON.stringify({ ok: true }));
    } else {
      await page.getByRole('tab', { name: '危险操作', exact: true }).click();
      await page.getByText(action === 'stop' ? '停止节点' : '启动节点', { exact: true }).click();
      await page.getByText('确认', { exact: true }).click();
      await page.getByTestId('node-danger-action-message').filter({ hasText: action === 'stop' ? '停止请求已提交' : '节点已上线。' }).waitFor({ timeout: 65000 });
      assert.equal(updates.length, 1);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/artifacts/client-${action}-success.png` });
      console.log('LIFECYCLE_CLIENT_RESULT ' + JSON.stringify({ ok: true, request_id: lifecycleResult.request_id }));
    }
  } catch (error) {
    await page.screenshot({ path: '/artifacts/model-client-failure.png' });
    console.error('HTTP path/status only:', JSON.stringify(trace));
    throw error;
  }
} finally { await browser.close(); await web.close(); }

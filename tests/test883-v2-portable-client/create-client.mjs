// Real exported client + real Hub HTTP. Only OS/Tauri IPC is adapted in-page.
// Bootstrap credentials arrive on stdin, never argv, artifact files or logs.
import assert from 'node:assert/strict';
import { serveExport, TEST_LOCALE } from '/client-plumbing/harness.mjs';
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const bootstrap = JSON.parse(Buffer.concat(chunks).toString());
const { hub, token, networkId, daemonId } = bootstrap;
assert.equal(hub, 'http://127.0.0.1:9287');
assert.equal(process.env.CLIENT_SOURCE_COMMIT, process.env.EXPECTED_CLIENT_SOURCE_COMMIT);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const web = await serveExport('/client-web');
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium' });
const trace = []; let created;
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
      if (request.params?.name === 'create_node') {
        const spec = request.params.arguments.node_spec;
        assert.deepEqual(spec.flags, { opencodeGeneration: 'v2', opencodeUnsafeTools: true });
        assert.equal(spec.name, 'oc829'); assert.equal(spec.model, 'stub/stub-model');
        assert.equal(request.params.arguments.daemon_node_id, daemonId);
        const envelope = JSON.parse(text.split('\n').find(l => l.startsWith('data: '))?.slice(6) ?? text);
        created = JSON.parse(envelope.result.content[0].text);
        assert.equal(created.ok, true); assert.ok(created.request_id);
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
    // Navigation shortcut only: daemon list and every Hub response stay real.
    await page.evaluate(() => window.__anetLayoutSweep.setScreen({ name: 'picker' }));
    await page.getByTestId(`daemon-card-${daemonId}`).waitFor({ timeout: 15000 });
    await page.getByText('下一步', { exact: true }).click();
    await page.getByTestId('create-name-input').waitFor({ timeout: 15000 });
    await page.getByTestId('create-name-input').fill('oc829');
    await page.getByTestId('create-node-next').click();
    await page.getByTestId('runtime-row-opencode-cli').click();
    await page.getByTestId('opencode-generation-v2').click();
    assert.equal(await page.getByTestId('create-node-next').isDisabled(), true);
    await page.getByTestId('opencode-v2-consent').click();
    await page.getByTestId('create-node-next').click();
    await page.getByTestId('opencode-v2-model').fill('stub/stub-model');
    await page.getByTestId('create-node-next').click();
    await page.getByTestId('opencode-v2-confirm-warning').waitFor();
    await page.getByTestId('create-node-submit').click();
    await page.getByText('✓ oc829 已上线', { exact: true }).waitFor({ timeout: 65000 });
    assert.ok(created?.request_id);
    assert.ok(trace.some(t => t.path === '/api/node-create-requests' && t.status === 200));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/artifacts/client-success.png' });
    console.log(`PASS rendered client real Hub create/confirmation; client=${process.env.CLIENT_SOURCE_COMMIT}`);
    console.log(`CLIENT_RESULT ${JSON.stringify({ ok: true, request_id: created.request_id })}`);
  } catch (error) {
    await page.screenshot({ path: '/artifacts/client-failure.png' });
    console.error('HTTP path/status only:', JSON.stringify(trace));
    throw error;
  }
} finally { await browser.close(); await web.close(); }

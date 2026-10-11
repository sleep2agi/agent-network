// Internal daemon primitive: never serialize this handle or its private path to a Hub reply.
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexStdioClient } from './codex-stdio-client';
import { CodexManagedLogin } from './codex-managed-login';

/** Keep host networking/tool lookup, but never inherit an account, API key,
 * NODE_OPTIONS, or another CODEX_HOME. Codex owns tokens in the private draft.
 */
export function codexLoginEnvironment(home: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE',
    'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
}

/** root must be an existing private directory resolved from the registered daemon,
 * not an arbitrary client-supplied path. No existing auth cache is read or copied.
 * Caller must discard an abandoned draft; retaining a successful draft does not
 * bind it to any node. The caller exposes only login.view(), never this handle.
 */
export async function createCodexLoginDraft(root: string, binary = 'codex') {
  const canonical = resolve(root);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(canonical) !== canonical
    || (process.getuid && stat.uid !== process.getuid())
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('unsafe_login_root');
  }
  const home = mkdtempSync(join(canonical, 'login-'));
  const rpc = new CodexStdioClient();
  const login = new CodexManagedLogin(rpc);
  let discarded = false;
  const discard = async () => {
    if (discarded) return;
    await login.close();
    // Exact mkdtemp-owned target, never the parent daemon directory.
    rmSync(home, { recursive: true, force: true });
    discarded = true;
  };
  try {
    writeFileSync(join(home, 'config.toml'),
      'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\nmodel_provider = "openai"\n',
      { mode: 0o600, flag: 'wx' });
    rpc.start({ binary, cwd: home, replaceEnv: true, env: codexLoginEnvironment(home, process.env) });
    await rpc.request('initialize', {
      clientInfo: { name: 'anet_managed_login', title: 'ANet managed ChatGPT sign-in', version: '0.1' },
    }, 10_000);
    rpc.notify('initialized', {});
    const account = await rpc.request<{ account: unknown }>('account/read', { refreshToken: false }, 10_000);
    if (!account || account.account !== null) throw new Error('draft_not_empty');
    // No login starts implicitly: the daemon handler must call login.start()
    // only for the user's explicit sign-in request.
    return { home, login, discard };
  } catch {
    await discard();
    throw new Error('login_process_start_failed');
  }
}

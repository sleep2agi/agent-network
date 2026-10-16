import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";

// #1337 —— 真实 CLI 停止「失败副作用」隔离见证（**纯测试夹具，无产品钩子**）。
//
// 修订要点（按通信牛 2026-10-16 的清单）：
//   1) **同进程 `spawnSync` 会阻塞代理事件循环** ⇒ 需要访问代理的 CLI 必须**异步 spawn**，
//      否则同步等待时本进程的 `createServer` 无法应答（300ms 最小复现：sync ETIMEDOUT／async ok）。
//   2) **配置**：`notifyServerOffline` 读的是 `profile.hub || gc.hub` ⇒ 只改**该次停止子进程实际会
//      读到的那份**（node 的 `profile.hub`）；原始字节**存内存**，`finally` 还原，并打印**命中证明**。
//   3) **精确观测离线请求**：解析 `POST /mcp` 请求体，只计
//      `method=tools/call` + `params.name=report_status` + `params.arguments.status=offline`
//      （可按 alias/resume_id 过滤）；不把 `initialize` 或任意 HTTP 请求计入。
//   4) **超时/信号不得冒充 B/C 的预期非零**：`rc==null` 或 `signal!=null` ⇒ 显式失败。
//   5) C 必须**真正进入新的 unverifiable 分支**（断言其诊断），不得以旧 ownership 预检失败冒充。
//   6) 每个场景 `finally` 清理本夹具拥有且**出生身份匹配**的进程并还原配置。

/** 🔴 校验一次 `report_status` 的 MCP 响应：只认本次报告(id=2)，解析 content[].text 内层 JSON，
 *  要求 ok===true 且 alias/resume_id 与期望目标**完全一致**；缺失/非法/不匹配/ok:false 一律拒绝。 */
export function verifyReportStatusResponse(raw, expected) {
  const frames = String(raw ?? "").split(/\r?\n/).filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  const candidates = (frames.length ? frames : [String(raw ?? "")]).filter((x) => x && x.trim().startsWith("{"));
  let handled = null;
  for (const c of candidates) {
    let j = null;
    try { j = JSON.parse(c); } catch { continue; }
    if (j.jsonrpc !== "2.0" || j.id !== 2) continue;                 // 只认本次 report_status 的响应
    if (Object.prototype.hasOwnProperty.call(j, "error")) throw new Error(`MCP error reply: ${JSON.stringify(j.error)}`);
    if (j.result && j.result.isError === true) throw new Error(`MCP tool reported isError: ${JSON.stringify(j.result)}`);
    if (j.result) { handled = j.result; break; }
  }
  if (!handled) throw new Error("no report_status(id=2) MCP result in upstream body");
  let inner = null;
  for (const c of (Array.isArray(handled.content) ? handled.content : [])) {
    if (typeof c?.text !== "string") continue;
    try { const j = JSON.parse(c.text); if (j && typeof j === "object") { inner = j; break; } } catch {}
  }
  if (!inner) throw new Error("MCP result carried no parsable inner JSON");
  if (inner.ok !== true) throw new Error(`Hub report_status not ok:true (${JSON.stringify(inner).slice(0, 200)})`);
  if (inner.alias !== expected.alias) throw new Error(`alias mismatch (got ${inner.alias}, expected ${expected.alias})`);
  if (inner.resume_id !== expected.resumeId) throw new Error(`resume_id mismatch (got ${inner.resume_id}, expected ${expected.resumeId})`);
  return inner;
}

export async function runStopEffectsScenarios({ cli, env, project, root, userHome, join, terminal }) {
  const shimDir = process.env.ANET_TEST1337_SHIM_DIR;
  const bun = process.env.ANET_TEST751_BUN;
  const realHubPort = 19351;
  const proxyPort = 19352;
  const proxyHub = `http://127.0.0.1:${proxyPort}`;
  const node = "windows-picker";
  const record = join(project, ".anet", "nodes", node, "windows-copresence.json");
  const nodeConfig = join(project, ".anet", "nodes", node, "config.json");
  const nodeDir = join(project, ".anet", "nodes", node);
  const globalConfig = join(userHome, ".anet", "config.json");
  const psLog = join(root, "test1337-ps.log");
  const tkLog = join(root, "test1337-tk.log");

  /** 全部请求（诊断）+ **精确离线通知**计数。 */
  const requests = [];
  const offlineNotifications = [];
  // 🔴 目标绑定：按 notifyServerOffline 的算法算期望 alias / resume_id，只有**本 fixture 的目标节点**
  //    的 offline 通知才算数（与 main cli.ts 的 nodeDisplayName / `sdk-${node_id}` 一致）。
  const expected = { alias: null, resumeId: null };
  const computeExpectedTarget = () => {
    const cfg = JSON.parse(readFileSync(nodeConfig, "utf8"));
    const display = cfg.alias ?? cfg.node_name ?? node;
    expected.alias = display;
    expected.resumeId = cfg.node_id ? `sdk-${cfg.node_id}` : `sdk-${display}-0`;
    console.log(`PHASE test1337: expected offline target alias=${expected.alias} resumeId=${expected.resumeId}`);
  };

  const proxy = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, body };
      requests.push(entry);
      let matchedOffline = null;
      if (req.method === "POST" && req.url === "/mcp") {
        try {
          const parsed = JSON.parse(body);
          const args = parsed?.params?.arguments ?? {};
          if (parsed?.method === "tools/call" && parsed?.params?.name === "report_status" && args.status === "offline") {
            matchedOffline = { alias: args.alias ?? null, resumeId: args.resume_id ?? null };
            // 只统计**目标节点**（精确 alias + resume_id）；任意节点/其它 alias 不算
            if (args.alias === expected.alias && args.resume_id === expected.resumeId) {
              offlineNotifications.push({ ...matchedOffline, upstreamStatus: null });
            }
          }
        } catch { /* 非 JSON 体不计入 */ }
      }
      const up = httpRequest({ host: "127.0.0.1", port: realHubPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${realHubPort}` } }, (r) => {
        const rec = matchedOffline
          ? offlineNotifications.find((n) => n.alias === matchedOffline.alias && n.resumeId === matchedOffline.resumeId)
          : null;
        if (rec) {
          rec.upstreamStatus = r.statusCode ?? null;               // 上游实际响应状态
          let body = "";                                            // 上游**响应体**（有界）——用于解析 MCP 结果
          r.on("data", (c) => { if (body.length < 4096) body += c; });
          r.on("end", () => { rec.upstreamBody = body.slice(0, 4096); });
        }
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
      up.end(body);
    });
  });
  await new Promise((r) => proxy.listen(proxyPort, "127.0.0.1", r));

  const probeTicks = (pid) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString()`], { encoding: "utf8" }).stdout.trim();

  /** 🔴 异步跑 CLI：绝不在需要代理应答时用 spawnSync（会阻塞本进程事件循环 ⇒ 代理死锁）。 */
  function runCli(args, runEnv, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn(bun, [cli, ...args], { cwd: project, env: runEnv });
      let out = "";
      let timedOut = false;
      let spawnError = null;
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("error", (e) => { spawnError = e; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      // 🔴 用 close（stdio 已收齐）而不是 exit，避免诊断被截断
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ rc: code, signal, out, timedOut, spawnError: spawnError ? String(spawnError) : null });
      });
    });
  }

  /** 只改**该次停止会读到**的 `profile.hub`；原始字节存内存，`finally` 还原。 */
  const hubPatch = { path: nodeConfig, original: null };
  const patchProfileHub = () => {
    hubPatch.original = readFileSync(nodeConfig);          // 原始字节
    const cfg = JSON.parse(hubPatch.original.toString());
    // 🔴 `Profile.hub` 是**顶层**键（`loadProfile()` 把 node config 读成 Profile，顶层 hub 即 profile.hub）；
    //    上一版误写成嵌套 profile.hub ⇒ 代理收到 0 个请求（A 实测 saw []）。
    cfg.hub = proxyHub;
    if (cfg.profile && typeof cfg.profile === "object") cfg.profile.hub = proxyHub;
    writeFileSync(nodeConfig, JSON.stringify(cfg, null, 2));
    console.log(`PHASE test1337: patched node-config hub -> ${proxyHub} (keys=${Object.keys(cfg).join(",")})`);
  };
  const restoreProfileHub = () => {
    if (hubPatch.original !== null) { writeFileSync(nodeConfig, hubPatch.original); hubPatch.original = null; }
  };

  /** 夹具级清理：上一次**失败**的 stop 会留下 `state:"stopping"`／`stopInvokedAt` 的生命周期标记，
   *  守卫会以 NODE_START_CANCELLED_BY_CONCURRENT_STOP 取消下一次 start（实测 C 场景即此）。
   *  这里只清**本夹具自己**在 RUNNER_TEMP 隔离项目里产生的状态。 */
  const clearFixtureLifecycleState = (label) => {
    const owner = join(nodeDir, ".lifecycle-owner.json");
    const lock = join(nodeDir, ".lifecycle-lock");
    if (existsSync(owner) || existsSync(lock)) {
      console.log(`PHASE test1337 ${label}: clearing fixture lifecycle state (owner=${existsSync(owner)} lock=${existsSync(lock)})`);
    }
    rmSync(owner, { force: true });
    rmSync(lock, { recursive: true, force: true });
  };

  async function startNode(label) {
    clearFixtureLifecycleState(label);
    rmSync(record, { force: true });
    const out = await terminal(["node", "start", node, "--no-inherit-codex-home"], undefined, 120_000);
    if (!existsSync(record)) throw new Error(`test1337 ${label}: ${node} did not start\n${out}`);
    const bytes = readFileSync(record);
    return { bytes, identities: JSON.parse(bytes.toString()).processes };
  }

  const cleanup = (identities) => {
    for (const p of identities || []) {
      try { if (probeTicks(p.pid) === p.creationDate) spawnSync("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"], { encoding: "utf8" }); } catch {}
    }
    clearFixtureLifecycleState("cleanup");
    rmSync(record, { force: true });
  };

  /** 跑一次「夹具化的真实 stop」；超时/信号 ⇒ 抛错（不得被当作预期非零）。 */
  async function shimmedStop(label, tkMode, psMode) {
    writeFileSync(psLog, "");
    writeFileSync(tkLog, "");
    requests.length = 0;
    offlineNotifications.length = 0;
    const stopEnv = {
      ...env,
      PATH: `${shimDir};${env.PATH}`,
      ANET_TEST1337_PS_MODE: psMode,
      ANET_TEST1337_TK_MODE: tkMode,
      ANET_TEST1337_PS_LOG: psLog,
      ANET_TEST1337_TK_LOG: tkLog,
      ANET_TEST1337_REAL_POWERSHELL: process.env.ANET_TEST1337_REAL_POWERSHELL,
      ANET_TEST1337_REAL_TASKKILL: process.env.ANET_TEST1337_REAL_TASKKILL,
    };
    patchProfileHub();
    computeExpectedTarget();
    try {
      const res = await runCli(["node", "stop", node], stopEnv, 120_000);
      if (res.spawnError) throw new Error(`test1337 ${label}: CLI failed to spawn: ${res.spawnError}`);
      if (res.rc === null) throw new Error(`test1337 ${label}: CLI returned null rc (spawn/signal issue) — 不得当作预期非零\n${res.out}`);
      if (res.timedOut || res.signal) {
        throw new Error(`test1337 ${label}: CLI did not exit within budget (timedOut=${res.timedOut} signal=${res.signal}) — 不得当作预期非零\n${res.out}`);
      }
      return { rc: res.rc, out: res.out, offline: [...offlineNotifications], requests: requests.map((r) => `${r.method} ${r.url}`) };
    } finally {
      restoreProfileHub();
    }
  }

  const callLog = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

  try {
    // 🔴 **反例拒绝自检**（通信牛要求"使错误样本被拒绝"）：直接向代理投递两条 `tools/call report_status
    //    offline` —— ① 非目标节点 ② 目标节点；要求 ① **不入账**、② 入账。这样"无关节点 offline 凑数"
    //    这条错误样本会被当场拒绝，而不是等到 A 场景跑偏才发现。
    {
      const postMcp = (payload) => new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const r = httpRequest({ host: "127.0.0.1", port: proxyPort, path: "/mcp", method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
          (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        r.on("error", () => resolve(null));
        r.end(body);
      });
      computeExpectedTarget();
      offlineNotifications.length = 0;
      await postMcp({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "report_status", arguments: { resume_id: "sdk-someone-else", alias: "other-node", status: "offline" } } });
      if (offlineNotifications.length !== 0) throw new Error(`test1337 self-check: unrelated-node offline was counted (${offlineNotifications.length})`);
      await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "report_status", arguments: { resume_id: expected.resumeId, alias: expected.alias, status: "offline" } } });
      if (offlineNotifications.length !== 1) throw new Error("test1337 self-check: target-node offline was NOT counted");
      console.log(`PASS test1337 self-check: unrelated-node offline rejected; target-node counted (upstream=${offlineNotifications[0].upstreamStatus})`);

      // 🔴 同一条 parser 的**最小对照**：ok:false 与**错目标**必须被拒绝，正形必须被接受。
      const mk = (body) => JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } });
      const expectReject = (label, raw) => {
        try { verifyReportStatusResponse(raw, expected); } catch { console.log(`PASS test1337 self-check: ${label} rejected`); return; }
        throw new Error(`test1337 self-check: ${label} was accepted (must be rejected)`);
      };
      expectReject("ok:false (alias_identity_mismatch)", mk({ ok: false, error: "alias_identity_mismatch" }));
      expectReject("wrong-target (different alias/resume_id)", mk({ ok: true, alias: "someone-else", resume_id: "sdk-someone-else" }));
      const good = verifyReportStatusResponse(mk({ ok: true, alias: expected.alias, resume_id: expected.resumeId }), expected);
      if (good.ok !== true) throw new Error("test1337 self-check: positive control not accepted");
      console.log("PASS test1337 self-check: ok:false and wrong-target rejected; positive shape accepted");
      offlineNotifications.length = 0;
    }

    // A —— 真实终止完成、包装器返回非零、精确身份均已退出 ⇒ rc0 / 记录删除 / **观测到 offline 通知**
    console.log("PHASE test1337 A: 非零但已完成终止");
    {
      const s = await startNode("A");
      try {
        const r = await shimmedStop("A", "delegate-nonzero", "delegate");
        if (r.rc !== 0) throw new Error(`test1337 A: expected rc0, got ${r.rc}\n${r.out}`);
        if (existsSync(record)) throw new Error("test1337 A: record should be deleted after a settled stop");
        if (callLog(tkLog).trim() === "") throw new Error("test1337 A: taskkill wrapper never hit (no call log)");
        if (r.offline.length === 0) {
          throw new Error(`test1337 A: no report_status(offline) for the target node through the proxy; saw ${JSON.stringify(r.requests.slice(0, 8))}`);
        }
        // 🔴 A 的验收：上游必须 **200 ≤ status < 300**，并**解析 MCP 响应**确认精确 alias/resume_id 的
        //    `report_status` 处理成功（不只看状态码）。修前的 406 属历史事实：由 #1344/PR2800 修好
        //    `notifyServerOffline` 两次 POST 的 Accept 后，main `facabc628532` 起上游回 2xx。
        const status = r.offline[0].upstreamStatus;
        if (typeof status !== "number" || status < 200 || status >= 300) {
          throw new Error(`test1337 A: upstream did not accept the notification (status=${status})`);
        }
        // 🔴 解析 MCP 响应并**严格校验**（id=2；content[].text 内层 JSON 的 ok/alias/resume_id）。
        const inner = verifyReportStatusResponse(r.offline[0].upstreamBody ?? "", expected);
        console.log(`       (A inner: Hub ok:true, alias=${inner.alias}, resume_id=${inner.resume_id} — matches expected target)`);
        console.log(`       (A: upstream responded ${status} to the target-bound offline notification)`);
        console.log(`       (A evidence: target-bound offline alias=${r.offline[0]?.alias} resumeId=${r.offline[0]?.resumeId}; upstream=${r.offline[0].upstreamStatus} (2xx); MCP result parsed=yes; unrelated-node notifications excluded by self-check)`);
        console.log(`PASS test1337 A: rc0, record removed, offline notifications=${r.offline.length} (alias=${r.offline[0]?.alias}, upstream=${r.offline[0].upstreamStatus})`);
      } finally { cleanup(s.identities); }
    }

    // B —— 包装器非零且**不终止**匹配身份 ⇒ rc非0 / 记录字节保留 / **offline 计数 0** / 真实身份仍活
    console.log("PHASE test1337 B: 非零且未终止");
    {
      const s = await startNode("B");
      try {
        const r = await shimmedStop("B", "nonzero-noop", "delegate");
        if (r.rc === 0) throw new Error(`test1337 B: expected non-zero rc, got 0\n${r.out}`);
        if (!existsSync(record)) throw new Error("test1337 B: record must be retained");
        if (!readFileSync(record).equals(s.bytes)) throw new Error("test1337 B: record bytes changed");
        if (r.offline.length !== 0) throw new Error(`test1337 B: report_status(offline) must be 0, saw ${JSON.stringify(r.offline)}`);
        // 🔴 必须确实是**本场景**：命中 nonzero-noop 包装器 **且** CLI 报 surviving 残留；
        //    否则旧 ownership 拒绝等更早错误也能满足 rc!=0 + 记录不变 + 身份仍活。
        const tk = callLog(tkLog);
        if (!tk.includes("nonzero-noop")) throw new Error(`test1337 B: did not hit the nonzero-noop taskkill wrapper\n${tk}`);
        // 🔴 绑定到**该场景的受管 PID**：否则别的进程/别的调用也能让"字符串存在"成立。
        for (const p of s.identities) {
          const bound = tk.split("\n").some((line) => line.includes("nonzero-noop") && line.includes(String(p.pid)));
          if (!bound) throw new Error(`test1337 B: nonzero-noop call log not bound to managed pid=${p.pid}\n${tk}`);
        }
        if (!r.out.includes("STOP_TIMEOUT: Windows managed processes survived")) {
          throw new Error(`test1337 B: did not report surviving managed processes\n${r.out}`);
        }
        const alive = s.identities.filter((p) => { try { return probeTicks(p.pid) === p.creationDate; } catch { return false; } });
        if (alive.length === 0) throw new Error("test1337 B: expected the real managed identities to still be alive");
        console.log(`       (B evidence: nonzero-noop tk hits bound to pids ${s.identities.map((p) => p.pid).join(",")}; cli diagnostic contains 'Windows managed processes survived'; offline target count=0)`);
        console.log(`PASS test1337 B: rc=${r.rc}, record retained, offline=0, alive=${alive.length}`);
      } finally { cleanup(s.identities); }
    }

    // C —— 仅**新身份协议查询**被挡（旧 ownership 预检走真实查询）⇒ 真正进入 unverifiable / rc非0 / 记录保留 / offline 0
    console.log("PHASE test1337 C: 仅新身份协议查询被挡");
    {
      const s = await startNode("C");
      try {
        const r = await shimmedStop("C", "delegate", "illegal-identity");
        if (r.rc === 0) throw new Error(`test1337 C: expected non-zero rc, got 0\n${r.out}`);
        if (!existsSync(record)) throw new Error("test1337 C: record must be retained");
        if (!readFileSync(record).equals(s.bytes)) throw new Error("test1337 C: record bytes changed (存在但内容已改 ≠ 保留)");
        if (r.offline.length !== 0) throw new Error(`test1337 C: report_status(offline) must be 0, saw ${JSON.stringify(r.offline)}`);
        const log = callLog(psLog);
        if (log.trim() === "") throw new Error("test1337 C: powershell wrapper never hit (no call log)");
        if (!/illegal-identity\t.*GetProcessById/.test(log)) throw new Error("test1337 C: ownership pre-check did not go through the wrapper (must be a real query)");
        if (!/illegal-identity\t.*CIMSTATE:/.test(log)) throw new Error("test1337 C: new identity protocol query was not exercised");
        // 🔴 必须**真正**走到新的 unverifiable 分支，而不是更早的 ownership 预检失败/无关异常冒充。
        if (!r.out.includes("could not prove Windows managed identity exited")) {
          throw new Error(`test1337 C: did not reach the new unverifiable branch\n${r.out}`);
        }
        if (r.out.includes("STOP_TIMEOUT: Windows ownership could not be proven")) {
          throw new Error(`test1337 C: an earlier ownership pre-check failure masqueraded as this scenario\n${r.out}`);
        }
        console.log(`       (C evidence: reached 'could not prove Windows managed identity exited'; record bytes equal; target offline count=0)`);
        console.log(`PASS test1337 C: rc=${r.rc}, record retained, offline=0, reached unverifiable`);
      } finally { cleanup(s.identities); }
    }

    console.log("PASS test1337 real-CLI stop side-effect fixture (A/B/C)");
  } finally {
    restoreProfileHub();
    await new Promise((r) => proxy.close(r));
  }
}

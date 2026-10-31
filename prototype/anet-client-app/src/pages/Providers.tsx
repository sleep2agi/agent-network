import { useEffect, useState } from "react";
import {
  applyNodeProvider,
  getNodeProviderSelection,
  getProviderCatalog,
  NodeProviderSelectionResp,
  ProviderCatalogResp,
} from "../api";
import { useAuth } from "../auth";

// Provider / 模型页（#3145 + #3146 的界面层）。
//
// 2026-10-31 —— 这一页存在的理由：**「上次操作成功」与「现在生效」不是同一件事**。
// 服务端给了两个读口（目录 + 节点当前选择），所以界面不该只显示「我刚点了什么」。
//
// 三个「没有」必须分开显示（服务端已经给了 state/counts/hint，界面只负责不把它们混成一句「没有」）：
//   unconfigured   ⇒ 请管理员录入第一行
//   all_disabled   ⇒ 请管理员启用（不是录入）
//   configured 但 0 模型 ⇒ 请管理员补模型
// 节点选择的四态同理：never_switched / pending / applied / failed。

function catalogBanner(c: ProviderCatalogResp | null): { kind: string; text: string; action: string } {
  if (!c) return { kind: "loading", text: "读取 provider 目录…", action: "" };
  const models = c.counts?.models_enabled ?? c.providers.reduce((n, p) => n + (p.models?.length ?? 0), 0);
  if (c.state === "all_disabled") {
    // 2026-10-31 —— 这一态服务端此前**从不产出**（union 里的死成员）：
    // 建了一行 enabled:false 的 provider，载荷仍是 configured ⇒ 读的人把「全都关了」看成「配置好了」。
    return {
      kind: "error",
      text: `已配置 ${c.counts?.providers ?? "?"} 个 provider，但全部被禁用 —— 这不是「还没配置」`,
      action: "请管理员启用其中一个，或在确认无用后删除",
    };
  }
  if (c.state !== "configured") {
    return { kind: "warn", text: "还没有配置 provider", action: "请管理员录入第一个 provider（含密钥与模型）" };
  }
  if (models === 0) {
    return { kind: "warn", text: "provider 已启用，但没有可选模型", action: "请管理员为 provider 补上模型" };
  }
  return { kind: "ok", text: `可用模型 ${models} 个`, action: "" };
}

function selectionLine(s: NodeProviderSelectionResp | null): { kind: string; text: string } {
  if (!s) return { kind: "loading", text: "读取节点当前选择…" };
  switch (s.state) {
    case "never_switched":
      return { kind: "muted", text: "从未切换过 —— 当前显示的是节点本地默认配置（不是 Hub 的读数）" };
    case "pending":
      return { kind: "warn", text: "正在切换（pending 不等于生效；生效要等回读 state=applied）" };
    case "failed":
      return { kind: "error", text: `切换失败：${s.error ?? "原因未回报"}` };
    case "applied": {
      const sel = s.selection as { provider_id?: string; model?: string } | null;
      return { kind: "ok", text: `已生效：${sel?.provider_id ?? "?"} / ${sel?.model ?? "?"}（revision ${s.revision ?? "?"}）` };
    }
    case "unknown":
      // 不猜：它既不是「已生效」也不是「失败」。界面必须这么说，否则用户会当成切好了。
      return {
        kind: "warn",
        text: `Hub 读到不认识的切换状态（${s.observed_status ?? "未回报"}）—— 这不等于已生效，去 daemon 侧看这次请求的实际结果`,
      };
    default:
      return { kind: "muted", text: `未知状态：${String(s.state)}` };
  }
}

export function Providers() {
  const utok = useAuth((s) => s.utok);
  // networkId 来自 auth store（不是 user 对象：AnetUser 上没有 network_id 字段）
  const networkId = useAuth((s) => s.networkId) ?? "";
  const [catalog, setCatalog] = useState<ProviderCatalogResp | null>(null);
  const [catalogErr, setCatalogErr] = useState<string>("");
  const [nodeId, setNodeId] = useState("");
  const [sel, setSel] = useState<NodeProviderSelectionResp | null>(null);
  const [selErr, setSelErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // 2026-10-31 —— **切换面**（这张卡真正要的东西：像 OpenCode 那样选 Provider 与模型）
  const [pickProvider, setPickProvider] = useState<string>("");
  const [pickModel, setPickModel] = useState<string>("");
  const [applyMsg, setApplyMsg] = useState<string>("");
  const [applyErr, setApplyErr] = useState<string>("");

  useEffect(() => {
    if (!utok || !networkId) return;
    let alive = true;
    getProviderCatalog(utok, networkId)
      .then((c) => alive && setCatalog(c))
      .catch((e) => alive && setCatalogErr(String(e)));
    return () => { alive = false; };
  }, [utok, networkId]);

  const loadSelection = async (id: string) => {
    if (!utok || !id) return;
    try {
      setSelErr("");
      setSel(await getNodeProviderSelection(utok, id));
    } catch (e) {
      setSel(null);
      setSelErr(String(e));
    }
  };

  const enabledProviders = (catalog?.providers ?? []).filter((p) => p.enabled);
  const picked = enabledProviders.find((p) => p.id === pickProvider);
  const models = (picked?.models ?? []).filter((m): m is string => typeof m === "string");

  const apply = async () => {
    if (!utok || !nodeId || !pickProvider || !pickModel) return;
    setBusy(true); setApplyErr(""); setApplyMsg("");
    try {
      // revision 传「当前回读到的 revision」；没读过就先读一次，避免盲目传 0
      let revision = sel?.revision ?? null;
      if (revision === null) {
        const fresh = await getNodeProviderSelection(utok, nodeId);
        setSel(fresh);
        revision = fresh.revision ?? 0;
      }
      const r = await applyNodeProvider(utok, nodeId, {
        revision,
        selection: { provider_id: pickProvider, model: pickModel },
      });
      setApplyMsg(`已排队（request_id ${r.request_id}）—— pending **不等于生效**，正在回读…`);
      // 回读：只有 GET 读到 applied 才算切好（服务端 202 的 hint 也是这么说的）
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const now = await getNodeProviderSelection(utok, nodeId);
        setSel(now);
        if (now.state === "applied" || now.state === "failed" || now.state === "unknown") {
          setApplyMsg(now.state === "applied"
            ? `已生效：${pickProvider} / ${pickModel}`
            : `状态 ${now.state}${now.state === "unknown" ? `（daemon 回报 ${now.observed_status ?? "?"}）` : ""} —— 去看 daemon 侧结果`);
          break;
        }
      }
    } catch (e) {
      setApplyErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const banner = catalogBanner(catalog);
  const line = selectionLine(sel);

  return (
    <div className="page">
      <h2>模型与运行时</h2>

      <section>
        <h3>目录</h3>
        {catalogErr ? <p className="error">{catalogErr}</p> : null}
        <p className={banner.kind}>{banner.text}</p>
        {banner.action ? <p className="muted">{banner.action}</p> : null}
        {/* 服务端的原话要原样带出来：它是唯一知道「为什么空」的那一方 */}
        {catalog?.hint ? <p className="muted">{catalog.hint}</p> : null}
        <ul>
          {(catalog?.providers ?? []).map((p) => (
            <li key={p.id}>
              <strong>{p.label}</strong>（{p.id}）— {p.models?.length ?? 0} 个模型
              {p.models_state === "none_configured" ? " · 没有配置模型" : ""}
              {p.models_state === "all_disabled" ? " · 全部停用" : ""}
              {!p.enabled ? " · 已停用" : ""}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>节点当前使用</h3>
        <input
          placeholder="节点 id（n_…）"
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value.trim())}
        />
        <button className="secondary" disabled={!nodeId || busy} onClick={() => loadSelection(nodeId)}>
          读取
        </button>
        {selErr ? <p className="error">{selErr}</p> : null}
        <p className={line.kind}>{line.text}</p>
        {sel?.hint ? <p className="muted">{sel.hint}</p> : null}
        {sel?.state === "pending" ? (
          <button className="secondary" disabled={busy} onClick={() => loadSelection(nodeId)}>
            重新读一次（确认是否已生效）
          </button>
        ) : null}
      </section>

      <section>
        <h3>切换 Provider / 模型</h3>
        {/* 没有可选项时不要给一个空下拉：那会读成「随便选也行」 */}
        {enabledProviders.length === 0 ? (
          <p className="muted">没有已启用的 provider ⇒ 无从切换。先让管理员在上面的目录里录入并启用一个。</p>
        ) : (
          <>
            <select value={pickProvider} onChange={(e) => { setPickProvider(e.target.value); setPickModel(""); }}>
              <option value="">选 provider…</option>
              {enabledProviders.map((p) => (
                <option key={p.id} value={p.id}>{p.label}（{p.id}）</option>
              ))}
            </select>
            <select value={pickModel} disabled={!pickProvider} onChange={(e) => setPickModel(e.target.value)}>
              <option value="">{pickProvider ? "选模型…" : "先选 provider"}</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button
              className="primary"
              disabled={busy || !nodeId || !pickProvider || !pickModel}
              onClick={apply}
            >
              切换到该模型
            </button>
            <p className="muted">
              提交后会回读 state=applied 才算生效；pending 只是排队（服务端 202 的语义）。
            </p>
          </>
        )}
        {applyErr ? <p className="error">{applyErr}</p> : null}
        {applyMsg ? <p className="muted">{applyMsg}</p> : null}
      </section>
    </div>
  );
}

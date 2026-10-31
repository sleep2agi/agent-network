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
    return { kind: "warn", text: "provider 都被停用了", action: "请管理员启用至少一个 provider" };
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
    </div>
  );
}

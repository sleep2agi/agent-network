// host_supervisor 的「源目录 / 新建节点 / 复用已有 Session」能力上报（纯函数，便于测试）。
//
// 背景（#4495）：这几条能力原来只在 **四个环境变量全为 1** 时才算出来，而生产上 7 台 daemon
// 一个都没设这些变量 ⇒ 客户端「新建节点时可选择已有项目 / Session」永远是灰的，
// 看起来像功能没做，其实是**没上报**。
//
// 现在的规则：
//   · 只对 role=host_supervisor + linux + 安全 Hub URL 计算（与原来一致，别的节点完全不受影响）；
//   · 每条能力**仍然要求对应的 transport 已在 config 里配好** —— 这是真正的意图表达，
//     而不是靠启动环境变量（systemd 起的 daemon 根本不好改 env）；
//   · 环境变量 `=0` 显式关闭（应急开关），不设或 `=1` 用配置决定。
import {
  PROJECT_CREATE_CAPABILITY,
  SESSION_ATTACH_CAPABILITY,
} from "../../contracts/session-project-create";
import { SOURCE_DELIVERY_CAPABILITY } from "../../contracts/session-source-delivery";
import { SOURCE_DIRECTORY_CAPABILITY } from "../../contracts/session-source-directory";
import { SOURCE_FORK_CAPABILITY } from "../../contracts/session-source-transport";

export type SourceCapabilityConfig = {
  sourceDirectoryTransport?: string | null;
  sourceForkTransport?: string | null;
  projectNewSessionTransport?: string | null;
  sessionAttachTransport?: string | null;
};

export type SourceCapabilityInput = {
  role?: string | null;
  platform: string;
  env: Record<string, string | undefined>;
  config: SourceCapabilityConfig;
  /** Hub URL 是不是 https（或 loopback 的 http）。不安全的 Hub 一条都不报。 */
  secureHub: boolean;
  /** daemon 现在能不能真的建节点（fork 的前提）。 */
  createOk: boolean;
};

export type SourceCapabilities = {
  source_directory_read?: string;
  project_new_session?: string;
  session_attach?: string;
  source_node_delivery?: string;
  source_fork_transport?: string;
};

/**
 * 单条 lane 的开关语义：`0` = 显式关闭；未设 / 其它值 = 交给 config 决定。
 *
 * 🔴 能力上报（sourceCapabilities）与实际拉起 worker（cli.ts 的
 * `createSessionSourceTransportWorker`）**必须用同一个判断**，否则会出现
 * 「报了能力但 lane 没起」——能力是真的但用不了，比不报更糟。
 */
export const laneEnabled = (env: Record<string, string | undefined>, key: string): boolean => env[key] !== "0";

export function sourceCapabilities(input: SourceCapabilityInput): SourceCapabilities {
  const { role, platform, env, config, secureHub, createOk } = input;
  // 非 host_supervisor / 非 linux / 不安全 Hub —— 一条都不报，快照里完全不出现这些字段。
  if (role !== "host_supervisor" || platform !== "linux" || !secureHub) return {};
  const out: SourceCapabilities = {};
  if (laneEnabled(env, "ANET_SOURCE_DIRECTORY_PREVIEW") && config.sourceDirectoryTransport === SOURCE_DIRECTORY_CAPABILITY) {
    out.source_directory_read = SOURCE_DIRECTORY_CAPABILITY;
    if (laneEnabled(env, "ANET_PROJECT_NEW_SESSION_PREVIEW") && config.projectNewSessionTransport === PROJECT_CREATE_CAPABILITY) {
      out.project_new_session = PROJECT_CREATE_CAPABILITY;
    }
    if (laneEnabled(env, "ANET_SESSION_ATTACH_PREVIEW") && config.sessionAttachTransport === SESSION_ATTACH_CAPABILITY) {
      out.session_attach = SESSION_ATTACH_CAPABILITY;
    }
  }
  if (laneEnabled(env, "ANET_SOURCE_FORK_PREVIEW") && config.sourceForkTransport === SOURCE_FORK_CAPABILITY && createOk) {
    out.source_node_delivery = SOURCE_DELIVERY_CAPABILITY;
    out.source_fork_transport = SOURCE_FORK_CAPABILITY;
  }
  return out;
}

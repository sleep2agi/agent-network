// `agent-node/src/cli.ts` 里的 Linux 兜底原先用 `__dirname + "/../"` 当
// `npm install --prefix`。源码里那是对的(`src/..` = 包根),**但打包器把
// `__dirname` 内联成了构建期常量**:
//
//   var __dirname = "/home/<builder>/.../agent-node/src";
//
// 于是已发布的 `dist/cli.js` 在**每一台用户机上**都拿构建机的目录去装包 ——
// 那个目录不存在,`/home/<别人>` 下普通用户也建不出来。这条兜底恒失效,
// 而且**不出声**:它只在「本机没有 claude 且是 Linux」时才走到,平时没人看得见。
// (#1433 实测:latest 2.5.0-preview.34 和 preview .57 的产物里都内联着。)
//
// `import.meta.url` 在打包后**仍然运行时求值**(产物里出现 5 次,package.json
// 是 type:module),所以拿它推包根两边都对:
//   源码 src/cli.ts   → src/..  = 包根
//   产物 dist/cli.js  → dist/.. = 包根
//
// 🔴 保留 `argv[1]` 兜底是有先例的:`agent-network/bin/anet.cjs` 专门把
// `process.argv[1]` 指回真入口,因为 cli 有多处靠它推自身位置。

/**
 * 从模块自身的 URL 推出包根(结尾带分隔符,可直接当 `npm --prefix`)。
 * `moduleUrl` 传 `import.meta.url`;拿不到时退到 `argv1` 所在目录的上一级。
 */
export function packageRootFrom(moduleUrl: string | undefined, argv1?: string): string | null {
  const fromUrl = dirOf(moduleUrl);
  if (fromUrl) return up(fromUrl);
  if (argv1 && argv1.trim()) {
    const d = argv1.replace(/\/+$/, "");
    const cut = d.lastIndexOf("/");
    if (cut > 0) return up(d.slice(0, cut));
  }
  return null;
}

function dirOf(moduleUrl: string | undefined): string | null {
  if (typeof moduleUrl !== "string" || !moduleUrl.startsWith("file://")) return null;
  const path = decodeURIComponent(moduleUrl.slice("file://".length));
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : null;
}

/** 上一级目录,结尾保留 `/`(npm --prefix 对两种写法都接受,统一成带斜杠便于比对)。 */
function up(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut > 0 ? trimmed.slice(0, cut) + "/" : "/";
}

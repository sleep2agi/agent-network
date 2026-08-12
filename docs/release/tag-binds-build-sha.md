# release tag 必须绑定构建 commit

这道门防的是一类**只在灾难恢复时才暴露**的缺陷 —— 平时一切正常,
只有真去重建的时候才发现拿错了源码。对应 `AGENTS.md` §19。

## 事故(2026-08-12,tmwork 线实际发生)

```
tag  desktop-v1.20.8-alpha.12   剥出 04a66b20   ← 当时 main 的 head
实际构建 commit                  6a3db442       ← 差 26 个 commit
```

根因:**`gh release create <tag>` 在 tag 不存在时,默认在 `target_commitish`
(默认 `main`)上建 tag**,而不是在你打包用的那个 commit 上。

🔴 **它不会报错。** release 页面完全正常,安装包也是对的。
于是 `git clone --branch <tag>` 拿到的**不是构建那份代码** ——
而"凭 tag 能重建"正是所有人默认相信的假设。

## 判据

1. `gh release create <tag> --target <打包用的完整构建 SHA>` —— **`--target` 不可省**
2. create **之后回读**并逐字符比对,不符即 exit≠0:
   ```bash
   scripts/verify-release-tag.sh <owner/repo> <tag> <构建 SHA>
   ```
3. 🔴 **witnessed-red 必做**:故意省掉 `--target`、或指向错的 tag,
   观测到 exit≠0。**没有这一条,它就只是一份 checklist,不是门。**

## 两条容易写错的地方

- 🔴 **回读必须用远端**(`git ls-remote`),不要用本地 `git rev-parse <tag>`。
  本地 tag 可能就是你自己刚建的那个 —— 那样验的是自己写的东西。
- 🔴 **不要只断言"退出码非零"就完事**,还要断言**失败时该做的事没做**
  (没继续上传 asset、没写 feed)。

  同源反例:`if ! cmd; then rc=$?` —— `!` 取反后 `$?` 是取反的结果 `0`,
  于是"校验失败却退出 0",调用方以为成功。抓住它的是**配对断言**:
  「该拦的拦住了」是绿的,但「拦住时对外报的是失败」是红的。
  **验闸要同时验这两面。**

## 归属

判据来自 tmwork 线的实际事故复盘,在此推广到 anet 的四个 npm 包发布流程。

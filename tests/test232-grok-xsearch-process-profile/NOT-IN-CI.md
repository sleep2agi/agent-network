# 为什么 test232-grok-xsearch-process-profile 不进 CI

<!-- 🔴 下面两行是**机器读的**。散文里写撤销条件没有用 —— 没有任何东西会重新
     评估一个存在于注释/正文里的条件（这句话是仓里 dashboardReleaseTag() 上方的原话）。
     check-test-suite-registration.py 缺这两行会判红，并把 Verified 的天数
     打进每次都会出现的汇总行。-->
Verified: 2026-08-19
Revisit-when: CI 上有了安全提供真 Grok 登录凭据的通道，或套件改成不依赖 /host-grok/auth.json 也能断言其被测行为。

**它需要宿主挂载 `/host-grok/auth.json` —— 而 CI runner 上没有，也不该有。**

## 实测（2026-08-19，`origin/main` = `55e86d1c`，本地 Docker）

    docker build --build-arg SOURCE_COMMIT=<sha> -f tests/test232-grok-xsearch-process-profile/Dockerfile <archive-ctx>   rc=0
    docker run --rm --network none -e ARTIFACT_DIR=/tmp/art <img>                          rc=1

    cp: cannot stat '/host-grok/auth.json': No such file or directory

构建是过的，红在**运行期缺一个宿主挂载**：真 Grok 的登录凭据 auth.json。

## 为什么不接

CI runner 上不存在这个文件。把它接成阻塞门 = 每次都红，而且红的原因和被测行为无关 ——
那是纯噪音，最后一定会被加豁免绕过去，等于白接。

也**不能**套 known-failure 棘轮：棘轮是给「产品/套件真的有已知缺陷」用的，
把一条环境缺口登记成「已知失败」会让它和真缺陷混在一张表里。

## 一个容易看错的地方

它最后打出来的是

    FAIL: real binary is not pinned Grok 0.2.93

只看这一行会去查「产品有没有把版本钉住」。**真相在上面那两行的
`No such file or directory` 里** —— 文件根本不存在，所以 sha256 是空的，
所以「不等于钉住的那个值」。报错点名了两样东西（缺什么 + 从哪找的），
别丢掉后半句。

## 本地怎么跑

    # 需要一份真 Grok 二进制/凭据，放在宿主某目录下
    docker run --rm -v /path/to/grok-dir:/host-grok:ro -e ARTIFACT_DIR=/tmp/art <img>

## 什么时候该重新考虑接进 CI

如果将来有一条**不带凭据**的方式拿到钉住版本的 Grok 二进制（例如公开发布的校验和 + 可公开下载的产物），
这份豁免就该撤掉。在那之前，它留在这里是**有理由的不进 CI**，不是**没人管的孤儿**。

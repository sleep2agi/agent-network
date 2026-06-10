| ⑦ --help 0 side-effects | PASS | no node files / no hub db / no hub proc / no live :9200 after 6× --help invocations |
| ④ -V alias | PASS | rc=0, output identical to -v |
| ② did-you-mean | PASS | both typo cases got suggestion (creat→create, hbu→hub) |
| ① hub status fixed | PASS | live state correct: running=yes, not-running=no, PID=yes, version=yes, port=yes |
| ⑤ no misleading warning | PASS | no 'agent-node not found' string, create success message present |
| ③ node restart | PASS | stopped old + started new + SSE connected (rc=124 from foreground timeout, log proves behavior) |
| ⑥ dashboard wait hint | PASS | hint phrase visible (compile/wait/first-time/etc.) |

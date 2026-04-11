# 测试方法与经验

## 测试架构

```
tests/
├── test1-newuser/          # 新手体验测试
│   ├── Dockerfile          # 独立 Docker 镜像
│   └── run.sh              # 测试脚本
├── test2-collab/           # 多用户协作测试
│   ├── Dockerfile
│   └── run.sh
├── test3-security/         # 安全边界测试
│   ├── Dockerfile
│   └── run.sh
├── run-parallel.sh         # 并行运行器
├── docker-e2e.sh           # 传统 Base E2E (137)
├── docker-e2e-auth.sh      # Auth E2E (25)
├── docker-e2e-networks.sh  # Networks E2E (22)
├── docker-config-priority.sh # Config E2E (16)
├── local-e2e.sh            # 本地快速 E2E (56)
├── test-all.sh             # 传统全量 runner
└── Dockerfile              # 传统全量镜像
```

## 并行测试方法

每个测试场景有独立 Dockerfile，可以同时构建和运行：

```bash
# 并行运行 3 个测试套件
bash tests/run-parallel.sh

# 或手动并行
docker build -t test1 -f tests/test1-newuser/Dockerfile . &
docker build -t test2 -f tests/test2-collab/Dockerfile . &
docker build -t test3 -f tests/test3-security/Dockerfile . &
wait

docker run --rm test1 &
docker run --rm test2 &
docker run --rm test3 &
wait
```

## 测试套件说明

### Test 1: 新手体验 (~25 tests)
模拟全新用户从零开始：
- Server 启动 + health check
- 注册（第一个用户 = admin）
- 登录 + 双 token (utok_/ntok_)
- 默认网络自动创建
- MCP 发任务 + 收任务
- REST API 查询
- 密码修改

### Test 2: 多用户协作 (~25 tests)
两个用户的交互场景：
- 注册两个用户（admin + regular）
- 网络隔离验证（互相不可见）
- 邀请码生成 + 加入
- 成员列表 + 角色
- 跨网络任务隔离
- 邀请码耗尽
- 成员移除 + 权限回收

### Test 3: 安全边界 (~25 tests)
攻击面和边界测试：
- Auth bypass（无 token / 假 token / 空 token）
- SQL 注入（username / login）
- 输入验证（超长 / 短密码 / 空body / malformed JSON / XSS）
- Token 安全（创建 / 撤销 / 已撤销 token 验证）
- 权限提升（跨网络 token 创建）
- License 篡改
- MCP 无认证访问

## 快速本地测试

不需要 Docker，覆盖核心路径：

```bash
bash tests/local-e2e.sh    # 56 tests, ~30s
```

## 测试原则

1. **原子性**：每个测试场景独立 Dockerfile，互不依赖
2. **并行**：3 个场景同时构建 + 运行，总时间 = 最慢那个
3. **Docker 隔离**：测试在 Docker 内运行，不影响本地环境
4. **pass/fail 明确**：每个断言有明确的 ✅/❌ 输出
5. **不碰生产**：测试用临时 DB，不连接生产 server

## 新增测试步骤

1. 在 `tests/` 下创建新文件夹（如 `test4-performance/`）
2. 写 `run.sh`（bash 脚本，用 pass()/fail() 函数）
3. 写 `Dockerfile`（基于 oven/bun:1，COPY server + run.sh）
4. 加到 `run-parallel.sh` 的并行列表
5. 提交 + Docker 验证

# Gravity Alpha G staking 快照

对 Gravity Alpha（chain ID **1625**）的 `0xb9aD636435EF1bcd10C7021D1767813D179cA3bf` 进行指定区块的 staking 快照。采集历史参与用户，以及区块执行结束时的质押、退出队列和地址类型；不采集全链原生 G holder 或 WG 持仓。

需要 **Node.js >=22.13**，推荐 Node.js 24 LTS；使用内置 `node:sqlite`，部分 Node 版本会显示实验性 API 提示。无需私钥。

## 使用

```bash
cd scripts/g_staking
npm ci

# 示例区块；正式快照时替换为业务确认的区块。
SNAPSHOT_BLOCK=130827456

# 只验证区块、历史读取能力、合约字节码和配置，不扫描用户。
npm run snapshot:staking -- --block "$SNAPSHOT_BLOCK" --preflight-only

# 从块 0 扫描至目标块，查询全部发现的用户。
npm run snapshot:staking -- --block "$SNAPSHOT_BLOCK"

# 相同命令再次执行，会复用已提交的日志区间和用户状态。
npm run snapshot:staking -- --block "$SNAPSHOT_BLOCK"
```

默认目录是本脚本下的 `output/gravity/<block>/`，不受调用时工作目录影响。`--out /path/to/run` 指定一个快照的完整运行目录；相对路径相对于当前工作目录。

RPC 按以下顺序读取：

1. 主 RPC：`--rpc` → `GRAVITY_ALPHA_RPCURL` → `GRAVITY_RPC_URL` → `https://rpc.gravity.xyz`。
2. 备用 RPC：`--fallback-rpc` → `GRAVITY_ALPHA_FAILOVERRPCURL` → `https://rpc.gravity.xyz`。

因此可以直接注入线上服务使用的 `GRAVITY_ALPHA_RPCURL` / `GRAVITY_ALPHA_FAILOVERRPCURL`。URL 不写入产物。节点必须提供完整历史 `eth_getLogs`、`eth_call`、`eth_getBalance`、`eth_getCode` 和 `eth_getStorageAt`。普通 archive RPC 即可，不需要全账户遍历、trace 或节点数据库权限。

参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--block` | 必填 | 区块结束时状态；不隐式使用 latest |
| `--chunk-size` | `1000000` | 日志最大区间，遇到结果上限自动缩小 |
| `--log-limit` | `10000` | 提供商日志截断阈值，按实际 RPC 限制配置 |
| `--batch-size` | `10` | 每批 RPC 方法数；`1` 禁用 JSON-RPC batch |
| `--delay-ms` | `200` | 每个 HTTP 请求前的延迟，包括校验和重试 |
| `--from-block` | `0` | 非零值一律标记 `partial` |
| `--limit-users` | `0`，全部 | 非零值一律标记 `partial`；用户按地址排序选取 |

默认限速指 HTTP 请求，批量中的每个方法仍可能单独计费。应按线上节点配额调整 `--batch-size` 和 `--delay-ms`。网络失败有限重试并尝试备用节点；RPC 方法错误不会转换为零余额或 EOA。切换备用节点前检查 chain ID 和目标块 hash。

小范围联调命令（预期退出码 **2**）：

```bash
npm run snapshot:staking -- --block 130827456 \
  --from-block 130000000 --limit-users 3 --out .context/live-smoke
```

`--limit-users` 只限制状态查询，不限制给定区间的日志扫描；`--from-block` 用于限制日志范围。正式运行保持两者默认值。无已验证的部署高度时，从 0 开始可以避免遗漏历史地址。

## 采集和金额口径

- 从 `TokenStaked`、`TokenUnStaked`、`TokenRevokeUnStaked`、`TokenWithdraw` 的 **`userAddress`** 发现用户，不使用交易 `from`。
- 在 B 查询 `getStakeAmount(user)` 和 `getUnStakeInfo(user)`。两者都已经除以 `multiplier(B)`，返回的是 G 最小单位，脚本不会再换算一次。
- 同时读取 `balances(user)` 和各项 `unStakeInfoMap(user,index)`，保存内部原始单位和整除余数，核对 view getter 的结果。
- 用 `B.timestamp >= unStakeTime + lockTimePeriod(B)` 判断队列中的批次是否成熟。读取 B 时配置，不硬编码 7 天。保存 `paused`；成熟不等于一定能够执行提款。
- 保留已全部撤资的历史用户。`has_position` 根据内部权益是否非零判断，避免小于 1 wei 的换算余数被静默丢弃。
- 所有金额使用 `BigInt` 计算，以十进制字符串保存和导出。`total_position_wei` 是各 view getter 金额之和；当 multiplier 不为 1 时，合并提款的取整可能不同，因此原始单位及批次明细仍是必要依据。

原生 G 托管对账使用精确的整数等式：

```text
differenceInternalUnits
  = eth_getBalance(stakingContract, B) × multiplier(B)
  − Σ [balances(user, B) + Σ unStakeInfoMap(user,index,B).amount]
```

这避免逐用户/批次向下取整导致“看起来对平”。正差额可能来自额外转入或遗漏用户等，负差额可能代表不足或数据问题；报告保留差额，绝不修改用户数值凑平。

这里是 staking 合约自身的权益／托管余额对账。全链 G 与 Ethereum canonical bridge 的总量对账由原生 G holder 快照处理。staking 合约的 G 已包含在全链原生余额中，不要把该合约余额和用户 staking 权益重复相加。

## 地址分类

复用并适配 [PR #6](https://github.com/Galxe/galaxy-airdrop/pull/6) 的 RPC / Safe 分类思路与代码，来源固定为 `efece3a83b48dc9d610ddc12b1ca063eb4ae13aa`，不依赖其未合并目录。

| 类型 | 含义 |
| --- | --- |
| `EOA` | B 时无代码，不证明私钥控制 |
| `EOA_DELEGATED` | EIP-7702 格式的委托代码，单独保留目标地址 |
| `SAFE` | 已识别的官方代理和实现字节码、存储、版本、owners/threshold 均匹配 |
| `CONTRACT` | 其他合约，包括未完成验证的 Safe-like 合约 |
| `SPECIAL` | 已列出的 EVM/Nitro 预编译或保留地址范围；不据此断言该地址在 B 已激活 |

只有代码哈希匹配已识别 Safe proxy 的地址才会调用 Safe 方法；其他合约直接保留为 `CONTRACT`，避免未知 selector 引发的执行错误中断全量采集。Safe 读取时的 RPC 传输或历史状态故障仍会报错，不会被忽略。

Safe 导出 owners、threshold、version 等，并保存原始读取证据。1/N Safe 不标记为需要多个签名。该识别不审计 Safe 模块、完整权限或跨链控制权。`stakers.contract.csv` 同时包含 `SAFE` 和 `CONTRACT`，另用 `address_type` 区分。

源地址保存在 `source_address`。脚本不推断 Ethereum recipient，不生成 Claim Center 的分配、Merkle tree 或发放交易。

## 存储、恢复与输出

每个区块使用独立的本地 SQLite 数据库；不需要数据库服务。

| 表 | 内容 |
| --- | --- |
| `meta` | 固定区块/hash、配置、ABI/代码摘要、预检与 Safe registry 证据、断点、汇总 |
| `log_ranges` | 连续成功覆盖区间及原始日志响应；单块超限时保存 receipts 证据 |
| `events` / `users` | 去重后的事件、历史用户及首次/最后出现区块 |
| `positions` | 质押／退出金额、分类、内部原始单位、原始状态读取响应 |
| `unstake_batches` | 逐笔退出批次、成熟时间及换算余数 |
| `errors` | 失败阶段与错误记录 |

日志和断点在同一事务提交；一组用户状态全部读取成功后再一起提交。中断后重跑会跳过已提交数据，未完成的一组会重新读取。使用 WAL、`synchronous=FULL`、单进程写锁，发现重复冲突事件会失败。不要让多个进程共享一个运行目录；不要在采集运行时只复制 `.sqlite` 而忽略 WAL。

快照身份包含区块 hash、合约、来源起点、用户样本限制、ABI 与实现摘要。更换这些参数或升级代码时使用新的运行目录；限速、batch/chunk 大小和相同链状态的 RPC 可以更换。

```text
output/gravity/<block>/
  snapshot.sqlite
  report.json
  manifest.json
  SHA256SUMS
  exports/
    stakers.csv              # 所有历史用户，含零权益用户
    stakers.active.csv       # 内部权益非零
    stakers.eoa.csv
    stakers.contract.csv    # SAFE + CONTRACT
    stakers.delegated.csv
    stakers.special.csv
    stakers.jsonl
    unstake-batches.csv
```

导出按地址稳定排序，流式生成，不把所有用户或 CSV 放进内存。CSV 金额用文本导入表格软件，避免浮点精度丢失。对可能被表格软件解释为公式的文本（例如合约返回的版本字符串），CSV 会添加单引号前缀；JSONL 和 SQLite 保留原始值。JSONL 保存逐用户完整结构。原始 RPC 证据保存在 SQLite 中，避免为 staking 的每次查询生成独立小文件。

全部采集和区块一致性检查结束后记录 `finishedAt`；再次执行只做预检和重新导出。确认 WAL checkpoint 成功并关闭数据库后才计算 SHA-256；若其他数据库连接阻止 checkpoint，本次运行失败，关闭这些连接后重跑即可恢复归档。`SHA256SUMS` 覆盖数据库、业务输出、报告和 manifest。失败时可能保留 `.tmp`、SQLite 和 `last-error.json`，它们用于恢复，不代表完成；先前错误记录在恢复成功后仍保留作为历史。

## 完成状态与边界

| `report.status` | 退出码 | 含义 |
| --- | --- | --- |
| `reconciled` | 0 | 请求全历史和全部用户，采集完成，内部权益与托管余额精确相等 |
| `partial` | 2 | 显式限制了历史区间或用户数量，即使金额恰好相等也不通过 |
| `custody_surplus` / `custody_deficit` | 2 | 采集结束但金额有差异，需查明原因；只作为待核对的数据 |
| 执行失败 | 1 | RPC、数据、代码、区块身份或完整性检查失败，未完成 |

`--preflight-only` 成功退出码也是 0，但不生成快照。CSV 和 JSONL 各行都带快照状态，部分扫描不会被标成正式名单。

完整性建立在 RPC 提供完整历史事件的前提上。扫描覆盖与托管余额相等不是 cryptographic completeness proof；报告明确记录此点。节点结果达到配置的截断阈值时缩小区间，单块仍超限则通过该块的全部交易 receipts 获取日志。若提供商在更低阈值静默截断，应相应设置 `--log-limit` 或更换有完整日志保证的服务。

每个日志区间和用户状态提交前后检查目标块 hash，完成时重读合约配置与余额；读取固定区块号，拒绝已发现的重组，不会切到 latest。请选择已稳定的历史区块。区块或已缓存配置不一致时终止，不混合数据。

合约 ABI 和 runtime code hash 固定在 `contract.json`，来自 explorer 已验证的 `GalxeStaking`。B 时 runtime 必须精确匹配，否则需要先审阅新合约。`test/fixtures/staking-runtime.hex` 是同一已验证 runtime，用于端到端模拟测试。

## 验证

```bash
npm test
```

测试覆盖换算与取整、解锁边界、已退出用户、四类事件、事务回滚／恢复、重复日志、RPC 乱序与单项失败、首次连接及后续切换的备用链错误、区块变化、传输超时缩小日志区间、单块日志超限 receipts 回退、Safe 真伪识别、普通合约跳过 Safe 探测、Safe 读取故障传播、大整数、CSV 公式保护、WAL checkpoint 受阻后恢复、可重复导出，以及包含已清仓合约用户的端到端中断恢复。端到端测试会在 `127.0.0.1` 启动模拟 RPC。

2026-10-27 在区块 `130827456` 做过链上样本测试：扫描 `130000000..130827456`，发现 2,037 个用户、2,756 个事件，仅查询 3 个用户，其中 2 个仍有权益；正确输出 `partial`（退出码 2）。这不是全量快照，也未完成全量托管对账。

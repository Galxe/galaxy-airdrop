# Gravity Alpha 原生 G holder 快照

在指定区块 B，采集 Gravity Alpha（chain ID **1625**）全部账户的原生 G 状态，重建账户 Merkle Patricia Trie 并核对 B 的 `stateRoot`，然后导出正余额 holder 及地址类型。

这是独立脚本，位于 `scripts/g_holder/`，不依赖尚未合并的其他 PR。复用了 [PR #6](https://github.com/Galxe/galaxy-airdrop/pull/6) 的 RPC/Safe 分类思路，以及 [PR #7](https://github.com/Galxe/galaxy-airdrop/pull/7) 的固定区块、SQLite 和导出模式。

**普通余额 RPC 不能枚举全部账户。** 正式运行需要以下任一来源：

- `rpc-state`：能访问 B 状态并允许 `debug_accountRange` 的节点。
- `state-file`：覆盖 B 的完整账户 JSONL 导出，包含零余额账户和账户叶子的全部字段。

脚本不会退回浏览器当前 holders 分页、交易发送方名单或部分地址列表，也不会把这些来源标成全量。归档节点数据库 tar 包不是账户 JSONL，需要先用兼容的节点/工具导出。

## 安装和运行

需要 **Node.js >=22.13**，推荐 Node.js 24 LTS。使用内置 `node:sqlite`；部分版本会显示实验性 API 提示。无需私钥。

```bash
cd scripts/g_holder
npm ci

# 示例区块；正式运行替换为确认的快照区块。
SNAPSHOT_BLOCK=130827456

# 模式一：节点账户遍历；环境中提供具有该能力的 endpoint。
export GRAVITY_SNAPSHOT_STATE_RPCURL='https://your-state-rpc'
npm run snapshot:holders -- --block "$SNAPSHOT_BLOCK" --mode rpc-state --preflight-only
npm run snapshot:holders -- --block "$SNAPSHOT_BLOCK" --mode rpc-state

# 模式二：完整状态文件。
npm run snapshot:holders -- --block "$SNAPSHOT_BLOCK" \
  --mode state-file --state-file /data/alpha-state.jsonl
```

线上读取 RPC 使用：`--rpc` → `GRAVITY_ALPHA_RPCURL` → `GRAVITY_RPC_URL` → `https://rpc.gravity.xyz`。备用读取 RPC 使用 `--fallback-rpc` → `GRAVITY_ALPHA_FAILOVERRPCURL` → `https://rpc.gravity.xyz`。

账户遍历节点使用 `--state-rpc` → `GRAVITY_SNAPSHOT_STATE_RPCURL` → 主读取 RPC。它与读取节点的 chain ID、B 的 hash/stateRoot 必须一致。RPC URL 不写入数据库、报告或 manifest。

默认输出在脚本自身的 `output/gravity/<block>/`，不受调用时工作目录影响。`--out /data/snapshot-run` 指定一个快照的完整目录；显式相对路径相对于当前工作目录。相同输入与命令重跑即可恢复。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--block` | 必填 | 区块执行结束时状态，不隐式使用 latest |
| `--mode` | `rpc-state` | `rpc-state` 或 `state-file` |
| `--page-size` | `256` | 每批导入账户数；Nitro RPC 模式最大 256 |
| `--batch-size` | `10` | 每个 JSON-RPC batch 的方法数；1 禁用 batch |
| `--delay-ms` | `200` | 每次 HTTP 请求前的延迟，按节点配额调整 |
| `--verify-batch-size` | `1000` | 状态树持久化检查点的账户数 |
| `--safe-info` | 关闭 | 进一步核查已识别 Safe 代理的 owners/threshold 等 |
| `--preflight-only` | 关闭 | 检查 Alpha 输入来源，不采集最终快照 |
| `--ethereum-block` | 未设置 | 固定 Ethereum 区块，启用 canonical bridge 托管余额对比 |
| `--ethereum-rpc` | `ETHEREUM_RPCURL` | Ethereum 读取 RPC；启用桥对账时必填 |
| `--bridge-adjustments` | 未设置 | 与两侧区块 hash 绑定的跨链调整明细文件 |

默认限速按 HTTP 请求计算，批量内部方法可能分别计费。没有 `--limit-holders` 或部分扫描后“强制成功”的选项。预检成功退出 0 仅说明输入能力通过，不代表快照完成。

## 完整状态输入

两种文件格式均为未压缩的 UTF-8 JSONL，允许 CRLF 和最后一行没有换行；不允许空行。不要把整份状态包装成一个巨大 JSON 数组。

标准格式首行是固定区块元数据，随后每行一个账户：

```jsonl
{"format":"gravity-native-state-v1","chainId":1625,"block":"<B>","blockHash":"0x<64 hex>","stateRoot":"0x<64 hex>"}
{"address":"0x<40 hex>","trieKey":"0x<64 hex>","nonce":"0","balanceWei":"1234567890000000000","storageRoot":"0x<64 hex>","codeHash":"0x<64 hex>"}
```

其中占位内容需替换为真实状态。金额和 nonce 建议使用十进制字符串；已知地址的 `trieKey` 可省略，由 `keccak256(address)` 得出。提供了 key 时必须匹配。缺失原像的账户使用 `address:null`，必须提供真实 `trieKey`。

也支持 Geth `IterativeDump` 格式：首行 `{"root":"0x..."}`，后续 `DumpAccount` 行使用 `balance / nonce / root / codeHash / key / address`。这类头部只有 root，脚本会将其与线上 B 的 root 比较，并通过重建树验证全部记录。Geth 的 JSON 数字 nonce 使用无损解析，超过 JavaScript 安全整数范围也不会被舍入。

所有输入都必须保留：

- **全部账户，包括零余额账户。** 只导出 holders 无法重建完整状态树。
- nonce、原生 balance、storage root、code hash；重建账户树不需要每个合约的完整 storage 内容。
- 缺少原像的账户叶子。零余额账户可以暂缺地址，仍参与 root 验证；正余额账户缺地址会阻止完成。

单行限 2 MiB；建议导出时省略 code/storage 内容，脚本会对正余额合约按 code hash 去重读取代码。文件采集前后校验 SHA-256，每次恢复也重新校验，不能在采集过程中改写输入文件。

RPC 适配器依据 Nitro 对应 Geth 的实现，调用：

```text
debug_accountRange({blockHash: B.hash, requireCanonical: true}, start, pageSize, true, true, true)
```

末尾三个参数分别为 `nocode / nostorage / incompletes`；`incompletes=true` 表示保留缺失地址原像的叶子。Geth 返回的 `next` 是 `[]byte` 的 Base64，脚本解码为下次请求需要的十六进制字节串，同时兼容明确的 32-byte hex cursor。游标循环、重复叶子、错误 root 或非法字段会报错；节点提前结束或静默漏页仍会在 root 重建时被发现。

依据：[dump.go](https://github.com/OffchainLabs/go-ethereum/blob/a983a4af77a05584a9929ff7c68db98921c22116/core/state/dump.go)、[AccountRange](https://github.com/OffchainLabs/go-ethereum/blob/a983a4af77a05584a9929ff7c68db98921c22116/eth/api_debug.go)。

## 校验与分类

账户先写入 SQLite，再按状态树键排序，用锁定版本的 `@ethereumjs/trie` 重建账户树。输入键已经是 Keccak 后的 key，**不再二次 hash**。nonce/balance 使用规范 RLP 整数编码，storage root/code hash 原样纳入叶子。

树节点保存在 SQLite，批次节点更新与 root/进度一起提交；中断后可恢复。不会把全状态账户或 trie 放入一个内存 Map。重建 root 必须等于 B 的 `stateRoot`，且正余额地址原像完整，才能继续分类并导出。

地址分类：

| 类型 | 判定 |
| --- | --- |
| `EOA` | 已验证账户叶子的 code hash 是空代码 hash |
| `CONTRACT` | 其他有代码的账户；Safe 深入核查未开启时也归在这里 |
| `EOA_DELEGATED` | 字节码符合 EIP-7702 委托格式，单列委托目标 |
| `SAFE` | 开启 `--safe-info` 后，官方代理/实现代码、存储、版本、owners/threshold 核查通过 |
| `SPECIAL` | 零地址及已列出的 EVM/Nitro 预编译或保留地址范围 |

先使用 code hash 处理普通无代码账户；有代码的账户按 hash 去重，每种代码只读取一次并校验其 Keccak。开启 Safe 核查后，另外逐个查询已识别代理的存储和权限信息。对固定选取的少量账户再用线上 `eth_getBalance` / `eth_getCode` 抽查。

EOA 分类不证明私钥控制；保留地址标签也不证明该预编译在 B 已激活。Safe 核查不审计模块或完整权限。所有源地址均保留为 `source_address`，不推断 Ethereum recipient。

## Ethereum canonical bridge 对账

读取 Ethereum 指定区块 E 的：

- G：`0x9c7beba8f6ef6643abd725e45a4e8387ef260649`。
- Alpha canonical bridge：`0x7983403dda368aa7d67145a9b81c5c517f364c42`。
- 验证 `bridge.nativeToken()`、G 的 18 位精度，读取 `G.balanceOf(bridge)`。

```bash
npm run snapshot:holders -- --block "$SNAPSHOT_BLOCK" --mode state-file \
  --state-file /data/alpha-state.jsonl \
  --ethereum-block "$ETHEREUM_SNAPSHOT_BLOCK" \
  --ethereum-rpc "$ETHEREUM_RPCURL" \
  --bridge-adjustments /data/bridge-adjustments.json
```

基本关系是：

```text
Ethereum 桥余额
  = Alpha 全账户原生 G 余额总和
  + Ethereum 已锁定而 Alpha 尚未入账的充值
  + Alpha 已销毁而 Ethereum 尚未释放的提现
  + 直接额外转入及有证据的协议调整
```

两个区块时间接近不等于跨链进度已对齐。**脚本读取桥余额，但不自动枚举、证明全部在途跨链消息。** 调整文件需由能够核对消息进度的一方准备，且在最终发放前完成核对；不会增加用户登记或补录入口。

```json
{
  "format": "gravity-bridge-adjustments-v1",
  "alpha": { "block": "<B>", "blockHash": "0x<Alpha block hash>" },
  "ethereum": { "block": "<E>", "blockHash": "0x<Ethereum block hash>" },
  "entries": [
    { "kind": "deposit_pending", "amountWei": "1000000000000000000", "evidence": "<receipt / message ID / audit record>" }
  ]
}
```

允许 `deposit_pending`、`withdrawal_pending`、`direct_surplus`、`protocol_adjustment`；前三类非负，最后一类允许有符号金额。每项必须有 evidence 引用，零调整也要明确提供空 entries，并自行确认其正确性。脚本校验区块身份和整数算术，**不会验证 evidence 指向的记录**，报告固定保存 `adjustmentsVerified:false`。

未提供调整文件时，桥结果是 `unadjusted_match` 或 `unadjusted_difference`，都不能当作已完成跨链对账。提供文件后结果是 `adjusted_match` / `adjusted_difference`，表示基于所提供明细的算术结果，不应扩大解释。

不采集 WG 的 ERC-20 持仓，但 WG 合约本身托管的原生 G 仍在全账户快照里。staking、桥、金库、销毁地址等原生余额也保留。空投资格筛选在快照之后进行；不能再把 staking 内部用户权益、WG token 数量加到本报告总量中。

## 存储与恢复

| 表 | 内容 |
| --- | --- |
| `meta` | 区块身份、输入摘要、游标/文件字节偏移、trie 检查点、报告与配置 |
| `chunks` | gzip 压缩的原始来源响应/JSONL 批次及 SHA-256 |
| `accounts` | 全部账户叶子，地址可空；金额/nonce 用 TEXT，hash/address/RLP 用 BLOB |
| `trie_nodes` | 重建中的持久化树节点 |
| `codes` | 去重的代码及其读取地址、分类依据 |
| `classifications` | 可选 Safe 核查结果和原始读取证据 |
| `errors` | 失败阶段与历史错误 |

原始响应、解析结果和来源检查点在同一 SQLite 事务提交；重复账户直接失败，不用 `INSERT OR IGNORE` 掩盖冲突。使用 WAL、`synchronous=FULL`、单进程目录锁。不同进程不能同时写同一运行目录。文件读取、账户树重建和业务导出均按批次/流式推进。

运行目录绑定区块、block hash、stateRoot、数据源文件 SHA-256、代码/依赖版本摘要、Safe 选项及桥输入配置。更换这些内容使用新目录；限速、batch/page 大小和提供相同状态的 RPC 可调整。

```text
output/gravity/<block>/
  snapshot.sqlite
  report.json
  manifest.json
  SHA256SUMS
  exports/
    holders.all.csv
    holders.eoa.csv
    holders.contract.csv       # CONTRACT + SAFE
    holders.delegated.csv
    holders.special.csv
    holders.jsonl
```

所有正余额账户都在 `holders.all.csv` 中，各分类文件构成无重叠划分。CSV 按地址稳定排序，金额用最小单位十进制字符串；另有 18 位格式化 G 列。JSONL 保存逐行结构，避免巨型 JSON 数组。导出到表格软件时将整数列作为文本读取。

完成后停止数据修改并重新导出；先 checkpoint/关闭 SQLite，再生成文件 SHA-256。运行中不要仅复制 `.sqlite` 主文件而遗漏 WAL。失败运行可留下工作库、错误记录或 `.tmp`，但 stateRoot 或正余额地址验证未通过时不会输出 holder CSV 或完成 manifest。

建议本地 SSD，并为全账户、原始压缩响应和 trie 节点预留磁盘空间。该实现避免全量内存缓存，但尚未对 Gravity 数千万账户进行生产容量验证；不要从小型测试外推完整耗时和磁盘需求。

## 状态、测试与当前限制

- `report.status = state_verified` / `holderSnapshotComplete = true`：完整账户树与区块 root 匹配，正余额地址与分类完成。以读取 RPC 提供的规范区块头为锚点，不独立验证整条链的共识。
- 退出码 0：上述校验通过，且没有请求桥对账，或所提供调整项使桥差额为零。
- 退出码 2：holder 状态已验证，但请求的桥对账缺调整明细或差额未平。
- 退出码 1：数据源、RPC、身份、原像、金额或 root 验证失败；不是完整快照。

```bash
npm test
```

测试覆盖 uint64/uint256 精度、独立编码的单叶 MPT 根、secure trie 对照、遗漏零余额账户、正余额原像缺失、重复页、Base64 cursor、事务中断与恢复、JSONL 字节偏移、代码 hash、RPC 切换时的链与区块身份、两种来源的完整 CLI、桥调整及归档校验和。端到端测试在 `127.0.0.1` 启动模拟 RPC。

另用 10,000 个合成账户（包含零余额）验证了磁盘 trie 重建与参考 root 一致。线上只做输入能力预检，**尚未运行真实链全量快照**。当前公开 RPC 的 `debug_accountRange` 返回 `authenticated API key required for method`，无法完成账户枚举；正式运行仍需可访问的完整状态 RPC 或 JSONL 来源。

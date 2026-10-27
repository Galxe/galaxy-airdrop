# Gravity atUSD / atETH 历史持仓快照

需要 Node.js 22+，无需私钥。固定链为 **Gravity Alpha，chain ID 1625**，避免误连另一条 Gravity 网络。

```bash
cd scripts/latch_holder
npm ci

# 方法一：用 Blockscout 当前 holders 名单发现候选地址
npm run snapshot:gravity -- --block 130827456 --mode holders

# 方法二：用原生 RPC 扫描 Transfer 日志发现候选地址
npm run snapshot:gravity -- --block 130827456 --mode transfers

# 两种方法都跑，并输出逐地址比较结果
npm run snapshot:gravity -- --block 130827456 --mode both
```

以下命令均在 `scripts/latch_holder/` 内执行。脚本、测试、依赖配置以及默认输出和缓存都位于该目录；默认输出和缓存路径不受调用时工作目录影响。显式传入的相对 `--out` / `--cache-dir` 则相对于当前工作目录。

默认同时处理：

| Token | 地址 |
|---|---|
| atUSD | `0xc4af68Dd5b96f0A544c4417407773fEFDc97F58d` |
| atETH | `0xc314b8637B05A294Ae9D9C29300d5f667c748baD` |

只处理一个 token 可加 `--token atUSD` 或 `--token atETH`。`--block` 必填，代表该块执行结束后的状态，不会自动改成最新块。

## 两种数据源

`holders` 调用浏览器真正的 API 域名：

```text
https://api.explorer.gravity.xyz/api/v2/tokens/{token}/holders
```

跟随 `next_page_params` 拉取全部分页并去重。**只用它发现地址，不采用接口给出的当前余额和 is_contract 来确定历史状态。** 当前名单可能遗漏在目标块后清仓的地址；浏览器索引可能落后，分页期间也可能发生变化。这个模式不会自动补扫 Transfer，以便独立比较两种来源。每次执行重新拉取当前名单，报告保存拉取的开始和结束时间。

`transfers` 从块 0 到目标块调用 `eth_getLogs`，过滤两个 token 的 `Transfer(address,address,uint256)`，收集发送方和接收方，排除零地址。不使用 Blockscout 数据。查询超出日志上限时自动缩小区间；每段完成后写入断点。

两种模式共用的流程：

1. 在目标块调用候选地址的 `balanceOf`，过滤零余额。
2. 在同一块调用 `eth_getCode`、Safe 方法和存储查询，分类。
3. 用大整数累加余额，与该块的 **`totalSupply()`（实际发行量）** 对账。`maxSupply` 是发行上限，ERC-20 也没有标准的 `maxSupply()` 方法，不适合作为持仓总和的对账基准。
4. 输出前重新检查区块哈希，若目标块发生重组则报错。

## 地址分类

| `type` | 含义 |
|---|---|
| `EOA` | 目标块无代码，操作上归入普通 EOA |
| `SAFE` | 代理和实现的 runtime code hash 已验证，slot 0 与 masterCopy 一致，owners / threshold / VERSION 有效 |
| `CONTRACT` | 其他有代码的地址；疑似 Safe 但未验证的记录 `safe_like_unverified` |
| `EOA_DELEGATED` | EIP-7702 委托代码，单独列出，避免误当普通合约 |

Safe 实现字节码哈希来自锁定版本的 `@safe-global/safe-deployments`。代理哈希来自验证过的官方工厂 `proxyRuntimeCode()`，另包含官方 Safe 1.4.1 编译产物的 runtime hash（该版本工厂没有这个方法）。自定义代理或未覆盖的新版本可能无法确认，保留为合约及验证依据。

Safe 导出版本、实现地址、owners、threshold 和 `requiresMultipleSigners`。1/N 或 1/1 的 Safe 仍归为 Safe，但不会标记为需要多个签名。Safe 可能启用绕过普通签名流程的模块，本脚本不审计模块或权限。

无代码不能证明有私钥控制：已销毁合约、尚未部署的地址或部分预编译也可能无代码。这里统计链上直接持有人，不穿透金库、池子和质押合约的底层用户。

## 输出与对账

默认输出到 `output/gravity/<block>/`：

- `atUSD-holders.json` / `.csv`、`atETH-holders.json` / `.csv`
- `atUSD-transfers.json` / `.csv`、`atETH-transfers.json` / `.csv`
- `comparison.json`：仅 `both` 模式生成，包含 `onlyHolders`、`onlyTransfers`、`differentBalances` 和双方汇总。

JSON 包含块高、区块哈希、数据来源、抓取时间、候选数量、分类汇总和明细。CSV 包含地址、原始整数余额、格式化余额、类型及 Safe 信息。所有余额字段都输出为字符串；用 Excel 导入原始余额时请选择文本格式。

`summary` 的主要字段：

- `holderBalanceRaw` / `holderBalance`：正余额持有人合计。
- `totalSupplyRaw` / `totalSupply`：该块总供应量。
- `differenceRaw` / `difference`：总供应量减去已找到的持仓合计；可能为负。
- `supplyMatched`：是否精确一致，不使用浮点容差。
- `byType`：各类地址数和持仓合计。

报告 `status`：`reconciled`、`supply_mismatch`、`partial`。只有未显式截断且对账相等时才标为 `reconciled`。这依赖 token 满足“非零地址余额之和等于 totalSupply”的语义；非标准铸币、零地址持仓、余额舍入或 rebase 等机制需要额外检查。RPC 返回错误会停止执行，不会把失败当作零余额或 EOA。

退出码：

| 退出码 | 含义 |
|---|---|
| 0 | 本次所有已请求模式对账通过，且 `both` 模式地址和余额一致 |
| 2 | 余额不一致、显式部分扫描，或两种模式结果不同；仍生成诊断文件 |
| 1 | 参数、网络、RPC、API 或数据校验错误；执行未完成 |

错误时可能保留此前生成的文件，请检查报告 `generatedAt`，不要把上一次的文件当作本次成功结果。不同参数写到同一目录会覆盖同名文件；样本测试请使用独立 `--out`。

## RPC、性能和缓存

RPC 必须支持目标块的历史 `eth_call`、`eth_getCode`、`eth_getStorageAt` 和完整历史日志。推荐使用有合适配额的 archive RPC：

```bash
export GRAVITY_RPC_URL='https://your-archive-rpc'
npm run snapshot:gravity -- --block 130827456 --mode both --batch-size 20 --delay-ms 200
```

也可用 `--rpc URL`。默认公共节点为 `https://rpc.gravity.xyz`。批量查询按响应 ID 对应结果，对限流请求重试；`--batch-size 1` 可用于不支持批量 JSON-RPC 的节点。增大 batch size 不保证更快，节点仍可能按内部请求数限流。

2026-10-27 实测浏览器显示约 35 万 atUSD、6 万 atETH 持有人。全量名单分页及数十万次历史查询会消耗大量 RPC 配额；公共节点不适合据此预估生产执行时间。

默认 `.context/gravity-cache/` 缓存按 chain ID、目标块和区块哈希隔离，包含：

- Transfer 扫描进度和候选地址，每个完成的区间可恢复。
- 历史余额、代码及分类结果；相同块下两种模式复用。

使用相同参数重新执行即可利用缓存。当前 holders 分页不缓存，避免把前一次的动态名单当作固定快照。**不要让多个进程同时写同一个缓存目录**；并行执行请设置不同 `--cache-dir`。

`--chunk-size` 设置最大日志区间（默认 100 万块）。`--from-block` 默认 0；任何非零起点都保守标记 `partial`，防止误把遗漏历史地址的扫描标为完整。若已知部署块，可以从该块加速扫描，但报告仍保留部分扫描标签。

## 测试

```bash
npm test

# 真实链路小范围测试，不是完整持仓快照；预期退出码为 2
npm run snapshot:gravity -- --block 130827456 --mode both \
  --limit-holders 100 --from-block 130826456 --out .context/gravity-smoke
```

`--limit-holders` 只限制 API 候选数量，`--from-block` 只限制 Transfer 范围。两者不限制另一种来源。去掉这两个参数才是默认的全量运行。

自动化测试覆盖分页、日志区间拆分及恢复、历史块固定、整数精度、清仓地址漏查、Safe 验证、RPC 错误处理、乱序批量响应和双模式 CLI 输出。

参考：[ERC-20](https://eips.ethereum.org/EIPS/eip-20)、[Blockscout token API](https://docs.blockscout.com/devs/apis/rpc/token)、[Safe deployments](https://github.com/safe-global/safe-deployments)、[Safe 1.4.1 代理编译产物](https://unpkg.com/@safe-global/safe-contracts@1.4.1/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json)、[EIP-7702](https://eips.ethereum.org/EIPS/eip-7702)。

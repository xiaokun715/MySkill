# 工程模式 Checklist —— 抽取细节时的归类清单

读完源码后，把记下的所有细节过一遍这个清单。每命中一条都要在 detail.md 里给一节单独写。

## 1. 多层防御 (Defense in Depth)

**定义**：同一个攻击向量在 ≥ 2 个独立位置被检查/拦截，互相不依赖对方。

**线索**：
- 同一种攻击模式在多个文件里都能找到对应 regex / 检查
- 注释出现 "defense in depth"、"belt and suspenders"
- 某个 strip / sanitize 函数被多个调用方分别调用
- 一个安全检查被实现两遍（一遍 fast-path，一遍 slow-path 兜底）

**怎么写**：
> "X 攻击在 [file1:line1](path#Lline) 和 [file2:line2](path#Lline) 都被堵。前者用 regex 快速识别，后者用语义解析兜底。如果只保留任一处，绕过路径是 ..."

## 2. 不动点迭代 (Fixed-Point Iteration)

**定义**：A 操作可能产生 B 形态，B 形态又触发 A 操作；用 while 循环到不再产生新结果。

**线索**：
- `while (stripped !== previousStripped)` 这种循环
- `Set<string> seen` + `commandsToTry.push(...)`
- 注释里出现 "fixed-point"、"iterate until stable"

**怎么写**：举一个**实际的**输入例子，跑一遍迭代过程，展示每一轮新产生什么。

## 3. AST 优先，正则兜底 (AST-First with Regex Fallback)

**定义**：主路径用结构化解析器（tree-sitter / babel / lxml），解析失败时降级到正则。

**线索**：
- `parseForSecurity` / `parseAst` 这种函数
- `if (parsed.kind !== 'simple') return failSafeFallback`
- `_DEPRECATED` 后缀（旧的正则路径被标记，但保留）

**怎么写**：解释为什么不能纯 regex（举一个 regex 容易被绕过的例子），又为什么不能纯 AST（解析器有时不可用）。

## 4. Lazy 初始化破循环依赖

**定义**：某个 schema/常量需要运行时值，又被早期模块引用，用 `lazySchema(() => ...)` 延迟。

**线索**：
- `lazySchema`、`memoize`、`getInitialSettings` 这种 thunk wrapper
- 单独抽出来的 `toolName.ts` 这种 2 行常量文件
- 文件顶部注释 "Here to break circular dependency from X"

**怎么写**：画依赖图，标出哪两个文件互相 import；解释 lazy 如何打破。

## 5. 白名单而不是黑名单

**定义**：列出"什么是允许的"而不是"什么是禁止的"。

**线索**：
- 长 `Set<string>` 列出允许的命令/参数/标志
- 注释 "allowlist"、"safelist"
- 校验函数返回 false 默认值

**怎么写**：列出白名单内容；说明黑名单方案为什么会出问题（攻击者总能找到名单外的新东西）。

## 6. 静默失败 = 安全 bug

**定义**：一个安全开关（沙箱、加密、签名校验）因配置/依赖原因失效时，**必须告诉用户**，不能默默降级。

**线索**：
- `getSandboxUnavailableReason()` 这种函数
- 启动时调用 `surfaceWarning(reason)`
- 注释 "security footgun"、"silent fallback is dangerous"

**怎么写**：写明降级路径，对比"静默 fallback"和"显式告警"两种实现各自带来的后果。

## 7. 模型视图 ≠ 用户视图

**定义**：同一份数据走两条独立的渲染路径 —— 给 LLM 的版本（含元数据、结构化标签）和给人看的版本（纯净 UI）。

**线索**：
- `mapToolResultToToolResultBlockParam` vs `renderToolResultMessage`
- `toLLMText()` vs `toDisplayText()`
- 注释 "UI never sees X, model never sees Y"

**怎么写**：列出两条路径分别包含 / 排除哪些字段，解释互相污染会出什么问题。

## 8. 顺序敏感操作 (Order-Dependent Operations)

**定义**：A 操作必须在 B 之前/之后，否则结果错误或不安全。

**线索**：
- 注释 "must run before X"、"order matters"
- "Phase 1 / Phase 2" 这种分阶段处理
- 多个 strip/sanitize 函数链式调用

**怎么写**：列出顺序约束，说明 A→B 和 B→A 各自的结果差异。

## 9. 零 token 侧信道

**定义**：通过 stderr/进程退出码/文件 mtime 等非 stdout 通道传递元信息，避免占用 LLM 上下文。

**线索**：
- 子进程 stderr 中的 `<some-tag />` 被父进程剥离
- 退出码不为 0 但 isError = false
- 临时文件传值

**怎么写**：画一张数据流图：发送方 → 通道 → 接收方，标出"模型可见 / 不可见"边界。

## 10. 可中断 / 可后台 / 可恢复

**定义**：长时操作必须有 abort signal、可以转后台、输出落盘可回看。

**线索**：
- `AbortController`、`AbortSignal`
- `onTimeout` 自动后台化
- 输出文件 + `<persisted-output>` 引用

**怎么写**：列出三种状态转移图（前台 ↔ 后台 ↔ 完成），每条边写触发条件。

## 11. 魔术数解释 (Magic Numbers Explained)

**定义**：代码里出现的具体数字必须有理由。

**线索**：
- `30_000`、`2000`、`64 * 1024 * 1024`
- 行内注释或常量名透露含义

**怎么写**：列一个表：常量 | 值 | 含义 | 为什么不能更大/更小

## 12. 不对称设计 (Intentional Asymmetry)

**定义**：两个看起来对等的概念，逻辑不对等且**故意**这样。

**线索**：
- "deny rules must be harder to circumvent than allow rules"
- "allow uses safe-list, deny uses broader pattern"
- 注释 "asymmetric / intentional / not symmetric"

**怎么写**：摆出对称的"教科书"实现，再说明本代码为什么偏离，偏离的方向是什么。

## 13. fail-safe 默认 (Fail-Safe Defaults)

**定义**：解析失败、依赖缺失、权限不明 → 走最严格的路径。

**线索**：
- `return () => true`（hook 兜底全部触发）
- `if (parsed.kind !== 'simple') return askUser()`
- 注释 "fail closed"、"fail in the safe direction"

**怎么写**：列出每个失败模式的 fallback 行为，解释为什么不是 fail-open。

## 14. Hot Reload / 热更新

**定义**：配置变化不需要重启，订阅 + refresh。

**线索**：
- `settingsChangeDetector.subscribe`
- `refreshConfig()` 同步重算（不用 await，避免竞态）

**怎么写**：写明"为什么 refresh 必须同步"。

## 15. 平台差异处理

**定义**：Windows / macOS / Linux / WSL 行为不一致时的桥接。

**线索**：
- `getPlatform()`
- POSIX/Windows 路径转换
- "Windows 'a' mode strips FILE_WRITE_DATA" 这种注释

**怎么写**：每个平台分支单独说明做了什么、解决什么问题。

---

## 怎么用这份 checklist

1. 读完源码后，把 scratchpad 里所有细节过一遍这个清单
2. 命中的模式在 detail.md 里**单独成节**
3. 没命中的模式不要硬凑（"这块代码不涉及 X"是 OK 的）
4. 一节里举 ≥ 1 个具体例子（带 file:line 链接）

最有价值的 detail.md 通常命中 6–10 个模式。命中 < 4 个考虑这块代码是不是太"白盒"，没必要写复刻指南。

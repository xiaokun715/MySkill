# BashTool 实现细节剖析（写自己 Agent 的参考手册）

> 目标读者：要从零写一个能让 LLM 安全调用 shell 的 Agent 工具。本文从 cc-haha 的 BashTool 中提炼出**可以直接复用的工程模式**，不只罗列代码，重点讲"**为什么这么做**"和"**不这么做会出什么事**"。
>
> 路径基线：`src/tools/BashTool/`，约 18 个文件、12,400 行 TypeScript，**安全相关代码占 64%**。

---

## 目录

- [一、整体哲学：让 LLM 安全跑 shell 是个工程难题](#一整体哲学让-llm-安全跑-shell-是个工程难题)
- [二、工具门面：buildTool 模式的钩子契约](#二工具门面buildtool-模式的钩子契约)
- [三、命令拆解：复合命令的"分而治之"](#三命令拆解复合命令的分而治之)
- [四、多层防御：8 层安全闸](#四多层防御8-层安全闸)
- [五、沙箱机制：能力外包，配置自管](#五沙箱机制能力外包配置自管)
- [六、权限系统：规则 + 分类器并行](#六权限系统规则--分类器并行)
- [七、命令语义化：把 shell 的怪癖告诉 LLM](#七命令语义化把-shell-的怪癖告诉-llm)
- [八、运行时机制：流式输出 + 自动后台化 + 中断](#八运行时机制流式输出--自动后台化--中断)
- [九、UX 关键工程细节](#九ux-关键工程细节)
- [十、给自己写 Agent 的清单](#十给自己写-agent-的清单)

---

## 一、整体哲学：让 LLM 安全跑 shell 是个工程难题

写之前先想清楚 4 件事：

| 问题 | cc-haha 的答案 |
|------|---------------|
| LLM 给什么样的命令？ | 任意 bash —— 复合 / 管道 / 重定向 / heredoc / 子 shell |
| 用户怎么知道在跑啥？ | 三层 UI：tool use 气泡 + 实时进度 + 结果折叠 |
| 出问题怎么办？ | 永远可中断（Ctrl+C）+ 可后台（Ctrl+B）+ 输出落盘可回看 |
| 安全怎么做？ | **解析 + 多层规则 + 分类器 + OS 沙箱** 四层独立防御 |

**最重要的一条认知**：**永远不要把 LLM 给你的命令字符串当一个原子单位看**。它是一棵语法树，每个节点都可能藏攻击。

---

## 二、工具门面：buildTool 模式的钩子契约

[BashTool.tsx:420](BashTool.tsx#L420) 的 `buildTool({...})` 不是函数，是**多个生命周期钩子的合集**。调度器、UI、权限、历史、搜索都各取所需。

```typescript
buildTool({
  // 元数据
  name, prompt, inputSchema, outputSchema,

  // 调度器查询的能力面
  isReadOnly, isConcurrencySafe,
  isSearchOrReadCommand,        // ← UI 决定是否折叠

  // 权限链
  validateInput,                 // 早期 schema/语义校验
  checkPermissions,              // ★ 核心权限闸门
  preparePermissionMatcher,      // 给 hook 系统用的匹配器
  toAutoClassifierInput,         // 喂给分类器的输入

  // 执行
  call,                          // ★ 真正跑命令

  // 输出双视图
  mapToolResultToToolResultBlockParam,   // 给 LLM 看的
  renderToolUseMessage / renderToolResultMessage,   // 给人看的
  extractSearchText,             // 历史搜索索引

  // 显示文案
  userFacingName, getActivityDescription, getToolUseSummary,
})
```

### 关键设计：**LLM 视角 ≠ 用户视角**

[BashTool.tsx:546-548](BashTool.tsx#L546-L548) 直白点出：
> `BashToolResultMessage shows <OutputLine content={stdout}> + stderr. UI never shows persistedOutputPath wrapper, backgroundInfo — those are model-facing`

同一份 tool result 走两条路：
- `mapToolResultToToolResultBlockParam` → 给模型看：包含 `<persisted-output>` 路径、后台任务 ID、退出码语义、沙箱违规告知
- `renderToolResultMessage` → 给人看：纯净的 stdout/stderr 渲染，不含任何模型才需要的元信息

**别让两条路互相污染**。模型不需要漂亮的 UI，人不需要看 `<persisted-output>` 这种 XML 标签。

### 输入 schema 的 5 个细节

[BashTool.tsx:227](BashTool.tsx#L227)：

```typescript
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string(),
  timeout: z.number().optional()              // 字段顺序：核心 → 可选
    .describe(`max ${getMaxTimeoutMs()}`),    // ← describe 里有运行时值
  description: z.string().optional()
    .describe(`...active voice...简洁示例...`), // ← 多行 prompt 教模型怎么写
  run_in_background: z.boolean().optional(),
  dangerouslyDisableSandbox: z.boolean()      // ← 危险开关用 dangerously 前缀
    .optional(),
  _simulatedSedEdit: z.object({...})         // ← 内部字段，下划线开头
    .optional(),
}))

// 给模型的 schema 永远 omit 掉 _simulatedSedEdit
const inputSchema = lazySchema(() =>
  fullInputSchema().omit({ _simulatedSedEdit: true })
)
```

**5 个可复用模式**：
1. **`lazySchema`**：因为描述里需要插 `getMaxTimeoutMs()` 这种运行时值，懒求值避免循环 import
2. **`z.strictObject`**：拒绝额外字段，防 LLM 偷渡
3. **`describe` 写教学示例**：给模型的工具说明就在 schema 里，不是单独的 prompt
4. **危险参数 `dangerously*` 前缀**：让模型自己看了都觉得"这个参数是不是不该用"
5. **下划线前缀的内部字段**：从 `inputSchema().omit()` 删掉，绝不暴露给模型

---

## 三、命令拆解：复合命令的"分而治之"

### 核心原则

> **任何对 `command: string` 的安全决策都不能基于整串字符串，必须先拆。**

### 三层拆解能力

```
原始字符串
  │
  ├─① splitCommand_DEPRECATED()  传统 regex/shell-quote 拆分
  │     "ls && git push"  →  ["ls", "git push"]
  │     兜底用，有 single-quote backslash bug，被新代码标 _DEPRECATED
  │
  ├─② splitCommandWithOperators()  保留 && / ; / | 操作符
  │     用于 UI 显示和保留语义
  │
  └─③ parseForSecurity (tree-sitter)   ★ AST 解析，安全决策的主路径
        返回:
        - {kind:'simple', commands: SimpleCommand[]}  干净拆分
        - {kind:'too-complex', reason}                有 $()/<()/控制流
        - {kind:'parse-unavailable'}                  解析器不可用
```

### Fail-Safe 三态决策

[BashTool.tsx:451-455](BashTool.tsx#L451-L455) 的 hook 匹配器实现：

```typescript
async preparePermissionMatcher({ command }) {
  const parsed = await parseForSecurity(command)
  if (parsed.kind !== 'simple') {
    // parse-unavailable / too-complex: fail safe by running the hook.
    return () => true
  }
  const subcommands = parsed.commands.map(c => c.argv.join(' '))
  return pattern => {
    const prefix = permissionRuleExtractPrefix(pattern)
    return subcommands.some(cmd => {
      if (prefix !== null) return cmd === prefix || cmd.startsWith(`${prefix} `)
      return matchWildcardPattern(pattern, cmd)
    })
  }
}
```

**复合命令安全 = OR semantics**：`ls && git push` 必须**让两个子命令都过 `Bash(git push:*)` 的安全 hook**。任何一个匹配就触发。

### 实战：`ls && git push` 的拆解流程

```
1. tree-sitter 解析 → kind: 'simple', commands: [
     {argv: ['ls']},
     {argv: ['git', 'push']}
   ]
2. 提取 subcommands: ["ls", "git push"]
3. 用户配置 deny rule: Bash(git push:*)
4. permissionRuleExtractPrefix("git push:*") → "git push"
5. some(cmd => cmd === "git push" || cmd.startsWith("git push ")) → true
6. 触发 hook ⇒ deny
```

如果不拆，直接 `command.startsWith("git push")` ⇒ false ⇒ **绕过！**

### 复合检查的 OR vs AND

| 场景 | 应该 | 不能 |
|-----|------|------|
| **deny 规则匹配** | OR：任一子命令匹配则 deny | AND |
| **allow 规则匹配** | AND：所有子命令都被允许才 allow | OR |
| **只读判定** | AND：所有子命令都只读才只读 | OR |
| **沙箱豁免（excludedCommands）** | OR：任一子命令在豁免列表才豁免？**不！** 还是 OR 但只用作 UX |

> ⚠️ 最后一条注意：[shouldUseSandbox.ts:18-20](shouldUseSandbox.ts#L18) 注释强调 excludedCommands 不是安全边界。复合命令豁免必须明确：「只要里面有 docker，全跳沙箱」是 UX 便利，**不是安全保证**。

---

## 四、多层防御：8 层安全闸

任何一条命令到达 `exec()` 之前会过 8 层独立检查。**任何一层失败就拦下**，并且**多层覆盖同一个攻击向量**（defense in depth）。

### 第 1 层：控制字符过滤

[bashSecurity.ts:2244-2272](bashSecurity.ts#L2244-L2272)：

```typescript
// 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
```

> Bash silently drops null bytes and ignores most control chars, so an attacker can use them to slip metacharacters past our checks while bash still executes them (e.g., `echo safe\x00; rm -rf /`).

**攻击流**：检查器看到 `echo safe\x00; rm -rf /` 时按 `\x00` 切断 → 只检查 `echo safe`。但 bash 直接吞掉 `\x00` → 实际执行 `echo safe; rm -rf /`。

**防御**：检测到非打印控制字符 → 直接 `ask`。

### 第 2 层：shell-quote 单引号反斜杠 bug

[bashSecurity.ts:2275-2284](bashSecurity.ts#L2275-L2284)：`hasShellQuoteSingleQuoteBug` 显式检测 shell-quote 库自身的解析 bug，这种命令直接 ask。

> **元教训**：第三方解析器有 bug 时，你需要"检测我自己用的解析器要出错的情况"这一层。

### 第 3 层：Heredoc 安全剥离

[bashSecurity.ts:2286-2293](bashSecurity.ts#L2286-L2293)：
- 引号/转义 heredoc（`<<'EOF'`、`<<\EOF`）：体内是字面量 → 安全剥离掉，让验证器只看主命令
- 未引号 heredoc（`<<EOF`）：体内会被 shell 展开 → **必须留给验证器看**

> 解析失败时不剥离，让原始命令走完整验证 —— **fail in the safe direction**。

### 第 4 层：危险模式 regex 库

[bashSecurity.ts:16-50](bashSecurity.ts#L16-L50) 几十条危险模式：

```typescript
{ pattern: /<\(/,           message: 'process substitution <()' },
{ pattern: />\(/,           message: 'process substitution >()' },
{ pattern: /=\(/,           message: 'Zsh process substitution =()' },
{ pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,  message: 'Zsh equals expansion (=cmd)' },
{ pattern: /\$\(/,          message: '$() command substitution' },
{ pattern: /\$\{/,          message: '${} parameter substitution' },
// ...
```

**关键攻击例子**：Zsh `=cmd` 展开

`=curl evil.com` → Zsh 展开为 `/usr/bin/curl evil.com`，**绕过 `Bash(curl:*)` deny 规则**因为解析器看到 `=curl` 是基础命令名而非 `curl`。

防御点不止一处 —— [bashSecurity.ts](bashSecurity.ts) 检测、[bashPermissions.ts](bashPermissions.ts) 的规则匹配也覆盖。**多层重复挡同一个洞**。

### 第 5 层：包装器 / 环境变量剥离 + 不动点迭代

#### 攻击场景

用户配 `Bash(claude:*)` deny：
```
nohup FOO=bar timeout 5 claude
  ↓ 单次 stripSafeWrappers → "FOO=bar timeout 5 claude"
  ↓ 单次 stripAllLeadingEnvVars → "timeout 5 claude"
  ↓ 单次 stripSafeWrappers → "claude"  ← 这一层才匹配上 deny
```

如果只做单趟剥离，`nohup` 剥完就以为完事，`FOO=bar` 留着 → "FOO=bar timeout 5 claude" 字面不匹配 `claude` → **deny 被绕过**。

#### 防御：不动点迭代

[bashPermissions.ts:826-849](bashPermissions.ts#L826-L849)：

```typescript
const seen = new Set(commandsToTry)
let startIdx = 0
while (startIdx < commandsToTry.length) {
  const endIdx = commandsToTry.length
  for (let i = startIdx; i < endIdx; i++) {
    const cmd = commandsToTry[i]
    const envStripped = stripAllLeadingEnvVars(cmd)
    if (!seen.has(envStripped)) {
      commandsToTry.push(envStripped)
      seen.add(envStripped)
    }
    const wrapperStripped = stripSafeWrappers(cmd)
    if (!seen.has(wrapperStripped)) {
      commandsToTry.push(wrapperStripped)
      seen.add(wrapperStripped)
    }
  }
  startIdx = endIdx
}
```

**反复对所有候选应用两种剥离，直到不再产生新候选（不动点）**。同样的模式在 [shouldUseSandbox.ts:82-101](shouldUseSandbox.ts#L82-L101) 也用。

#### 包装器的精细处理

[bashPermissions.ts:532-560](bashPermissions.ts#L532-L560) 的 `SAFE_WRAPPER_PATTERNS` 写得极其严谨：

```typescript
// timeout: 列举完整的 GNU 长短选项 + 类型受限的 value 模式
/^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|...)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/
```

**攻击例**：`timeout -k$(id) 10 ls`
- 旧的 `[^ \t]+` 会匹配 `-k$(id)` ⇒ 剥离整个 timeout 包装 ⇒ 留下 `ls` ⇒ 匹配 `Bash(ls:*)` 通过
- 但 bash 在 timeout 跑之前先做 word splitting，**`$(id)` 已经执行了**

**修复**：value 模式收紧到 `[A-Za-z0-9_.+-]+` 白名单（signals 是 TERM/KILL/9，durations 是 5/5s/10.5），拒绝 `$()` 等元字符。

### 第 6 层：路径越界检查 [pathValidation.ts](pathValidation.ts)

针对 50+ 种命令枚举它们能影响哪些路径：

[pathValidation.ts:190](pathValidation.ts#L190) `PATH_EXTRACTORS`：
- `cp`, `mv` → 解析最后一个参数是目标
- `rm` → 解析所有非选项参数
- `tar -xf` → 解析 -C 之后参数
- `grep` → 不写文件 → 不需要校验
- ...

[pathValidation.ts:1013](pathValidation.ts#L1013) `checkPathConstraints`：
1. **进程替换 `<(...)` `>(...)` 直接 ask**（能执行任意命令）
2. **重定向目标含 `$VAR` `%VAR%` 直接 ask**（无法静态验证）
3. 用 AST 拿到的 redirects 跑校验（不依赖 shell-quote）
4. 每个子命令调 `validateSinglePathCommandArgv` 检查参数路径是否越界

### 第 7 层：只读模式硬限制 [readOnlyValidation.ts](readOnlyValidation.ts)

#### 配置驱动的命令白名单

```typescript
type CommandConfig = {
  safeFlags: Record<string, FlagArgType>      // 标志白名单
  regex?: RegExp                               // 额外 regex 校验
  customCheck?: (cmd) => boolean               // 自定义回调
}
```

复用：`GIT_READ_ONLY_COMMANDS`、`RIPGREP_READ_ONLY_COMMANDS`、`GH_READ_ONLY_COMMANDS`、`PYRIGHT_READ_ONLY_COMMANDS`、`DOCKER_READ_ONLY_COMMANDS`、`EXTERNAL_READONLY_COMMANDS`。

#### 关键示例：`find ... -exec rm`

`find` 名义上是只读，但 `-exec` 后面跟谁就执行谁。读 `find` 配置时只 allow 的标志清单 ⇒ `-exec` 不在白名单 ⇒ **拒绝**。

#### 复合命令的额外安全检查（[readOnlyValidation.ts:1876](readOnlyValidation.ts#L1876)）

`checkReadOnlyConstraints` 不仅检查命令本身，还有：

1. **cd + git 复合**（[readOnlyValidation.ts:1917-1923](readOnlyValidation.ts#L1917-L1923)）：
   ```
   cd /malicious/dir && git status
   ```
   恶意目录里有 fake git hooks → git 触发 hooks → 任意代码执行。**复合命令同时含 cd 和 git → 不算只读**。

2. **bare-git-repo 检测**（[readOnlyValidation.ts:1926-1936](readOnlyValidation.ts#L1926-L1936)）：
   - 攻击者放 `HEAD + objects/ + refs/ + hooks/`
   - git 把当前目录当 bare repo
   - 触发 hooks/pre-commit → 任意代码

   **检测**：当前目录像 bare repo + 命令里有 git → 不算只读。

3. **复合命令同时写 git 内部路径 + 跑 git**（[readOnlyValidation.ts:1943-1949](readOnlyValidation.ts#L1943-L1949)）：
   ```
   mkdir -p hooks && echo 'malicious' > hooks/pre-commit && git status
   ```

### 第 8 层：实际执行前的 LLM 分类器（可选）

`feature('BASH_CLASSIFIER')` 开启时，[bashPermissions.ts:1605](bashPermissions.ts#L1605) `executeAsyncClassifierCheck` 用 Haiku 级小模型对命令做 `allow/ask/deny` 三分类。

**重要工程优化：speculative execution**
- [bashPermissions.ts:1497](bashPermissions.ts#L1497) `startSpeculativeClassifierCheck`：在弹用户审批对话框时**就启动分类器**
- 用户决策时分类器结果已就位 → 不阻塞 UX

### 防御层级关系

```
  [Layer 8] LLM 分类器（兜底）
        ↑ 不依赖前面的解析
  [Layer 7] 只读模式硬限制（可选模式）
  [Layer 6] 路径越界（基于 AST 或 regex）
  [Layer 5] 包装器 + env var 不动点剥离
  [Layer 4] 危险模式 regex 库
  [Layer 3] heredoc 安全剥离
  [Layer 2] shell-quote bug 检测
  [Layer 1] 控制字符过滤  ← 最早执行
```

**Layer 1-4 都是字符级/解析级**，对 LLM 来说廉价、快、确定；**Layer 5-7 是命令语义级**，更精确但更复杂；**Layer 8** 兜底兜不到的长尾。

---

## 五、沙箱机制：能力外包，配置自管

### 分层架构

```
┌─────────────────────────────────────────────────────────┐
│  BashTool.call → Shell.exec                              │ 调用方
│    if (shouldUseSandbox) wrapWithSandbox(cmd)            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  src/utils/sandbox/sandbox-adapter.ts (985 行)           │ 适配层
│   • settings.json → SandboxRuntimeConfig 翻译            │
│   • 永远 denyWrite 的硬编码                              │
│   • 平台/依赖检测、worktree 检测                          │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  @anthropic-ai/sandbox-runtime (外部 npm 包)             │ 内核层
│   • macOS  → sandbox-exec (.sb 配置文件)                 │
│   • Linux  → bubblewrap (bwrap)                          │
│   • WSL2   → bubblewrap                                  │
└─────────────────────────────────────────────────────────┘
```

### 是否包沙箱：[shouldUseSandbox.ts](shouldUseSandbox.ts)

```typescript
export function shouldUseSandbox(input): boolean {
  if (!SandboxManager.isSandboxingEnabled()) return false      // 1. 全局开关 + 平台 + 依赖
  if (input.dangerouslyDisableSandbox &&
      SandboxManager.areUnsandboxedCommandsAllowed()) return false  // 2. 模型显式 + 政策允许
  if (!input.command) return false
  if (containsExcludedCommand(input.command)) return false     // 3. 用户/动态豁免
  return true
}
```

**核心哲学**：

> [shouldUseSandbox.ts:18-20](shouldUseSandbox.ts#L18-L20)：
> `excludedCommands is a user-facing convenience feature, not a security boundary.`

`excludedCommands` 是 UX 便利，**不是安全控制**。真正的安全门是：当沙箱外执行被请求时，**用户审批**这一步。

### 配置翻译：`convertToSandboxRuntimeConfig`

[sandbox-adapter.ts:172](../../utils/sandbox/sandbox-adapter.ts#L172) 把多种配置面统一拍平：

```
WebFetch(domain:example.com) allow   ─┐
WebFetch(domain:evil.com)    deny    ─┤
settings.sandbox.network.*           ─┤→ network: {allowedDomains, deniedDomains, ...}
                                       │
Edit(/path) allow                    ─┐
Edit(/secret) deny                   ─┤
Read(/secret) deny                   ─┤→ filesystem: {allowRead, denyRead, allowWrite, denyWrite}
settings.sandbox.filesystem.*        ─┤
permissions.additionalDirectories    ─┤
--add-dir CLI flag                   ─┘
```

**对内层 sandbox-runtime 隐藏所有 Claude Code 特有的复杂性**。

### 永远 denyWrite 的硬编码（防逃逸）

[sandbox-adapter.ts:230-280](../../utils/sandbox/sandbox-adapter.ts#L230-L280)：

1. **永远写不动 settings 文件** —— 否则模型让沙箱内的命令改 settings.json，下次运行时把自己加进 allow ⇒ 逃逸
2. **永远写不动 `.claude/skills`** —— 这些被自动加载执行，等价于代码注入入口
3. **反 bare-git-repo 攻击**（最巧妙的一段）：
   ```
   # 攻击：在 cwd 放下 HEAD/objects/refs + config (含 core.fsmonitor=evil_cmd)
   # 用户在 cwd 跑沙箱外的 git 命令时 → git 把 cwd 当 bare repo
   # → 触发 fsmonitor → 任意代码执行 ⇒ 沙箱逃逸
   ```
   **防御**（双层）：
   - 已存在的文件 → 加进 denyWrite（沙箱内不能改）
   - 不存在的文件 → 记录到 `bareGitRepoScrubPaths`，命令结束后**物理删除**

   为什么不直接 denyWrite 不存在的路径？bwrap 会在那里 mount /dev/null，留下 0 字节 HEAD 残骸；且 `git log HEAD` 在沙箱内会报歧义错。所以分两套处理。

### 故障可见

[sandbox-adapter.ts:554-560](../../utils/sandbox/sandbox-adapter.ts#L554-L560) 解决了一个隐蔽 bug：用户开了 sandbox，但依赖缺失 → **静默降级为不沙箱** → 用户配的 allowedDomains 形同虚设。

```typescript
function getSandboxUnavailableReason(): string | undefined {
  if (!getSandboxEnabledSetting()) return undefined  // 没开就不啰嗦
  // 检测 platform、enabledPlatforms、依赖
  // 返回人类可读的原因
}
```

**启动时主动检测、告知用户**。安全开关静默失效是最坏的情况。

### 给自己写 Agent 的沙箱建议

如果你不想接 macOS sandbox-exec / Linux bwrap 这些重活，**最低限度也得做**：

1. **改变 cwd 到子目录**（`spawn` 的 `cwd` 选项）
2. **`stdin: 'ignore'`**（避免命令吃用户输入）
3. **超时强制 kill**
4. **限制环境变量**（`env: {PATH, HOME, ...}` 显式清单）
5. **denyWrite 关键路径**（settings、token 文件）—— 用 fs.watch 检测 + 命令后回滚

---

## 六、权限系统：规则 + 分类器并行

### 三种权限来源

```
1. 用户/项目/政策 settings.json 里的规则
   permissions: {
     allow: ["Bash(npm install:*)", "Bash(git status)"],
     deny:  ["Bash(rm -rf /:*)", "Bash(curl:*)"]
   }

2. LLM 分类器（feature('BASH_CLASSIFIER')）
   小模型读命令上下文 → allow/ask/deny

3. 用户实时审批弹窗
   规则未命中 + 分类器 ask → 弹给用户
```

### 规则匹配的多模式

[bashPermissions.ts:364](bashPermissions.ts#L364) `bashPermissionRule` 把规则字符串解析成 3 种类型：

| 规则形式 | type | 例 |
|---------|------|----|
| `Bash(git status)` | `exact` | 精确等于 `git status` |
| `Bash(git push:*)` | `prefix` | 以 `git push ` 开头或等于 `git push` |
| `Bash(*:*)` | `wildcard` | glob 风格 |

匹配前对**输入命令**做候选生成（[bashPermissions.ts:778-849](bashPermissions.ts#L778-L849) `filterRulesByContentsMatchingInput`）：
1. 原始 command
2. 去掉重定向（`> output.txt`）的 command
3. 剥 stripSafeWrappers 后的 command
4. 剥 stripAllLeadingEnvVars 后（仅 deny 规则）
5. 不动点迭代叠加 3+4

每条规则尝试匹配每个候选 → 任一组合命中视为命中。

### deny 比 allow 更严

[bashPermissions.ts:710-720](bashPermissions.ts#L710-L720)：

> `The safe-list restriction in stripSafeWrappers is correct for allow rules (prevents DOCKER_HOST=evil docker ps from auto-matching Bash(docker ps:*)), but deny rules must be harder to circumvent.`

- **allow 规则**：只剥安全的 env var（`SAFE_ENV_VARS`） —— 防止 `LD_PRELOAD=/evil/lib.so allowed_cmd` 自动 allow
- **deny 规则**：剥**所有** env var —— 防止 `FOO=anything denied_cmd` 绕过 deny

> 不对称是有意的。攻击者总是想把任意命令凑到 allow 形态，所以 allow 要严；防守者总是希望把任意命令凑到 deny 形态，所以 deny 要松。

### Speculative execution：分类器并行

[bashPermissions.ts:1497](bashPermissions.ts#L1497)：

```
弹审批对话框 → 同时启动分类器
  ↓                ↓
用户点击"批准"   分类器返回 allow
  ↓                ↓
        【两边汇合】
```

用户决策时分类器结果已经就位，零延迟体验。

---

## 七、命令语义化：把 shell 的怪癖告诉 LLM

### 退出码的真相

LLM 默认认为 `exit code != 0 = 失败`，但很多命令不是这样：

```typescript
// commandSemantics.ts:31
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  ['grep', (code) => ({
    isError: code >= 2,                                    // ← 0/1 都不算错
    message: code === 1 ? 'No matches found' : undefined,
  })],
  ['rg',   /* same */],
  ['find', (code) => ({
    isError: code >= 2,
    message: code === 1 ? 'Some directories were inaccessible' : undefined,
  })],
  ['diff', (code) => ({
    isError: code >= 2,
    message: code === 1 ? 'Files differ' : undefined,
  })],
  ['test', (code) => ({
    isError: code >= 2,
    message: code === 1 ? 'Condition is false' : undefined,
  })],
  // ...
])
```

**为什么重要**：模型看到 `grep foo file.txt` 退出 1 ⇒ 默认认为失败 ⇒ 重试 ⇒ 浪费 token。把"没匹配"翻译成人话告诉它，下一步就知道走别的查找方式。

### 静默命令的标记

[BashTool.tsx:81](BashTool.tsx#L81)：

```typescript
const BASH_SILENT_COMMANDS = new Set([
  'mv', 'cp', 'rm', 'mkdir', 'rmdir',
  'chmod', 'chown', 'chgrp',
  'touch', 'ln', 'cd', 'export', 'unset', 'wait',
])
```

成功时本来就没输出。模型看到空输出会怀疑"是不是没跑成功"，于是结果带 `noOutputExpected: true` 标记 → 模型知道这是预期行为。

### 模型用不好就帮它

整个 BashTool 充满这种"教学性"细节：

| 哪里 | 教模型什么 |
|-----|----------|
| [BashTool.tsx:520-523](BashTool.tsx#L520-L523) `getActivityDescription` | 工具调用气泡显示 "Running ls -la"，模型输出 description 时知道要写得简洁 |
| [BashTool.tsx:230-240](BashTool.tsx#L230-L240) `description` 字段的 `.describe()` | 直接在 schema 里写示例："- ls → 'List files'" 教模型描述风格 |
| [BashTool.tsx:525-533](BashTool.tsx#L525-L533) `detectBlockedSleepPattern` | `sleep 5` 直接拒绝，建议用 Monitor 工具，避免无谓阻塞 |
| 退出码语义化 | 模型不会无脑重试 grep/diff |
| `<claude-code-hint>` 零 token 侧信道 | CLI/SDK 子进程把建议写进 stderr，主控进程剥离后传给模型 |

---

## 八、运行时机制：流式输出 + 自动后台化 + 中断

### 异步生成器 yield progress

[BashTool.tsx:826](BashTool.tsx#L826) `runShellCommand` 是个 `AsyncGenerator`：

```typescript
async function* runShellCommand(...) {
  const shellCommand = await exec(command, abortController.signal, 'bash', {
    timeout: timeoutMs,
    onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
      lastProgressOutput = lastLines
      fullOutput = allLines
      // ... 唤醒 generator yield 进度
      resolveProgress?.()
    },
    shouldUseSandbox: shouldUseSandbox(input),
  })

  while (!done) {
    // 每 ~2s 或拿到 onProgress 信号时 yield
    yield { type: 'progress', output, fullOutput, elapsedTimeSeconds, ... }
  }
  return result  // 最终结果
}
```

调用方（`call`）通过 `for await` 消费：

```typescript
do {
  generatorResult = await commandGenerator.next()
  if (!generatorResult.done && onProgress) {
    onProgress({ data: { type: 'bash_progress', ...generatorResult.value }})
  }
} while (!generatorResult.done)
result = generatorResult.value  // 拿最终值
```

### 输出累积：保头保尾

[BashTool.tsx:636](BashTool.tsx#L636) `EndTruncatingAccumulator`：长输出**保留开头**（任务上下文）+ **保留结尾**（错误通常在尾部），中间丢弃。比简单 truncate 更适合 shell 输出。

### 输出落盘 + 模型可读

[BashTool.tsx:732-753](BashTool.tsx#L732-L753)：

```typescript
const MAX_PERSISTED_SIZE = 64 * 1024 * 1024
if (result.outputFilePath && result.outputTaskId) {
  const fileStat = await fsStat(result.outputFilePath)
  persistedOutputSize = fileStat.size
  await ensureToolResultsDir()
  const dest = getToolResultPath(result.outputTaskId, false)
  if (fileStat.size > MAX_PERSISTED_SIZE) await fsTruncate(...)
  try { await link(result.outputFilePath, dest) }      // 优先硬链接
  catch { await copyFile(result.outputFilePath, dest) }  // 不行则复制
  persistedOutputPath = dest
}
```

> 30K chars → 模型只看到预览 + `<persisted-output filepath="...">`，要看全靠 `Read` 工具。**节省 token + 给模型可达性**。

### 自动后台化：assistant 模式 15s 阈值

[BashTool.tsx:57](BashTool.tsx#L57)：

```typescript
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000
```

[BashTool.tsx:976-983](BashTool.tsx#L976-L983)：assistant 模式下，主线程跑命令超过 15s 自动后台化。命令继续跑，agent 继续干活；任务完成时通过通知机制告知。

### 中断 vs 后台

```
Ctrl+C  → AbortController.abort('interrupt')  → 命令树 kill
Ctrl+B  → backgroundExistingForegroundTask     → 命令变成 background task
Ctrl+B 后  → 输出仍写到 task 文件，可用 Read 查看
```

### Sandbox 后清理

[Shell.ts:391-393](../../utils/Shell.ts#L391-L393)：

```typescript
if (shouldUseSandbox) {
  SandboxManager.cleanupAfterCommand()
  // ↑ 内部调用 BaseSandboxManager.cleanupAfterCommand() + scrubBareGitRepoFiles()
}
```

> bwrap 会在禁写路径 mount /dev/null，命令退出后 host 上残留 0 字节 mount-point 文件。**同步**清理（用 sync API 而非 async），防止下个命令看到残骸。

---

## 九、UX 关键工程细节

### 1. UI 折叠 / 展开

[BashTool.tsx:60-72](BashTool.tsx#L60-L72)：

```typescript
const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', ...])
const BASH_READ_COMMANDS   = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', ...])
const BASH_LIST_COMMANDS   = new Set(['ls', 'tree', 'du'])
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])
```

`isSearchOrReadBashCommand` 判断**整条管道**的语义：所有部分都是搜索/读取/中性 → 整条折叠。

> `ls dir && echo "---" && ls dir2` 仍是一次"读取"操作，因为 `echo` 是 SEMANTIC_NEUTRAL。

### 2. sed 当 FileEdit 用（最巧妙的设计之一）

[BashTool.tsx:484-497](BashTool.tsx#L484-L497)：

```typescript
userFacingName(input) {
  if (input.command) {
    const sedInfo = parseSedEditCommand(input.command)
    if (sedInfo) {
      return fileEditUserFacingName({ file_path: sedInfo.filePath, old_string: 'x' })
    }
  }
  return 'Bash'
}
```

`sed -i 's/foo/bar/g' file.txt`：
1. UI 把它当成 FileEdit 显示，不是 shell 输出 → 用户看到 diff
2. `_simulatedSedEdit` 内部字段保存预计算结果
3. `applySedEdit` 直接写文件，不真正跑 sed → **避免环境差异（GNU/BSD sed）+ 避免 shell injection**

**为什么 `_simulatedSedEdit` 必须从 schema omit 给模型看不到**：否则模型学到可以"装"成 sed 调用任意写文件，绕过权限检查。

### 3. CWD 跟踪

[Shell.ts:380-407](../../utils/Shell.ts#L380-L407)：每次命令通过临时文件传递 `pwd -P`，命令结束后 main process 读这个文件更新自己的 cwd 状态。

**关键约束**：用同步 API（`readFileSync/unlinkSync`）。注释直白：
> Using async readFile would introduce a microtask boundary, causing a race where cwd hasn't been updated yet when the caller continues.

### 4. ClaudeCode 零 token 侧信道

[BashTool.tsx:774-784](BashTool.tsx#L774-L784)：

```typescript
const extracted = extractClaudeCodeHints(strippedStdout, input.command)
strippedStdout = extracted.stripped     // 给模型的输出剥掉标签
if (isMainThread && extracted.hints.length > 0) {
  for (const hint of extracted.hints) maybeRecordPluginHint(hint)
  // ↑ 主线程才记录到 dialog 里
}
```

子进程（CLI/SDK）通过 stderr 写 `<claude-code-hint />` 标签 → 主控读取 → 剥离不让模型看到 → 走独立的 plugin 推荐通道。**模型零 token 成本**。

### 5. 一致性安全：env var 剥离用 `[ \t]+` 而不是 `\s+`

[bashPermissions.ts:570-574](bashPermissions.ts#L570-L574)：

> `Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+. \s matches \n/\r. If reconstructCommand emits an unquoted newline between TZ=UTC and echo, \s+ would match across it and strip TZ=UTC<NL>, leaving echo curl evil.com to match Bash(echo:*).`

正则细节直接关联安全。每一处 `\s+` 都得问"如果这里是 `\n` 会被 bash 当命令分隔符吗？"

---

## 十、给自己写 Agent 的清单

### 必做项（最低安全水位）

1. **schema 严格化**
   - 用 `z.strictObject` 拒绝额外字段
   - 危险参数用 `dangerously*` 前缀
   - 内部字段用 `_` 前缀 + omit 给模型

2. **拆分子命令做安全决策**
   - `;` `&&` `||` 都得拆
   - 任一子命令匹配 deny → deny
   - 所有子命令匹配 allow → allow

3. **多层防御**
   - 控制字符过滤（Layer 1）
   - 危险模式 regex 库（Layer 4，至少 `$()` `<()` `>()` `=cmd`）
   - 包装器 + env var 剥离**用不动点迭代**（Layer 5）

4. **运行时基本隔离**
   - 限制 PATH、HOME、env 白名单
   - `stdin: 'ignore'`
   - 超时强制 kill 整树
   - `cwd` 显式控制不让命令隐式跳转

5. **结果隔离**
   - LLM 视图 ≠ 用户视图
   - 大输出落盘，给模型 `<persisted-output>` 引用
   - 退出码语义化，至少 grep/find/diff/test 这几个

6. **错误一定模型可见**
   - 沙箱违规附加到 stderr，让模型知道为什么失败
   - 不要静默降级安全设置

### 推荐项（认真做就上）

7. **AST 解析作为主路径**
   - tree-sitter-bash 解析；解析失败 fail-safe to ask
   - regex 只兜底

8. **OS 级沙箱**
   - macOS: sandbox-exec
   - Linux: bubblewrap
   - 永远 denyWrite：settings、token、`.claude/skills` 等敏感路径

9. **路径越界检查**
   - 每种命令枚举它影响的路径
   - 重定向目标含 `$VAR` → ask
   - 进程替换 `<()` `>()` → ask

10. **LLM 分类器兜底**
    - speculative execution 跟用户审批并行
    - 别阻塞 UX

11. **运行时 UX**
    - 实时进度（每 2s）
    - 自动后台化（>15s）
    - 永远可中断（Ctrl+C）/ 可后台（Ctrl+B）
    - 大输出保头保尾

### 反模式（不要做）

❌ **直接拼字符串当命令**：`exec(\`ls ${userInput}\`)` 永远是错的
❌ **`shell: true` 默认开**：让 shell 元字符成为攻击面
❌ **正则单趟剥离**：必须不动点迭代
❌ **静默降级安全设置**：用户开了沙箱但没 deps → 必须告诉用户
❌ **整串字符串当原子单位做安全决策**：`startsWith("git push")` 拦不住 `ls && git push`
❌ **excludedCommands 当安全控制**：那是 UX，安全门是用户审批
❌ **模型看到内部字段**：`_simulatedSedEdit` 之类必须 omit
❌ **LLM 视图和用户视图混用**：模型不需要 UI、人不需要 `<persisted-output>` 标签

---

## 附录 A：核心文件速查

| 文件 | 行数 | 一句话角色 |
|------|------|-----------|
| [BashTool.tsx](BashTool.tsx) | 1143 | 工具门面 + call 实现 |
| [bashSecurity.ts](bashSecurity.ts) | 2592 | 命令注入 / 危险模式检测 |
| [bashPermissions.ts](bashPermissions.ts) | 2621 | 规则引擎 + 分类器协作 |
| [pathValidation.ts](pathValidation.ts) | 1303 | 路径越界检查 |
| [readOnlyValidation.ts](readOnlyValidation.ts) | 1990 | 只读模式硬限制 |
| [sedValidation.ts](sedValidation.ts) | 684 | sed 命令白名单 |
| [sedEditParser.ts](sedEditParser.ts) | 322 | sed 当 FileEdit 用的解析 |
| [shouldUseSandbox.ts](shouldUseSandbox.ts) | 153 | 是否沙箱决策 |
| [commandSemantics.ts](commandSemantics.ts) | 140 | 退出码语义化 |
| [modeValidation.ts](modeValidation.ts) | 115 | 权限模式分流 |
| [destructiveCommandWarning.ts](destructiveCommandWarning.ts) | 102 | 危险命令警告 |
| [bashCommandHelpers.ts](bashCommandHelpers.ts) | 265 | 通用助手 |
| [prompt.ts](prompt.ts) | 369 | 给 LLM 的工具说明 |
| [UI.tsx](UI.tsx) | 184 | 工具调用气泡 |
| [BashToolResultMessage.tsx](BashToolResultMessage.tsx) | 190 | 结果渲染 |
| [utils.ts](utils.ts) | 223 | cwd 重置、图片输出处理 |
| [toolName.ts](toolName.ts) | 2 | 常量"Bash"（破循环依赖） |

## 附录 B：每个安全洞至少两处防御

| 攻击向量 | 防御点 1 | 防御点 2 |
|---------|---------|---------|
| Zsh `=cmd` 展开 | bashSecurity 危险模式 regex | bashPermissions 规则匹配 |
| `LD_PRELOAD=...` | bashPermissions stripAllLeadingEnvVars 不剥离 | 沙箱 env 白名单 |
| `nohup FOO=bar timeout claude` | 不动点迭代剥离 | LLM 分类器 |
| `find ... -exec rm` | readOnlyValidation flag 白名单 | pathValidation argv 检查 |
| `cd /evil && git status` | readOnlyValidation 复合 cd+git 检查 | 沙箱 denyWrite cwd 外路径 |
| bare-git-repo fsmonitor RCE | readOnlyValidation 检测 cwd | 沙箱 scrubBareGitRepoFiles |
| 控制字符 `\x00` | bashSecurity CONTROL_CHAR_RE | 解析器（tree-sitter）正确处理 |
| 进程替换 `<()` | pathValidation 直接 ask | bashSecurity 危险模式 |
| 重定向目标 `$VAR` | pathValidation hasDangerousRedirection | 沙箱 denyWrite 实际生效 |

---

## 一句话总结

> **写 Agent 的 BashTool 不是"包装一个 exec"，是"在 LLM 不可信的前提下，构建一套从字符过滤到 OS 隔离的纵深防御，同时让结果对模型可解释、对用户可见、对长时操作可恢复"。**
>
> cc-haha 用 12,000 行做这件事，64% 是安全。这不是过度工程 —— 是 LLM 调用 shell 的合理代价。

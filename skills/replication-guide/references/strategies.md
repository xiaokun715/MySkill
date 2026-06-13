# 不同规模文件夹的读取策略

写 detail.md 之前，先用 `wc -l` 估算总行数，按下面策略走。

## 摸底命令模板

```bash
# 1. 文件分布
ls -la <folder>/

# 2. 行数与语言
wc -l <folder>/*.{ts,tsx,js,py,go,rs,java,cpp,h} 2>/dev/null | sort -n

# 3. 全局骨架（每个文件的 export）
grep -n "^export\|^class\|^function\|^async function\|^const" <folder>/*.{ts,tsx,js,py,go,rs} 2>/dev/null | head -100

# 4. 安全相关注释（含金量最高的注释）
grep -rn "SECURITY:\|CVE-\|HackerOne\|Defense in depth\|fail.safe\|fail.closed\|fail.open\|attacker\|bypass\|TODO.*security\|FIXME" <folder>/ 2>/dev/null | head -50

# 5. issue / PR 引用（修复痕迹）
grep -rn "#[0-9]\{4,\}\|PR #\|issue.*[0-9]\{4,\}" <folder>/ 2>/dev/null | head -30
```

## 策略 A：< 1500 总行数（小型文件夹）

**特征**：单一职责工具，4–10 个文件。

**做法**：
1. 一次性 Read 所有文件（如果单文件 > 2000 行用 limit/offset 分块）
2. 按文件顺序写 detail，每个文件给 1–2 段
3. 不需要单独的"全局骨架"章节，直接进核心细节
4. 输出 detail.md 控制在 200–500 行

**适用例子**：单个工具的子模块、middleware 集合、几个互相关联的 utility。

## 策略 B：1500 – 5000 总行数（中型文件夹）

**特征**：完整的功能模块，10–20 个文件。

**做法**：
1. 用摸底命令的 #3 拿全局骨架，识别"主入口 + 核心 + 工具"三类文件
2. 主入口：完整读
3. 核心：读关键函数（用 #4 安全注释定位 + 调用关系）
4. 工具：grep 个 export 列表 + 抽样读 1–2 个核心函数
5. 写 detail 时**按工程模式聚类**而不是按文件聚类
6. 输出 detail.md 控制在 500–1000 行

**适用例子**：BashTool（12,400 行其实跨了"中-大"边界）、一个完整的 LSP 客户端、一个数据库 driver。

## 策略 C：≥ 5000 总行数（大型文件夹）

**特征**：通常是一个子系统而不是单一工具。

**做法**：
1. **必须先 grep 骨架**，禁止盲读所有文件
2. 把文件按"重要性 × 复杂度"打分，**先读重要 + 简单的**（最快摸到全貌）
3. 重要 + 复杂的文件 → **不全读**，只读关键函数：
   - 公开导出的 ≤ 5 个函数
   - 注释里有 "SECURITY:"、"PR #" 的段落
   - 入参/出参类型定义
4. 不重要的文件 → 一句话提到即可，不展开
5. 写 detail 时**严格按工程模式聚类**，不要按文件聚类（按文件聚类会变成翻译说明书）
6. 输出 detail.md 控制在 800–2000 行
7. **必须**有附录：核心文件速查表 + 模式 × 文件交叉表

**适用例子**：完整的 Bash 工具栈（含 sandbox + permissions + AST 解析）、整个 MCP server、一个 web 框架的核心。

### 大型文件夹的"层进式"展开

```
第 1 轮（5 分钟）：grep + ls + wc，写完文件分工表
第 2 轮（15 分钟）：读所有 ≤ 200 行的文件全文 + 大文件的 export 列表
第 3 轮（30 分钟）：定位关键函数（SECURITY 注释、issue 引用、不动点循环）
第 4 轮（30 分钟）：写 detail.md 核心章节
第 5 轮（15 分钟）：自检 + 补充
```

**禁忌**：在第 3 轮之前就开始写 detail.md。没读够细节会胡编。

## 单文件 > 2000 行的处理

无论文件夹规模，遇到 > 2000 行的单文件：

```bash
# 先看结构
grep -n "^export\|^const\|^function\|^class\|^async function" <file> | head -40

# 再按段读
Read <file> --offset N --limit 200  # 一次最多读 200 行
```

写文档时：**不要**为这种文件单独写一节"我把这个文件读完了"。读这种文件是手段，不是目的。

## 跨语言的特殊提示

| 语言 | 注意点 |
|-----|-------|
| TypeScript / TSX | `lazySchema`、Zod 定义看 `inputSchema`；React 组件看 `renderXxxMessage` |
| Python | 关注 `__init__.py` 的 export、装饰器（`@property`、`@dataclass`） |
| Rust | 关注 `mod.rs`、trait impl、unsafe 块的注释 |
| Go | 关注 `interface` 定义、defer 链、context 传递 |
| Java/Kotlin | 关注 builder 模式、`@Nullable` 注解、try-with-resources |

每种语言的"惯用法"会影响细节的提取角度。比如 Rust 的 unsafe 块就是天然的"为什么这么写"宝藏。

## 不要做的事

❌ **盲目 head 第一个文件就开写** —— 没读完就动笔会缺乏全局视角
❌ **大文件夹做策略 A** —— 把所有文件全读完会浪费 token，写出来也水
❌ **小文件夹做策略 C** —— 短代码硬凑长文档会掺水
❌ **不做摸底命令直接 Read** —— 对大文件夹一头雾水
❌ **跳过安全注释 grep** —— 错过最有价值的"why"线索

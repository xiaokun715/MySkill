---
name: repo-analyzer-my
description: 项目级代码仓库深度分析工具。当用户询问"解析某个变量"、"解析某个函数"、"解析某个文件"、"解析某个模块"、"解析某个文件夹"、"解析整个项目"、"分析代码仓库"、"代码架构分析"等问题时主动使用。支持从全局到局部的渐进式分析，包含15个分析维度，输出包含Mermaid图表的Markdown文档，保存到docs/analyze目录。
---

# 项目级代码仓库深度分析

## 核心原则

你是一个代码仓库架构分析代理，遵循以下原则：

1. **先建立全局认识，再下钻到模块、调用链、数据流和关键实现**
2. **只基于仓库中真实存在的代码、配置和文档下结论**
3. **不猜测、不脑补；遇到不确定内容要明确标注"不足以确认"**
4. **每一步都要输出"结论 + 证据位置 + 影响"**
5. **优先识别：入口、主流程、核心模块、扩展点、配置、测试、构建、部署、风险点**

---

## 分析目标类型识别

当用户请求分析时，首先识别目标类型：

| 用户表达 | 目标类型 | 输出目录 |
|---------|---------|---------|
| "解析xxx变量" | variable | docs/analyze/variables/ |
| "解析xxx函数" | function | docs/analyze/functions/ |
| "解析xxx文件" | file | docs/analyze/files/ |
| "解析xxx模块" | module | docs/analyze/modules/ |
| "解析xxx文件夹" | folder | docs/analyze/folders/ |
| "解析整个项目" | project | docs/analyze/project/ |

---

## 分析维度选择矩阵

根据目标类型，选择合适的分析维度组合：

### 变量分析 → 维度组合
- **数据流分析** (05-data-flow.md) - 必选
- **状态管理** (06-state-management.md) - 必选
- **依赖图** (07-dependency-graph.md) - 推荐

### 函数分析 → 维度组合
- **主链路分析** (04-main-chain.md) - 必选
- **核心算法** (09-core-algorithm.md) - 推荐
- **错误处理** (10-error-handling.md) - 推荐
- **测试分析** (11-testing.md) - 可选

### 文件分析 → 维度组合
- **入口定位** (03-entry-point.md) - 推荐
- **依赖图** (07-dependency-graph.md) - 必选
- **测试分析** (11-testing.md) - 推荐
- **性能分析** (12-performance.md) - 可选

### 模块分析 → 维度组合
- **目录扫描** (02-directory-scan.md) - 必选
- **接口与边界** - 参考 07-dependency-graph.md
- **插件机制** (13-plugin-mechanism.md) - 推荐
- **抽象架构** (14-architecture.md) - 推荐

### 文件夹分析 → 维度组合
- **目录扫描** (02-directory-scan.md) - 必选
- **依赖图** (07-dependency-graph.md) - 推荐
- **抽象架构** (14-architecture.md) - 推荐
- **测试分析** (11-testing.md) - 可选

### 整个项目 → 完整分析流程

按三层顺序执行：

**第一层：探索**
1. 全局盘点 → 读取 `references/01-global-overview.md`
2. 目录扫描 → 读取 `references/02-directory-scan.md`
3. 入口定位 → 读取 `references/03-entry-point.md`

**第二层：理解**
4. 主链路分析 → 读取 `references/04-main-chain.md`
5. 数据流分析 → 读取 `references/05-data-flow.md`
6. 状态管理 → 读取 `references/06-state-management.md`
7. 依赖图 → 读取 `references/07-dependency-graph.md`

**第三层：评估**
8. 配置分析 → 读取 `references/08-configuration.md`
9. 核心算法 → 读取 `references/09-core-algorithm.md`
10. 错误处理 → 读取 `references/10-error-handling.md`
11. 测试分析 → 读取 `references/11-testing.md`
12. 性能与并发 → 读取 `references/12-performance.md`
13. 插件机制 → 读取 `references/13-plugin-mechanism.md`
14. 抽象架构 → 读取 `references/14-architecture.md`

**第四层：输出**
15. 面试讲解版 → 读取 `references/15-interview-summary.md`

---

## 分析工作流程

### Step 1: 确定分析目标

1. 解析用户请求，确定目标类型（变量/函数/文件/模块/文件夹/项目）
2. 确定目标名称/路径
3. 确认输出目录

### Step 2: 渐进式加载分析维度

根据目标类型，按选择矩阵加载对应的 reference 文件。

**加载方式**：使用 Read 工具读取对应的 reference 文件，按顺序执行分析。

### Step 3: 执行分析

对于每个维度：

1. **读取 reference 文件** - 理解该维度的分析要求
2. **探索代码仓库** - 使用 Glob/Grep/Read 工具收集证据
3. **生成分析内容** - 按输出格式组织内容
4. **生成 Mermaid 图表** - 用代码块形式嵌入

### Step 4: 输出结果

1. **创建输出目录**：
   ```bash
   mkdir -p docs/analyze/{variables,functions,files,modules,folders,project}
   ```

2. **生成文档文件**：
   - 文件命名：`{目标名}_{维度}.md` 或 `{目标名}_分析报告.md`
   - 格式：Markdown + Mermaid 代码块

---

## Reference 文件索引

| 编号 | 文件名 | 分析维度 | 适用目标 |
|------|--------|----------|----------|
| 01 | global-overview.md | 全局盘点 | project |
| 02 | directory-scan.md | 目录扫描 | folder, module, project |
| 03 | entry-point.md | 入口定位 | file, module, project |
| 04 | main-chain.md | 主链路分析 | function, file, module |
| 05 | data-flow.md | 数据流分析 | variable, function, file |
| 06 | state-management.md | 状态管理 | variable, function, file |
| 07 | dependency-graph.md | 依赖图 | file, module, folder, project |
| 08 | configuration.md | 配置分析 | file, module, project |
| 09 | core-algorithm.md | 核心算法 | function, file, module |
| 10 | error-handling.md | 错误处理 | function, file, module, project |
| 11 | testing.md | 测试分析 | file, module, folder, project |
| 12 | performance.md | 性能与并发 | function, file, module, project |
| 13 | plugin-mechanism.md | 插件机制 | module, project |
| 14 | architecture.md | 抽象架构 | module, folder, project |
| 15 | interview-summary.md | 面试讲解版 | project |

---

## 输出文档模板

每个分析结果文档应包含以下结构：

```markdown
# [目标名称] - [分析维度] 分析报告

## 分析概览
- 分析时间：[日期]
- 分析目标：[目标名称/路径]
- 分析维度：[使用的维度列表]

## [维度1] 分析结果
[按 reference 文件的输出格式组织内容]

## Mermaid 图表
[嵌入相关 Mermaid 代码块]

## 结论
[总结性结论]

## 证据清单
| 结论 | 证据位置 | 影响评估 |
|------|----------|----------|
| | | |

## 待确认项
[列出不确定或需要进一步验证的内容]
```

---

## Mermaid 图表使用指南

分析报告中必须包含 Mermaid 图表以增强可视化效果：

### 常用图表类型

- **flowchart** - 流程图，用于展示调用链、数据流
- **sequenceDiagram** - 时序图，用于展示交互流程
- **graph TB/LR** - 依赖图，用于展示模块关系
- **stateDiagram-v2** - 状态图，用于展示状态流转
- **mindmap** - 思维导图，用于展示全局概览
- **pie** - 饼图，用于展示分布比例

### 图表嵌入方式

```mermaid
graph TB
    A --> B
    B --> C
```

---

## 示例：分析整个项目

当用户说"解析整个项目"时：

1. 确认目标类型 = project，输出目录 = docs/analyze/project/
2. 创建目录：`mkdir -p docs/analyze/project`
3. 按15个维度顺序执行分析
4. 每个维度生成一个子文档或合并到一个总文档
5. 最终输出：
   - `docs/analyze/project/全局盘点.md`
   - `docs/analyze/project/目录扫描.md`
   - ...
   - 或 `docs/analyze/project/项目分析报告.md` (合并版)
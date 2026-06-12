# parseOutput — Automatic Error Extraction from Tool Output

> Date: 2026-06-12
> Status: Draft
> Extends: docs/specs/2026-06-12-pi-dev-loop-design.md (§5, §11)
>           docs/specs/2026-06-12-pi-dev-loop-decision-engine-design.md

---

## 1. Problem

当前 `dev_control` 决策引擎已能接收 `errorsFixed` / `errorsRemaining` 结构化数据，但**这些错误签名需要人工/LLM 手动从工具输出中提取**。subagent 在运行 `bun run typecheck` 等验证命令后，看不到结构化的 `ErrorSignature[]`——只能靠 LLM 阅读文本输出并手动构造 JSON。

这导致：
- **不可靠**：LLM 可能漏掉、误读或编造错误
- **不完整**：大型输出（100+ 错误）时 LLM 经常截断
- **难以测试**：无法断言子 agent 是否正确提取了所有错误

`parseOutput` 填补这个缺口——自动将 tsc/eslint/vitest 等工具的输出解析为 `ErrorSignature[]`，可直接喂给 `mergeRegistry`。

---

## 2. Architecture

### 2.1 Type System

```typescript
// src/error-registry.ts 新增

// 内置 parser 名称
export type BuiltinParserName = "tsc" | "eslint" | "vitest";

// 自定义 parser 配置
export interface CustomParserConfig {
  pattern: string;                               // 正则字符串（含命名捕获组）
  category: ErrorRecord["category"];             // 固定分类
  fileGroup?: string;                            // 捕获组名（默认 "file"）
  lineGroup?: string;                            // 捕获组名（默认 "line"）
  messageGroup?: string;                         // 捕获组名（默认 "message"）
}

export type ParserConfig = BuiltinParserName | CustomParserConfig;

/**
 * 解析工具输出，返回 ErrorSignature 数组。
 * 始终返回数组（空数组表示无错误）。
 */
export function parseOutput(
  output: string,
  parser: ParserConfig,
): ErrorSignature[];
```

### 2.2 路由逻辑

```
parseOutput(output, parser)
    │
    ├── parser === "tsc"      → parseTSCOutput(output)
    ├── parser === "eslint"    → parseESLintOutput(output)
    ├── parser === "vitest"    → parseVitestOutput(output)
    └── parser (object)        → parseCustomOutput(output, parser)
```

---

## 3. Builtin Parsers

### 3.1 tsc (TypeScript Compiler)

**标准输出格式：**

```
src/user.ts:42:5 - error TS2322: Type 'string' is not assignable to type 'number'.
src/user.ts:50:10 - error TS18046: 'x' is of type 'unknown'.
src/auth.ts:12:3 - warning TS(6192): All imports are unused.
```

**有时一行不完整被截断到多行，但 tsc 默认每个错误一行。**

**正则：**

```typescript
const TSC_RE = /(\S+\.\w+):(\d+):\d+ - (?:error|warning) TS\d+: (.+)$/gm;
```

**提取规则：**

| 字段 | 来源 |
|------|------|
| `file` | 捕获组 1 |
| `line` | 捕获组 2（parseInt） |
| `message` | 捕获组 3（trim） |
| `category` | `"type"`（tsc 错误都是类型/编译错误） |

**边缘情况：**
- 空输出 → `[]`
- tsc 成功（exit 0，无输出） → `[]`
- 仅 warning 无 error → 仍作为 `"type"` 类别提取（warning 也可能导致运行时问题）
- 文件名包含空格 → tsc 输出中空格属于路径名，`\S+` 会将带空格路径截断。但 tsc 通常输出 Unix 路径无空格，少数 Windows 路径用引号包裹。暂不支持空格路径。

### 3.2 ESLint

**标准输出格式（stylish）：**

```
/abs/path/src/user.ts
  42:5   error    no-unused-vars  'x' is assigned but never used
  50:10  warning  prefer-const   'y' is never reassigned

/abs/path/src/auth.ts
  12:3   error    @typescript-eslint/no-unused-vars  'z' is unused
```

**或（compact）：**

```
/abs/path/src/user.ts: line 42, col 5, Error - no-unused-vars - 'x' is assigned but never used
```

**支持两种格式的复合正则：**

```typescript
// stylish 格式
const ESLINT_STYLISH_RE = /(\S+\.\w+)\s*\n\s+(\d+):\d+\s+(error|warning)\s+\S+\s+(.+)$/gm;
// compact 格式
const ESLINT_COMPACT_RE = /(\S+\.\w+): line (\d+).*?\b(error|warning)\b.*?\s+-\s+(.+)$/gim;
```

**提取规则：**

| 字段 | 来源 |
|------|------|
| `file` | 文件名行（stylish）或第一个组（compact） |
| `line` | 行号 |
| `message` | 错误描述 |
| `category` | `"lint"` |

### 3.3 Vitest

**标准输出格式：**

```
 ❯ src/__tests__/user.test.ts (3 tests) 232ms
   ✓ should create user (12ms)
   × should validate email (50ms)
     → AssertionError: expected 'foo' to match /^.+@.+$/

       - src/user.ts:20:10
         ...
       - src/user.ts:25:14

   × should handle edge case (30ms)
     → TypeError: Cannot read properties of undefined (reading 'length')
```

**Vitest 输出比 tsc 复杂得多——包含测试名称、断言消息、堆栈跟踪。** 需要关注的是：

1. `×` 开头的失败测试行 → 测试名称
2. `→` 开头的断言消息行 → 错误消息
3. 堆栈跟踪中的 `file:line:col` 引用 → 错误位置

**正则（简化版——只提取失败测试信息和源文件位置）：**

```typescript
// 失败测试行
const VITEST_FAIL_RE = /^\s+×\s+(.+?)(?:\s+\(\d+ms\))?$/gm;
// 断言消息
const VITEST_MSG_RE = /^\s+→\s+(.+)$/gm;
// 堆栈中的文件引用
const VITEST_STACK_RE = /^\s+-\s+(\S+\.\w+):(\d+):\d+/gm;
```

**提取规则：**

| 字段 | 来源 |
|------|------|
| `file` | 堆栈跟踪第一个引用的非测试文件 |
| `line` | 对应的行号 |
| `message` | `测试名: 断言消息` |
| `category` | `"test"` |

**边缘情况：**
- 全部测试通过 → `[]`
- 断言在测试文件自身（`*.test.ts`）→ 使用 `file` 的测试文件路径
- 多个堆栈条目 → 取第一个非 `node_modules` 的条目

---

## 4. Custom Parser

通过 `CustomParserConfig` 支持用户自定义正则。

```typescript
export function parseCustomOutput(
  output: string,
  config: CustomParserConfig,
): ErrorSignature[] {
  const re = new RegExp(config.pattern, "gm");
  const results: ErrorSignature[] = [];
  const fileGroup = config.fileGroup ?? "file";
  const lineGroup = config.lineGroup ?? "line";
  const messageGroup = config.messageGroup ?? "message";

  for (const match of output.matchAll(re)) {
    const groups = match.groups ?? {};
    const file = groups[fileGroup]?.trim();
    const lineStr = groups[lineGroup]?.trim();
    const message = groups[messageGroup]?.trim();
    if (!file || !message) continue;

    const line = lineStr ? parseInt(lineStr, 10) : undefined;
    const id = fingerprint(file, line ?? 0, message);
    results.push({ id, category: config.category, file, line, message });
  }

  return results;
}
```

**要求自定义正则必须使用命名捕获组：**

| 捕获组 | 用途 | 默认名称 | 可覆盖 |
|--------|------|----------|--------|
| `(?<file>...)` | 文件路径 | `"file"` | `fileGroup` |
| `(?<line>...)` | 行号（可选） | `"line"` | `lineGroup` |
| `(?<message>...)` | 错误消息 | `"message"` | `messageGroup` |

**YAML 配置示例：**

```yaml
verify:
  - command: "./scripts/check-style.sh"
    runsOn: impl
    parser:
      pattern: "ERROR in (?<file>[^:]+):(?<line>\\d+): (?<message>.*)"
      category: "lint"
```

---

## 5. Integration Points

### 5.1 在 `packImplTask` 中使用

`packImplTask` 生成的任务指令末尾增加：

```
### Error Extraction from Verification Output
After running each verify command, extract the errors from its output:
- For each command, use the parser defined in its config
- Populate `errorsRemaining` with the extracted errors
```

### 5.2 使用场景

`parseOutput` 的使用场景：

**子 agent 内部（初始实现目标）**：子 agent 在 task 中接收到 parser 配置后，运行验证命令并用 `parseOutput` 解析输出，然后直接构造结构化的 `errorsFixed` / `errorsRemaining`。

`packImplTask` 生成的任务指令末尾增加：

```
### Error Extraction from Verification Output
For each verify command, use the parser defined above to extract errors:
- Parse stdout/stderr with the specified parser
- Populate `errorsRemaining` with extracted errors
- If verification passes (no errors), `errorsRemaining` is empty
```

**orchestrator 自动解析（未来增强）**：子 agent 返回原始 `verifyOutputs`，orchestrator 自动调用 `parseOutput`。

---

## 6. categorize 替换

`categorize(exitCode, output)` 函数被 `getParserForCommand` 替代。旧的 `categorize` 被移除——分类信息现在来自 parser 配置，而非 exit code。

```typescript
/**
 * 从 dev loop 配置中查找 command 对应的 parser 配置。
 * 通过精确字符串匹配定位 VerifyStep。
 * 如果找不到或 parser 未配置，返回 null（不自动解析）。
 */
export function getParserForCommand(
  command: string,
  steps: VerifyStep[],
): ParserConfig | null {
  const step = steps.find(s => s.command === command);
  if (!step || !step.parser) return null;
  return step.parser;
}
```

注意：`--verify` 命令行参数不携带 parser 信息（`parseInlineVerifies` 不设置 parser），只有 `.pidev.yml` 才能配置 parser。

### 对 index.ts 的影响

`index.ts` 不需要直接调用 `parseOutput`——parseOutput 是暴露给子 agent 或外部工具使用的函数。
`getParserForCommand` 用于需要自动解析的场景。

当前 `dev_control` 的决策引擎暂不集成自动解析，
先让子 agent 按已有协议返回 `errorsFixed` / `errorsRemaining`。
自动解析可以作为独立增强后续添加。

---

## 7. 变更文件

| 文件 | 变更 |
|------|------|
| `src/error-registry.ts` | 新增 `parseOutput`、`parseCustomOutput`、`BuiltinParserName`、`CustomParserConfig`、`ParserConfig` 类型；替换 `categorize` 为 `getParserForCommand` |
| `src/state.ts` | `VerifyStep.parser` 类型升级为 `string \| ParserConfig` |
| `src/subagent-task.ts` | 在结构化输出模板中增加 parser 用法说明 |
| `src/load-config.ts` | YAML 解析支持 `CustomParserConfig` 对象格式 |
| `src/verify-config.ts` | `parseInlineVerifies` 保持不变（CLI 参数不带 parser）；新增 `getParserForCommand` |
| `tests/error-registry.test.ts` | 新增 `parseOutput` 测试用例 |

---

## 8. 内置 Parser 测试用例

### tsc

```
Input (empty):
  ""
Output: []

Input (clean build):
  ""
Output: []

Input (one error):
  "src/user.ts:42:5 - error TS2322: Type 'string' is not assignable to type 'number'."
Output:
  [{ id: "<hash>", category: "type", file: "src/user.ts", line: 42, message: "Type 'string' is not assignable to type 'number'." }]

Input (two errors, different files):
  "src/user.ts:42:5 - error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/auth.ts:12:3 - error TS6192: All imports are unused."
Output: 2 ErrorSignature entries

Input (warning only):
  "src/user.ts:50:10 - warning TS(6192): All imports are unused."
Output: 1 entry (warnings are still extracted)
```

### ESLint

```
Input (stylish, one error):
  "/path/src/user.ts\n  42:5   error    no-unused-vars  'x' is assigned but never used"
Output: 1 entry, category: "lint"

Input (compact):
  "/path/src/user.ts: line 42, col 5, Error - no-unused-vars - 'x' is unused"
Output: 1 entry

Input (clean):
  ""
Output: []
```

### Vitest

```
Input (all pass):
  "Test Files  3 passed (3)\nTests  15 passed (15)"
Output: []

Input (one failure):
  "× should validate email (50ms)\n  → AssertionError: expected 'foo' to match /^.+@.+$/"
Output: 1 entry, category: "test"

Input (failure with stack):
  "× should validate email\n  → TypeError: Cannot read properties of undefined\n  - src/user.ts:20:10\n  - src/user.ts:25:14"
Output: 1 entry, file: "src/user.ts", line: 20
```

### Custom Parser

```
Input:
  "ERROR in src/app.ts:42: Missing semicolon\nERROR in src/db.ts:10: Unused import"

Config:
  { pattern: "ERROR in (?<file>[^:]+):(?<line>\\d+): (?<message>.*)", category: "lint" }

Output: 2 entries
```

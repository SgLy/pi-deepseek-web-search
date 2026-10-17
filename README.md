# pi-deepseek-web-search

pi 包（pi package），扩展入口为本目录下的 `index.ts`，把 DeepSeek 官方的 Search / Fetch API 包装成两个工具 `web_search` 与 `web_fetch`。参数、请求体和响应字段与官方接口一一对应，可选字段未提供时不会下发，由服务端应用默认值。

- Base URL：`https://api.deepseek.com`（默认值；自定义时必须 `https:`，仅 loopback 可用 `http:`，见「配置」）
- 认证：`Authorization: Bearer <key>`
- 请求：`Content-Type: application/json`

## 工具

| 工具         | 后端接口                         |
| ------------ | -------------------------------- |
| `web_search` | `POST {baseUrl}/v1/tools/search` |
| `web_fetch`  | `POST {baseUrl}/v1/tools/fetch`  |

两个工具都声明为只读且访问开放网络（MCP 语义的 `readOnlyHint: true`、`openWorldHint: true`），权限扩展可以据此判断是否需要确认调用。

### `web_search`

```ts
web_search(query, count?, ori_question?, localization?, need_content?)
```

| 参数           | 类型    | 必填 | 约束 / 默认                     | 说明                                                                                   |
| -------------- | ------- | ---- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `query`        | string  | 是   | 非空，≤128 字符，不能全空白     | 搜索词。支持 `site:`、`-site:`、`"..."`、`lang:`、`after:`、`before:` 等语法，原样透传 |
| `count`        | integer | 否   | 1～50，服务端默认 10            | 返回条数                                                                               |
| `ori_question` | string  | 否   | 非空，≤128 字符；不用时省略即可 | 触发搜索的用户原始问题，用于补全检索意图                                               |
| `localization` | string  | 否   | 服务端默认 `""`                 | 用于优先返回本地化搜索结果的 IP 地址                                                   |
| `need_content` | boolean | 否   | 服务端默认 `false`              | 为 `true` 时在 `content` 返回网页正文                                                  |

工具只把调用方实际给出的字段放进请求体。例如只传 `query` 时，请求体就是 `{"query":"..."}`；`count`、`need_content` 等未传字段不会用本地默认值填充，从而保留服务端默认行为。两个工具的 schema 都声明了 `additionalProperties: false`，模型多给的键在 pi 的工具参数校验阶段就会被拒绝，不会进入请求体。

搜索响应结构：

```json
{
  "results": [
    {
      "rerank_score": 2.7,
      "title": "Example title",
      "url": "https://example.com/page",
      "snippet": "100～200 字符的摘要，用于前端展示",
      "summary": "600～800 字符的摘要，适合模型阅读",
      "content": "need_content=false 或正文缺失时为空串",
      "site_name": "Example",
      "site_icon": "https://example.com/favicon.ico",
      "date": "2025-01-01T00:00:00Z",
      "authority": 3
    }
  ]
}
```

| 字段                     | 类型           | 说明                                              |
| ------------------------ | -------------- | ------------------------------------------------- |
| `results`                | array          | 结果列表，必填；无结果时为空数组                  |
| `results[].rerank_score` | number         | 重排得分，0～3；≥1.5 通常为优质结果               |
| `results[].title`        | string         | 标题                                              |
| `results[].url`          | string         | 页面 URL                                          |
| `results[].snippet`      | string         | 100～200 字符的短摘要，适合前端展示               |
| `results[].summary`      | string         | 600～800 字符的摘要，适合给模型阅读               |
| `results[].content`      | string         | 网页正文；`need_content=false` 或正文缺失时为空串 |
| `results[].site_name`    | string \| null | 站点名称                                          |
| `results[].site_icon`    | string \| null | 站点图标 URL                                      |
| `results[].date`         | string \| null | 发布时间，UTC RFC3339                             |
| `results[].authority`    | number         | 权威度：`-1` 未知，`0～4`；≥3 极权威              |

`results` 与除 `site_name`、`site_icon`、`date` 之外的每个字段在官方 schema 里都是 required 且非 `null`；只有那三个字段可为 `null`。

`web_search` 返回给模型的文本示例：

```
Search: deepseek api rate limit

[1] Rate limits - DeepSeek API Docs
https://api-docs.deepseek.com/quick_start/rate_limit
DeepSeek · 2025-01-15T08:30:00Z · rerank 2.7 · authority 4

DeepSeek imposes per-endpoint QPS limits and asks clients to back off on 429 responses.

[2] ...
```

渲染规则：

- 元信息行只拼接存在的字段，分隔符为 `·`。
- `authority` 为 `-1` 或缺失时不显示。
- `site_name`、`date`、`rerank_score` 缺失时不显示对应片段。
- 正文优先用 `summary`；为空时回退 `snippet`；两者都为空则省略该段。
- `content` 非空时追加一段正文（通常来自 `need_content: true`）。
- 无结果时输出 `Search: <query>` 加空行和 `No results.`。

输出超过 2000 行或 50KB 时按头截断，并在末尾追加 `[Output truncated: X of Y lines (A of B) shown.]`。若越界的是一整行，会补上该行在剩余字节预算内的前缀（`truncateLine` 会追加 `... [truncated]`），提示扩展为 `... shown. Line N is <原始大小>, cut to <保留大小>.`，不静默丢行；只剩行数越界时不会补半行。截断提示之后另起一行追加 `Re-run with a smaller count, or use web_fetch on a listed URL to read one page in full.`，避免只告诉模型截了多少却不给恢复完整内容的路径（`details.results` 刻意不含 `content`）。

正文结束（含截断提示）后可能再追加两类提示行，它们不受截断预算限制，永远完整出现在文本末尾、每行一条、顺序固定为 `[skipped]` 在前 `[config]` 在后：

| 提示行                                       | 出现条件                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[skipped] N malformed result entry/entries` | 服务端返回的 `results` 里有 N 个条目被跳过（`N === 1` 用单数）：条目不是对象，或对象里某个字段类型不对                                                            |
| `[config] <问题 1>; <问题 2>`                | 配置文件存在任何问题（JSON 语法错、字段类型错、未知字段、`baseUrl` 不合规），项目配置因未信任被忽略，或信任存储读取失败（此时项目配置按未信任处理），见「配置」节 |

工具结果的 `details` 为：

```ts
{
  query: string,
  resultCount: number,
  skippedCount: number, // 被跳过的 malformed results 条目数（非对象或字段类型不符）
  results: Array<Omit<SearchResult, "content">> // 字段保持 snake_case，且不含 content
}
```

`results` 刻意剥掉了 `content`：正文已经在返回给模型的文本里，再进会话记录近似双倍体积。

### `web_fetch`

```ts
web_fetch(url);
```

| 参数  | 类型   | 必填 | 约束                                                                      | 说明                   |
| ----- | ------ | ---- | ------------------------------------------------------------------------- | ---------------------- |
| `url` | string | 是   | 非空，≤8192 字符，必须是含 host 的 HTTP/HTTPS URL，且不能携带用户名或密码 | 要抓取并提取正文的页面 |

本地会先用 `new URL()` 校验：协议必须是 `http:`/`https:`、必须有 host、不能包含 `username`/`password`、长度不能超过 8192；不合法会直接抛错且不发出请求。校验后下发和展示的都是规范化后的 `url.href`（例如首尾空白会被去掉）。

响应结构：

```json
{
  "title": "页面标题（缺失时为空串）",
  "content": "Markdown 格式的正文"
}
```

返回给模型的文本：标题（非空时）→ URL → 空行 → Markdown 正文；正文为空时输出 `(no content extracted)`。配置文件有问题时同样在末尾追加 `[config] ...`（与 `web_search` 一致）。

`details` 为 `{ url, title }`，`url` 是规范化后的 `url.href`。

## 错误处理

官方错误响应结构：

```json
{
  "error": {
    "message": "具体错误信息",
    "type": "错误类型",
    "param": null,
    "code": "错误码"
  }
}
```

扩展会优先使用 `error.message`，抛出 `HTTP <status>: <message>`；取不到 message 时使用截断后的原始响应体，抛出 `HTTP <status>: <原始响应体>`。重试次数用尽后的错误会再追加总尝试次数，例如 `HTTP 500: 服务端错误 (after 3 attempts)`。

`429` 等可重试状态若带 `Retry-After`，同时支持 delta-seconds（`3`）与 HTTP-date（`Wed, 21 Oct 2015 07:28:00 GMT`）：前者按秒折算，后者按 `max(0, 目标时间 - 当前时间)` 折算。等待时长取固定退避与 `Retry-After` 的较大值；`Retry-After` 超过 5 秒时不再缩到 5 秒硬重试，而是立即失败并在错误中给出服务端要求的等待秒数与 endpoint，例如 `http://.../v1/tools/search returned HTTP 429 asking to retry after 60s, above the 5s limit; giving up`。若响应带了非空的 `Retry-After` 但两种形式都解析不出来，不会静默按 0 处理：立即失败并报错，文案包含原始 header 值与 endpoint，例如 `<endpoint> returned HTTP 429 with an unparseable Retry-After header "garbage"; giving up`。header 存在但值为空（`Retry-After:`）按未提供处理，走固定退避重试。

单次 HTTP 请求有 30 秒超时：超时直接失败，错误带 endpoint 与毫秒数，例如 `http://.../v1/tools/fetch request timed out after 30000ms`，且与其它网络层失败一样不重试。调用方取消（abort）仍抛取消原因，不会被当成超时。

网络层直接失败（DNS、连接被拒、TLS 等）不重试，但错误信息会带上 endpoint 和已尝试次数，例如 `http://.../v1/tools/search request failed (attempt 1): fetch failed`。响应结构校验失败时的错误：

- HTTP 200 但响应体不是 JSON：`<endpoint> returned invalid JSON (HTTP 200): ...`
- 响应体不是 JSON 对象（数组、字符串、数字、`null`）：`<endpoint> returned a non-object body: <preview>`
- `results` 缺失（官方 schema 中为必填）：`<endpoint> returned no "results" field: <preview>`
- `results` 不是数组：`<endpoint> returned a non-array "results": ...`
- `results[i]` 的字段类型不对：该条目按 malformed 跳过（计入 `skippedCount` 并在文本末尾出现 `[skipped]`），其余条目与整次调用不受影响；`<endpoint> results[<i>].<field> must be a string` / `... must be a number` 只用于内部定位，不会作为工具错误抛出（`web_fetch` 的 `title`/`content` 类型错误仍是致命错误：`<endpoint> <field> must be a string`）

本扩展对结果字段刻意宽松：`null` 与缺失一律按“没有该字段”处理（渲染时跳过）；单条结果里字段类型不对（例如 `title` 是数字）只让该条目作废，不会让整次搜索失败。官方 schema 中只有 `site_name`、`site_icon`、`date` 可为 `null`，`title`、`url`、`snippet`、`summary`、`content`、`rerank_score`、`authority` 都是必填非空；宽松归一是本扩展的选择，目的是服务端偶尔少给字段或给出坏字段时不至于让整次搜索失败，代价是必填字段缺失或类型不符不会被单独指出。`results` 中非对象、或对象里字段类型不对的条目会被跳过，但不再静默：跳过数记在 `details.skippedCount`，非零时文本末尾追加 `[skipped] N malformed result entry/entries`，从而能与“确实没有结果”（`results: []`）区分开。`results` 本身缺失或不是数组会直接报错，因为那说明响应契约被破坏。

| 状态码 | 含义                                                                                       | 是否自动重试 |
| ------ | ------------------------------------------------------------------------------------------ | ------------ |
| 400    | 请求头/体不合法                                                                            | 否           |
| 401    | API key 缺失或无效                                                                         | 否           |
| 402    | 余额不足                                                                                   | 否           |
| 403    | Fetch 被安全策略拒绝                                                                       | 否           |
| 404    | Fetch 未获取到可用网页内容（URL 不可用、被拦截、目标站报错、内容类型不支持、无可提取正文） | 否           |
| 408    | 读取请求体超时                                                                             | 是           |
| 413    | 请求体超限                                                                                 | 否           |
| 429    | 超过 QPS 限制                                                                              | 是           |
| 500    | 服务端错误                                                                                 | 是           |
| 504    | 下游超时                                                                                   | 是           |

自动重试最多 2 次，退避 1s、2s（`429` 的 `Retry-After` 支持秒数与 HTTP-date，空值按未提供处理，超过 5 秒或非空但无法解析则直接失败）；等待期间响应取消信号。依据官方文档，`408`/`429`/`5xx` 等待后重试，其它 `4xx` 不重试。

## 计费与限速

- 按成功请求次数计费：每 1000 次 5 元。
- Search 与 Fetch 各限制 5 QPS；Fetch 还对目标域名有额外的 QPS 限制。
- 扩展会对 `408`/`429`/`5xx` 自动退避重试，但高频调用仍可能触发 `429`，应控制调用节奏。

## 配置

使用 pi 惯用的 JSON 配置文件 `pi-deepseek-web-search.json`：

```json
{
  "apiKey": "sk-...",
  "baseUrl": "https://api.deepseek.com"
}
```

两个位置会被自动发现，项目级覆盖全局。配置文件内容每次工具调用都按当前会话的工作目录（`ctx.cwd`）重新读取，改完保存即生效，不需要 `/reload`。信任存储不在每次调用时重读：同一个扩展实例内按 `(agent 目录, cwd)` 只读一次并缓存，因此信任决定的变更和宿主一样需要重启 pi 才生效（这只影响信任决定，配置文件本身仍然每次重新读取）：

| 位置                                      | 作用域             | 读取条件                                                     |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------ |
| `~/.pi/agent/pi-deepseek-web-search.json` | 全局（所有项目）   | 总是读取                                                     |
| `<项目>/.pi/pi-deepseek-web-search.json`  | 项目级（覆盖全局） | 当前会话信任该项目，**且**信任存储里已有该项目的显式信任决定 |

「显式信任决定」指 `ProjectTrustStore.get(ctx.cwd) === true`，即用户曾经用 `/trust`（或信任提示里的 remember）保存过 `true`；`null`（没有决定）与 `false`（拒绝过）都不算。只满足 `ctx.isProjectTrusted()` 不够：宿主对没有任何「需要信任的资源」的项目直接返回 `true`，而该清单只有 `settings.json`、`mcp.json`、`extensions`、`skills`、`prompts`、`themes`、`SYSTEM.md`、`APPEND_SYSTEM.md`，不含本插件的配置文件。因此只提交一个 `.pi/pi-deepseek-web-search.json` 的仓库不会让这个文件自动生效。

信任存储读取失败不会让工具调用失败。宿主读信任存储时会创建 agent 目录并对 `trust.json` 加锁，`trust.json` 内容非法、agent 目录不可写或锁竞争超时都会抛错；本扩展把这类失败一律当作「未信任」（项目配置被忽略，工具继续用全局配置与环境变量），并在 `[config]` 里报一条 `<~/.pi/agent/trust.json>: <原因> (project config ignored)`。原因只给粗略分类（如 `trust store unreadable`、`trust store unavailable (EACCES)`），不回显 `trust.json` 的内容。

项目级配置决定 `Authorization: Bearer <key>` 发往哪个主机，所以上述两个条件缺一不可。未满足时项目文件**整个被忽略**：不读取内容、不使用，只用全局配置与环境变量；为了不让人毫无线索，只要该文件存在，`[config]` 提示里就会出现 `<路径>: ignored (project not trusted)`（`web_search` 与 `web_fetch` 都会带）。切进一个带恶意 `.pi/pi-deepseek-web-search.json` 的仓库时，`DEEPSEEK_API_KEY` 与全局 `apiKey` 都不会被送到该文件指定的域名。用 `/trust` 保存信任决定；`--approve` 与 `defaultProjectTrust` 只影响本次会话的信任判断，不写信任记录，因此不会让项目配置生效。`/trust` 保存后需要重启 pi 才会更新会话的信任判断（宿主会提示），保存决定并重启后项目配置即生效；配置文件内容本身的改动仍然不需要 `/reload`。

字段说明：

| 字段      | 必填 | 说明                                                            |
| --------- | ---- | --------------------------------------------------------------- |
| `apiKey`  | 否   | DeepSeek API key；缺省时回退到环境变量 `DEEPSEEK_API_KEY`       |
| `baseUrl` | 否   | API 根地址，默认 `https://api.deepseek.com`（尾部斜杠会被去掉） |

`baseUrl` 规则（校验在读取配置时完成，不合规的值不会被使用）：

- 必须是绝对 URL，且带 host。
- 必须是 `https:`；唯一例外是 `http:` 且 host 为 loopback（`localhost`、`127.0.0.0/8`、`[::1]`），用于本地调试。
- `http://` 指向其它主机（例如 `http://10.0.0.5`）一律拒绝，因为那会把 bearer key 明文发到网络上。
- 不能包含用户名/密码、查询串或片段：`https://user:pw@api.deepseek.com`、`https://api.deepseek.com?x=1`、`https://api.deepseek.com#frag` 都会被拒绝。`baseUrl` 后面会直接拼 `/v1/tools/...`，这些成分会拼出错误 endpoint，凭据还会进入 `fetch` 的报错文本；错误只说明原因，不回显口令。

不合规时记一条 `field "baseUrl" <原因>` 问题（原因如 `must be an absolute https URL ...`、`must not include credentials ...`、`must not include a query string or fragment`），并按“没有可用 baseUrl”处理：**不静默回退到默认端点**，直接抛错且不发出任何请求（错误信息带 `baseUrl` 与具体问题，例如 `No usable DeepSeek baseUrl: fix the "baseUrl" config problem. Config problems: ...`）。

优先级：项目 config（需会话信任且信任决定已保存）> 全局 config > 环境变量 / 内置默认值。

配置文件解析失败时，错误信息会指出是哪个文件的问题（只给路径和问题类型，不会回显文件内容，因此不会泄 key）。字段类型不对（例如 `apiKey` 写成数字）也会被当成问题记录，而不是静默忽略。文件里出现不认识的键（例如把 `apiKey` 拼成 `api_key`、把 `baseUrl` 拼成 `baseURL`）同样记一条 `unknown field "<键名>"`，只报键名、不回显键值，避免拼写错误被误判成“没配 key”。

只要 `problems` 非空，即使 key 仍然可用（来自环境变量或另一份配置），工具也不会把问题吞掉：正常返回的正文与截断提示之后会追加一行 `[config] <问题 1>; <问题 2>`，正文保持完整。信任存储读取失败也会通过这条通道上报，且不改变请求发往哪里（项目配置仍按未信任忽略）。抛错只在拿不到可用的 `baseUrl` 或 `apiKey` 时发生：

- 无可用 `baseUrl`：抛 `No usable DeepSeek baseUrl: ...`，不发请求。
- 两处都没有 key：抛 `DeepSeek API key is not configured. ...`，提示在 `~/.pi/agent/pi-deepseek-web-search.json` 写 `apiKey` 或设置 `DEEPSEEK_API_KEY`，末尾追加 `Config problems: ...` 列出具体问题，以便区分“配置文件坏了”和“没配置 key”。

两种错误信息都不会包含 key 本身。

## 使用

### 直接测试

```bash
pi -e /home/sgly/code/deepseek-search/pi-plugin/pi-deepseek-web-search
```

### 作为项目本地扩展

放到 `.pi/extensions/pi-deepseek-web-search/index.ts`，或加进 `settings.json` 的 `extensions` 列表，之后 `/reload` 即可热加载。

### 作为包安装

```bash
pi install /home/sgly/code/deepseek-search/pi-plugin/pi-deepseek-web-search
```

卸载（`<source>` 与安装时一致，`pi uninstall` 是别名）：

```bash
pi remove /home/sgly/code/deepseek-search/pi-plugin/pi-deepseek-web-search
```

## 类型检查

`tsconfig.json` 只覆盖 `index.ts`，`pnpm run check` 等价于 `tsc --noEmit`。

```bash
cd /home/sgly/code/deepseek-search/pi-plugin/pi-deepseek-web-search
pnpm install          # 仅本地开发用：typescript、@types/node、以及类型定义用的宿主包
pnpm run check
```

宿主包（`@earendil-works/pi-coding-agent`、`typebox`）声明在 `peerDependencies`（范围 `"*"`），`devDependencies` 只是为了让 `tsc` 拿到类型；pi 运行时用 jiti 把这两个包别名到自身副本，本地副本不参与运行时解析。

## 运行时依赖

`@earendil-works/pi-coding-agent`、`typebox` 由 pi 运行时提供，本包运行时不依赖 `node_modules`；上文的 `pnpm install` 只为类型检查服务。网络请求使用内置 `fetch`。

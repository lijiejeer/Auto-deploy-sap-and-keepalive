# Cloudflare Worker 保活脚本使用教程（Databricks 专用）

本文档介绍如何部署和使用 `worker-data-keepalive.js`，实现对 Databricks Lakehouse App 的自动保活：当容器在 24 小时后停止时，Cloudflare Worker 检测到异常会自动调用 Databricks API 启动应用，并提供可视化状态页与日志查询功能。

## 功能概述
- 参照 `_worker-keep.js` 的结构，提供：
  - 首页状态页（`/`）：直观查看各 App 的运行状态
  - API：`/status`（状态 JSON）、`/start`（手动触发检查与启动）、`/check`（配置自检）
  - 新增日志查询：`/logs`（HTML 页面，支持关键词检索、级别筛选、时间过滤、条数限制）
- 健康检查规则：将 HTTP 200、302 视为“健康”（Databricks 未登录时可能重定向到登录页），其余状态视为异常
- 自动启动：使用 Databricks API（多条备选启动路径，逐一尝试），无感恢复

## 前置条件
- 一个可访问的 Databricks Workspace App URL，例如：
  `https://dbc-xxxxxxx.cloud.databricks.com/apps/databricksapp01?o=3607529273444022`
- Databricks 访问令牌（Personal Access Token，简称 PAT）
  - 在 Databricks 用户设置中生成访问令牌（确保具备启动 Lakehouse App 的权限）
  - 以 Cloudflare Worker Secret 的方式保存，不要硬编码在代码中

## 部署步骤（Cloudflare Workers）
1. 登录 Cloudflare Dashboard，进入“Workers & Pages”
2. 新建一个 Worker，点击“编辑”
3. 打开本仓库的 `worker-data-keepalive.js`，复制全部内容，粘贴到 Worker 编辑器中
4. 在 Worker 的“Settings -> Variables and Secrets”中新增 Secret：
   - 名称：`DATABRICKS_TOKEN`
   - 值：你的 Databricks 访问令牌（PAT）
5. 点击“保存并部署”（Save and Deploy）
6. （可选）添加 Cron 触发器（Settings -> Triggers -> Cron Triggers）：
   - 例如：`*/5 * * * *` 表示每 5 分钟检测一次
   - 或在你希望自动恢复的时间窗口内更密集地触发（注意免费版触发频率限制）

## 监控对象配置（多应用支持）
在 `worker-data-keepalive.js` 顶部的 `MONITORED_APPS` 数组中新增/修改条目：

字段说明：
- `url`：应用访问地址（建议带上 `?o=<workspaceId>` 参数，便于自动解析）
- `name`：在状态页展示的名称
- `type`：固定为 `"databricks"`
- `host`：（可选）Databricks 主机地址（如留空将从 `url` 自动解析）
- `workspaceId`：（可选）工作区 ID（如留空将从 `url` 的 `o` 参数自动解析）
- `appName`：（可选）Databricks App 的名称（用于调用启动 API；如留空使用 `name`）

示例：
```js
const MONITORED_APPS = [
  {
    url: "https://dbc-ba852385-a3cb.cloud.databricks.com/apps/databricksapp01?o=3607529273444022",
    name: "databricksapp01",
    type: "databricks",
    host: "",          // 可留空，自动解析
    workspaceId: "",   // 可留空，自动解析
    appName: "databricksapp01"
  },
  {
    url: "https://dbc-xxxxxxx.cloud.databricks.com/apps/app02?o=1234567890123456",
    name: "app02",
    type: "databricks"
  }
];
```

## 运行与验证
部署成功后，访问 Worker 的公网地址，例如 `https://<your-worker>.<subdomain>.workers.dev/`，可使用以下端点：
- `/`：图形化状态页（可视化每个应用的运行状态）
- `/status`：返回 JSON 形式的状态
- `/start`：手动触发一次“检查并启动”，在后台执行
- `/check`：返回当前监控配置与时间戳
- `/logs`：查询运行日志（HTML 页面，状态中文+颜色区分），支持参数：
  - `q`：关键词模糊匹配（搜索日志文本）
  - `level`：`INFO` | `WARN` | `ERROR`（页面显示分别对应“成功 / 异常 / 失败”，颜色为绿色 / 橙色 / 红色）
  - `limit`：返回条数 1～500（默认 100）
  - `since`：起始时间（ISO 8601），例如：`2025-10-20T00:00:00Z`

常用示例：
- 查看日志：`/logs`
- 只看失败日志：`/logs?level=ERROR&limit=100`
- 关键字检索：`/logs?q=start&limit=50`
- 时间过滤：`/logs?since=2025-10-20T00:00:00Z`
- 综合示例：`/logs?q=app-check&level=INFO&limit=200&since=2025-10-20T08:00:00Z`

命令行示例（以 `/status` 为例）：
```bash
curl https://<your-worker>.<subdomain>.workers.dev/status
```

## 工作原理
1. 健康检查：对 `url` 发起 GET 请求
   - 返回 `200` 或 `302` → 判定为“健康”（未登录时 Databricks 往往重定向到登录页）
   - 其它状态或网络错误 → 判定为“异常”，进入启动流程
2. 启动流程：调用 Databricks API 启动 App（依次尝试多条候选 Endpoint）
   - `/api/2.0/apps/{appName}/start`
   - `/api/2.0/lakehouse/apps/{appName}/start`
   - `/api/2.1/apps/{appName}/start`
   - 使用 `Authorization: Bearer <DATABRICKS_TOKEN>` 进行鉴权
   - 如提供 `workspaceId`，会以 JSON 形式在请求体中添加 `{ workspace_id: <id> }`
3. 启动后等待 8 秒并二次检查 URL 状态，记录结果与日志

> 注意：Databricks Lakehouse Apps 的 API 会持续演进，若全部候选路径都返回 404/403/500，请联系管理员确认你的工作区版本与权限，或按需调整脚本中的路径。

## 常见问题与排查
- 日志中出现 `缺少 Databricks host 或 令牌`：
  - 请确保 Worker 的 Secret 中设置了 `DATABRICKS_TOKEN`
  - `host` 一般可自动解析，如 `url` 异常请手动指定 `host`
- 启动 API 返回 403/401：
  - PAT 权限不足或已失效，请重新生成令牌并确保具备启动 App 的权限
- 启动 API 返回 404：
  - `appName` 不正确或 API 路径不适配当前工作区版本
- 页面总是“未登录 / 403”，但实际服务正常：
  - 默认将 `200/302` 视为健康；若你的环境需要将 `401/403` 也视为“健康”，可在 `checkAppUrl` 中自行调整
- Cron 没有按时触发：
  - 免费计划存在触发频率与配额限制，请检查 Cloudflare 控制台的触发器配置

## 安全建议
- 不要将 `DATABRICKS_TOKEN` 明文写入代码，统一使用 Cloudflare Secret 管理
- 为令牌授予最小化权限，定期更换，避免泄露

## 自定义与扩展
- 支持同时监控多个 Databricks App，按需扩展 `MONITORED_APPS`
- 如需变更“健康定义”，修改 `checkAppUrl` 中的判定逻辑
- 如需集成告警（Telegram/Email 等），可参考 `_worker-keep.js` 的通知逻辑进行扩展

## 参考
- 脚本文件：`worker-data-keepalive.js`
- 相关示例：`_worker-keep.js`（SAP CF 多应用保活脚本，供风格与结构参考）

如在使用过程中遇到问题，欢迎在仓库提交 Issue 反馈。

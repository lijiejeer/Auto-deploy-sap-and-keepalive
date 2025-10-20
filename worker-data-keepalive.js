// Databricks App keepalive Cloudflare Worker
// 参照 _worker-keep.js 样式：提供首页、/status、/start、/check 等端点
// 并新增 /logs 日志查询功能（支持检索、限制条数、HTML/JSON 两种格式）

// ============ 基础配置（可使用 Worker 环境变量覆盖）============
let DATABRICKS_TOKEN = "你的Databricks访问令牌"; // 在 Worker 环境变量中设置 DATABRICKS_TOKEN

// 监控目标（可配置多个）
// 对于 Databricks Workspace 的 Lakehouse App，可直接填入你的 App 页面 URL 和名称
// host 可留空（将从 url 中自动解析），workspaceId 可留空（可从 ?o=xxx 参数自动解析）
const MONITORED_APPS = [
  {
    url: "https://dbc-ba852385-a3cb.cloud.databricks.com/apps/databricksapp01?o=3607529273444022",
    name: "databricksapp01",
    type: "databricks",
    host: "",
    workspaceId: "",
    appName: "databricksapp01"
  }
];

// ============ 日志缓冲（/logs 查询）============
const LOG_LIMIT = 500;
const logs = []; // { ts: ISOString, level: 'INFO'|'WARN'|'ERROR', msg: string, meta?: object }
function pushLog(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta ? { meta } : {}) };
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.shift();
}
const log = {
  info: (msg, meta) => pushLog('INFO', msg, meta),
  warn: (msg, meta) => pushLog('WARN', msg, meta),
  error: (msg, meta) => pushLog('ERROR', msg, meta)
};

// ============ 工具函数 ============
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const json = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { 'content-type': 'application/json' } });
function formatShanghaiTime(date) {
  const utcTime = date.getTime() + (date.getTimezoneOffset() * 60000);
  const shanghaiTime = new Date(utcTime + (8 * 60 * 60 * 1000));
  return shanghaiTime.getFullYear() + '-' + String(shanghaiTime.getMonth() + 1).padStart(2, '0') + '-' + String(shanghaiTime.getDate()).padStart(2, '0') + ' ' + String(shanghaiTime.getHours()).padStart(2, '0') + ':' + String(shanghaiTime.getMinutes()).padStart(2, '0');
}

function parseDatabricksHost(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return '';
  }
}
function parseWorkspaceId(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.searchParams.get('o') || '';
  } catch (e) {
    return '';
  }
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 30000, ...rest } = options;
  return fetch(resource, { signal: AbortSignal.timeout(timeout), ...rest });
}

// ============ 健康检查 ============
async function checkAppUrl(appUrl) {
  try {
    const res = await fetchWithTimeout(appUrl, { method: 'GET', redirect: 'follow', timeout: 30000 });
    log.info(`[app-check] ${appUrl} -> ${res.status}`);
    // Databricks 工作区应用在未登录时通常会 302/401/403，但只要容器停止往往返回 404 或 5xx
    // 这里我们将 200/302 视为“健康”，其它视为异常
    return [200, 302].includes(res.status);
  } catch (err) {
    log.warn(`[app-check] ${appUrl} error: ${err.message}`);
    return false;
  }
}

// ============ Databricks API ============
// 注意：Databricks Lakehouse Apps 仍处于不断演进的阶段，API 路径可能存在差异。
// 下面提供多种候选 endpoint，逐一尝试，任意一个成功即可。
async function dbxStartApp(host, token, appName, workspaceId = '') {
  const candidates = [
    { method: 'POST', path: `/api/2.0/apps/${encodeURIComponent(appName)}/start` },
    { method: 'POST', path: `/api/2.0/lakehouse/apps/${encodeURIComponent(appName)}/start` },
    { method: 'POST', path: `/api/2.1/apps/${encodeURIComponent(appName)}/start` },
  ];
  const headers = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' };
  const body = workspaceId ? JSON.stringify({ workspace_id: workspaceId }) : null;

  for (const c of candidates) {
    const url = `${host}${c.path}`;
    try {
      const resp = await fetch(url, { method: c.method, headers, body });
      const text = await resp.text();
      if (resp.ok) {
        log.info(`[dbx-start] OK ${resp.status} via ${c.path}`);
        return true;
      }
      log.warn(`[dbx-start] ${resp.status} ${c.path}: ${text.substring(0, 200)}`);
    } catch (e) {
      log.warn(`[dbx-start] error on ${c.path}: ${e.message}`);
    }
  }
  throw new Error('无法通过已知 API 启动 Databricks App，请检查主机、令牌和权限');
}

// ============ 页面渲染 ============
function generateStatusPage(apps) {
  const now = new Date();
  const formattedDate = formatShanghaiTime(now);
  const cards = apps.map(app => {
    const statusClass = app.healthy ? 'status-up' : 'status-down';
    const statusText = app.healthy ? '运行中' : '已停止/异常';
    return `
      <div class="status-card ${statusClass}">
        <div class="card-header">
          <h3>${app.app}</h3>
          <span class="status-indicator ${statusClass}">${statusText}</span>
        </div>
        <div class="card-body">
          <p><strong>URL:</strong> <a href="${app.url}" target="_blank">${app.url}</a></p>
          ${app.type ? `<p><strong>类型:</strong> ${app.type}</p>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Databricks App 保活监控</title>
  <style>
    :root { --up: #4CAF50; --down: #F44336; --bg: #f5f5f5; --card:#fff; --shadow: 0 4px 8px rgba(0,0,0,.1); --radius: 10px; }
    body { margin:0; font-family: -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background: var(--bg); color:#333; }
    .container{ max-width: 960px; margin: 0 auto; padding: 24px; }
    header{ background: #667eea; padding: 28px; color:#fff; border-radius: var(--radius); box-shadow: var(--shadow); text-align:center; }
    h1{ margin:0; font-size: 24px; }
    .grid{ display:grid; grid-template-columns: repeat(auto-fill,minmax(320px,1fr)); gap:16px; margin-top: 18px; }
    .status-card{ background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); overflow:hidden; }
    .card-header{ display:flex; align-items:center; justify-content:space-between; padding: 16px 18px; border-bottom:1px solid #eee; }
    .status-indicator{ padding: 6px 12px; border-radius: 999px; font-weight: 600; font-size: 12px; }
    .status-up{ background: rgba(76,175,80,.12); color: var(--up); }
    .status-down{ background: rgba(244,67,54,.12); color: var(--down); }
    .card-body{ padding: 14px 18px; }
    .actions{ margin: 16px 0; text-align:center; }
    .btn{ display:inline-block; background: linear-gradient(135deg,#667eea,#764ba2); color:#fff; border:none; padding:10px 18px; border-radius:8px; cursor:pointer; }
    footer{ margin-top: 24px; text-align:center; color:#777; font-size: 12px; }
    .meta{ text-align:center; color:#777; font-size: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Databricks App 保活监控</h1>
      <div>自动检测容器停止并自动启动，支持日志查询</div>
    </header>
    <div class="actions"><button class="btn" onclick="location.reload()">刷新状态</button> <a class="btn" style="text-decoration:none" href="/logs?format=html" target="_blank">查看日志</a></div>
    <div class="grid">${cards}</div>
    <div class="meta">最后更新：${formattedDate}</div>
    <footer>© ${new Date().getFullYear()} Auto-SAP/Databricks Keepalive</footer>
  </div>
</body>
</html>
  `;
}

// ============ 核心启动逻辑 ============
async function ensureAppRunning(app, reason = 'unknown') {
  const { url, name, type } = app;
  log.info(`[trigger] ${reason} for ${name}`);

  // 步骤1：URL 健康检查
  const healthy = await checkAppUrl(url);
  if (healthy) {
    log.info(`[decision] ${name} 正常，无需重启`);
    return { app: name, status: 'healthy', url };
  }

  // 步骤2：尝试启动（仅对 type=databricks 启动）
  if (type === 'databricks') {
    const host = app.host || parseDatabricksHost(url);
    const workspaceId = app.workspaceId || parseWorkspaceId(url);
    const token = DATABRICKS_TOKEN;
    if (!host || !token) {
      log.error(`[config] 缺少 Databricks host 或 令牌，无法启动`);
      return { app: name, status: 'unhealthy_no_token', url };
    }

    log.info(`[action] 调用 Databricks API 启动应用 ${name}`);
    await dbxStartApp(host, token, app.appName || name, workspaceId);

    // 等待一会再检查
    await sleep(8000);
    const ok = await checkAppUrl(url);
    if (ok) {
      log.info(`[success] ${name} 启动成功`);
      return { app: name, status: 'started', url };
    } else {
      log.warn(`[warn] ${name} 启动后仍未就绪，稍后可能会恢复`);
      return { app: name, status: 'started_but_unhealthy', url };
    }
  }

  // 非 databricks 类型暂不支持自动启动
  log.warn(`[skip] ${name} 非 Databricks 类型或未配置启动方式`);
  return { app: name, status: 'unhealthy', url };
}

async function monitorAllApps(reason = 'unknown') {
  const results = [];
  for (const app of MONITORED_APPS) {
    try {
      const r = await ensureAppRunning(app, reason);
      results.push(r);
    } catch (e) {
      log.error(`[app-error] 处理 ${app.name} 出错: ${e.message}`);
      results.push({ app: app.name, status: 'error', error: e.message, url: app.url });
    }
    await sleep(800);
  }
  return results;
}

// ============ 日志查询 ============
function renderLogsHTML(rows) {
  const items = rows.map(r => `<tr><td>${r.ts}</td><td>${r.level}</td><td>${escapeHtml(r.msg)}</td></tr>`).join('');
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Keepalive 日志</title>
  <style>
    body{font-family: -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; margin:0; padding:16px;}
    h1{margin:0 0 12px 0;}
    table{border-collapse: collapse; width: 100%;}
    th,td{border:1px solid #eee; text-align:left; padding:6px 8px; font-size: 12px;}
    th{background:#f7f7f7}
    .meta{color:#777; font-size:12px; margin: 10px 0 20px}
    .controls a{display:inline-block; margin-right: 8px;}
  </style>
</head>
<body>
  <h1>Keepalive 日志</h1>
  <div class="meta">共 ${rows.length} 条 | <span class="controls"><a href="/logs?format=json">JSON</a> <a href="/">返回首页</a></span></div>
  <table>
    <thead><tr><th>时间</th><th>级别</th><th>内容</th></tr></thead>
    <tbody>${items}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function queryLogs(params) {
  // 支持的查询参数：q（关键词），level（INFO/WARN/ERROR），limit（默认100），since（ISO时间）
  const q = (params.get('q') || '').toLowerCase();
  const level = (params.get('level') || '').toUpperCase();
  const limit = Math.max(1, Math.min(500, parseInt(params.get('limit') || '100', 10)));
  const since = params.get('since');
  const sinceTs = since ? Date.parse(since) : 0;

  const filtered = logs.filter(l => {
    if (level && l.level !== level) return false;
    if (sinceTs && Date.parse(l.ts) < sinceTs) return false;
    if (q && !(l.msg || '').toLowerCase().includes(q)) return false;
    return true;
  });
  return filtered.slice(-limit);
}

export default {
  async fetch(request, env, ctx) {
    // 读取环境变量
    DATABRICKS_TOKEN = env.DATABRICKS_TOKEN || DATABRICKS_TOKEN;

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/') {
        // 首页：展示当前状态
        const status = [];
        for (const app of MONITORED_APPS) {
          const healthy = await checkAppUrl(app.url);
          status.push({ app: app.name, url: app.url, healthy, type: app.type });
        }
        const html = generateStatusPage(status);
        return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
      }

      if (path === '/start') {
        ctx.waitUntil(monitorAllApps('manual').then(res => log.info(`[manual] 启动结果 ${JSON.stringify(res).slice(0,200)}`)));
        return json({ ok: true, msg: '手动触发保活检查已启动' });
      }

      if (path === '/status') {
        const status = [];
        for (const app of MONITORED_APPS) {
          const healthy = await checkAppUrl(app.url);
          status.push({ app: app.name, url: app.url, healthy, type: app.type });
        }
        return json({ ok: true, apps: status, timestamp: new Date().toISOString() });
      }

      if (path === '/check') {
        return json({ ok: true, monitoredApps: MONITORED_APPS.map(a => ({ name: a.name, url: a.url, type: a.type })), timestamp: new Date().toISOString() });
      }

      if (path === '/logs') {
        const format = (url.searchParams.get('format') || 'json').toLowerCase();
        const rows = queryLogs(url.searchParams);
        if (format === 'html') {
          return new Response(renderLogsHTML(rows), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
        }
        return json({ ok: true, count: rows.length, logs: rows });
      }

      return new Response('Databricks App Keepalive Worker 运行中');
    } catch (err) {
      log.error(`[error] ${err.message}`);
      return json({ ok: false, error: String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    try {
      DATABRICKS_TOKEN = env.DATABRICKS_TOKEN || DATABRICKS_TOKEN;
      ctx.waitUntil(monitorAllApps('cron').then(res => log.info(`[cron] 结果 ${JSON.stringify(res).slice(0,200)}`)));
    } catch (err) {
      log.error(`[cron-error] ${err.message}`);
    }
  }
};

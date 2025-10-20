// Databricks Apps 自动保活 Cloudflare Worker
// 参照 _worker-keep.js 的风格实现，支持：
// - 定时检测 Databricks App 运行状态
// - 异常时自动启动
// - 提供首页状态页、手动启动、状态查询接口
// - 提供日志查询接口（/logs）

// =============== 必填环境变量（可在 Worker 环境变量中配置）================
// Databricks 工作区地址，例如：https://dbc-xxxxxx-xxxx.cloud.databricks.com
let DATABRICKS_HOST = "";
// Databricks PAT Token（个人访问令牌）
let DATABRICKS_TOKEN = "";

// Telegram 通知（可选）
let CHAT_ID = "";    // Telegram聊天CHAT_ID
let BOT_TOKEN = "";  // Telegram机器人TOKEN

// 监控的 Apps 列表（按名称）
// name: Databricks Apps 控制台中 App 的名称
// ui:   App 的访问页面（用于状态页展示），可选
const MONITORED_APPS = [
  { name: "databricksapp01", ui: "https://dbc-ba852385-a3cb.cloud.databricks.com/apps/databricksapp01" }
];

// 工具函数
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (o, c = 200) => new Response(JSON.stringify(o), {
  status: c,
  headers: { "content-type": "application/json" }
});

// Telegram 通知
async function sendTelegramMessage(message) {
  if (!CHAT_ID || !BOT_TOKEN) return;
  try {
    const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "Markdown" })
    });
  } catch (e) {
    console.log("[telegram-error]", e.message);
  }
}

// 时间格式化（上海时区）
function formatShanghaiTime(date) {
  const utcTime = date.getTime() + (date.getTimezoneOffset() * 60000);
  const shanghaiTime = new Date(utcTime + (8 * 60 * 60 * 1000));
  return (
    shanghaiTime.getFullYear() + '-' +
    String(shanghaiTime.getMonth() + 1).padStart(2, '0') + '-' +
    String(shanghaiTime.getDate()).padStart(2, '0') + ' ' +
    String(shanghaiTime.getHours()).padStart(2, '0') + ':' +
    String(shanghaiTime.getMinutes()).padStart(2, '0')
  );
}

// Databricks API 基础请求
async function dbRequest(path, method = "GET", payload = null) {
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN) {
    throw new Error("Databricks HOST 或 TOKEN 未配置");
  }
  const url = `${DATABRICKS_HOST}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${DATABRICKS_TOKEN}`,
      "content-type": "application/json"
    }
  };
  if (payload) init.body = JSON.stringify(payload);

  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} => ${res.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

// Databricks Apps API 封装（采用 /api/2.1/apps，若服务端版本不同可按需调整为 2.0）
const APPS_BASE = "/api/2.1/apps";

async function listApps() {
  // 兼容不同返回结构
  const data = await dbRequest(`${APPS_BASE}`, "GET");
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.apps)) return data.apps;
  if (Array.isArray(data.resources)) return data.resources;
  return [];
}

async function getAppByName(name) {
  // 先尝试列表匹配
  const apps = await listApps();
  let app = apps.find(a => a.name === name || a.app_name === name);
  if (app) return app;

  // 若支持按名称查询（某些版本可能有 /apps?name=xxx）
  try {
    const data = await dbRequest(`${APPS_BASE}?name=${encodeURIComponent(name)}`, "GET");
    if (data && (data.app || data.apps)) {
      return data.app || (Array.isArray(data.apps) ? data.apps[0] : null);
    }
  } catch (_) { /* 忽略，兼容不同版本 */ }

  return null;
}

async function getAppDetails(appId) {
  return dbRequest(`${APPS_BASE}/${encodeURIComponent(appId)}`, "GET");
}

async function startApp(appId) {
  // 兼容不同版本：有的为 /start，有的为 /restart
  try {
    return await dbRequest(`${APPS_BASE}/${encodeURIComponent(appId)}/start`, "POST");
  } catch (e) {
    // 回退尝试 restart
    return await dbRequest(`${APPS_BASE}/${encodeURIComponent(appId)}/restart`, "POST");
  }
}

async function getAppLogs(appId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.since) params.set("since", String(opts.since));
  if (opts.level) params.set("level", String(opts.level));

  // 兼容不同版本：优先尝试 /logs，不行再尝试 /events
  try {
    return await dbRequest(`${APPS_BASE}/${encodeURIComponent(appId)}/logs?${params.toString()}`);
  } catch (_) {
    return await dbRequest(`${APPS_BASE}/${encodeURIComponent(appId)}/events?${params.toString()}`);
  }
}

function normalizeState(app) {
  const s = (app.state || app.status || app.lifecycle_state || "").toUpperCase();
  if (s.includes("RUN")) return "RUNNING";
  if (s.includes("STOP")) return "STOPPED";
  if (s.includes("ERROR") || s.includes("FAIL")) return "ERROR";
  if (s.includes("PEND") || s.includes("START")) return "STARTING";
  return s || "UNKNOWN";
}

// 等待 App 运行
async function waitAppRunning(appId) {
  let delay = 2000;
  for (let i = 0; i < 15; i++) {
    const detail = await getAppDetails(appId);
    const ns = normalizeState(detail);
    console.log(`[apps] check ${appId} => ${ns}`);
    if (ns === "RUNNING") return;
    await sleep(delay);
    delay = Math.min(15000, Math.floor(delay * 1.6));
  }
  throw new Error("App 未在预期时间内进入 RUNNING 状态");
}

// 保活核心逻辑（按名称）
async function ensureDatabricksAppRunning(appConfig, reason = "unknown") {
  const { name } = appConfig;
  console.log(`[trigger] ${reason} ensure app ${name}`);

  const app = await getAppByName(name);
  if (!app) {
    throw new Error(`未找到名为 ${name} 的 Databricks App`);
  }
  const appId = app.app_id || app.id || app.appId;
  if (!appId) throw new Error(`App ${name} 未找到有效的 app_id`);

  const current = normalizeState(app);
  console.log(`[state] ${name} => ${current}`);
  if (current === "RUNNING") return { app: name, status: current };

  // 离线提醒
  await sendTelegramMessage(`⚠️ Databricks 应用已停止\n名称: ${name}\n时间: ${formatShanghaiTime(new Date())}\n正在尝试启动...`);

  // 启动
  await startApp(appId);
  await waitAppRunning(appId);

  // 再次确认
  const detail = await getAppDetails(appId);
  const finalState = normalizeState(detail);
  if (finalState === "RUNNING") {
    await sendTelegramMessage(`✅ Databricks 应用已成功启动\n名称: ${name}\n时间: ${formatShanghaiTime(new Date())}`);
    return { app: name, status: "started" };
  }
  await sendTelegramMessage(`❌ Databricks 应用启动失败或未就绪\n名称: ${name}\n时间: ${formatShanghaiTime(new Date())}`);
  return { app: name, status: "started_but_unhealthy" };
}

// 监控所有
async function monitorAllApps(reason = "unknown") {
  const out = [];
  for (const app of MONITORED_APPS) {
    try {
      const r = await ensureDatabricksAppRunning(app, reason);
      out.push(r);
    } catch (e) {
      console.log(`[app-error] ${app.name} => ${e.message}`);
      out.push({ app: app.name, status: "error", error: e.message });
    }
    await sleep(500);
  }
  return out;
}

// 首页 HTML
function generateStatusPage(apps) {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const sh = new Date(utc + (8 * 60 * 60 * 1000));
  const ts = `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')} ${String(sh.getHours()).padStart(2, '0')}:${String(sh.getMinutes()).padStart(2, '0')}`;
  const cards = apps.map(a => {
    const statusClass = a.healthy ? 'status-up' : 'status-down';
    const statusText = a.healthy ? '运行中' : '已停止';
    const logsLink = `/logs?app=${encodeURIComponent(a.app)}&limit=100`;
    return `
      <div class="status-card ${statusClass}">
        <div class="card-header">
          <h3>${a.app}</h3>
          <span class="status-indicator ${statusClass}">${statusText}</span>
        </div>
        <div class="card-body">
          ${a.ui ? `<p><strong>UI:</strong> <a href="${a.ui}" target="_blank">${a.ui}</a></p>` : ''}
          <p><a class="btn" href="${logsLink}" target="_blank">查看日志</a></p>
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
  <title>Databricks Apps 自动保活</title>
  <style>
    :root{--up:#4CAF50;--down:#F44336;--bg:#f5f5f5;--card:#fff;--radius:8px;--shadow:0 4px 6px rgba(0,0,0,.1)}
    body{font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;margin:0;background:var(--bg);color:#333}
    .container{max-width:1000px;margin:0 auto;padding:20px}
    header{padding:24px;background:#667eea;color:#fff;border-radius:var(--radius);box-shadow:var(--shadow);text-align:center;margin-bottom:20px}
    .status-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
    .status-card{background:var(--card);border-radius:var(--radius);box-shadow:var(--shadow)}
    .card-header{display:flex;justify-content:space-between;align-items:center;padding:16px;border-bottom:1px solid #eee}
    .card-body{padding:16px}
    .status-indicator{padding:4px 12px;border-radius:999px;font-weight:700}
    .status-up{background:rgba(76,175,80,.1);color:var(--up)}
    .status-down{background:rgba(244,67,54,.1);color:var(--down)}
    .controls{text-align:center;margin:16px 0}
    .btn{display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;border:none;padding:10px 18px;border-radius:8px}
    .last-updated{text-align:center;color:#666;margin-top:12px}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Databricks Apps 自动保活</h1>
      <div class="subtitle">监控 Apps 运行状态，异常自动启动</div>
    </header>
    <div class="controls">
      <a class="btn" href="/start" target="_blank">手动启动检测</a>
      <a class="btn" style="margin-left:8px" href="/status" target="_blank">查看状态 JSON</a>
    </div>
    <div class="status-grid">${cards}</div>
    <div class="last-updated">最后更新: ${ts}</div>
  </div>
</body>
</html>
  `;
}

export default {
  async fetch(request, env, ctx) {
    // 环境变量
    DATABRICKS_HOST = env.DATABRICKS_HOST || DATABRICKS_HOST;
    DATABRICKS_TOKEN = env.DATABRICKS_TOKEN || DATABRICKS_TOKEN;
    CHAT_ID = env.CHAT_ID || CHAT_ID;
    BOT_TOKEN = env.BOT_TOKEN || BOT_TOKEN;

    const url = new URL(request.url);

    try {
      if (url.pathname === "/") {
        // 获取所有 app 状态（通过 API）
        const appsStatus = [];
        for (const app of MONITORED_APPS) {
          try {
            const found = await getAppByName(app.name);
            const state = found ? normalizeState(found) : "NOT_FOUND";
            appsStatus.push({ app: app.name, healthy: state === "RUNNING", state, ui: app.ui || null });
          } catch (e) {
            appsStatus.push({ app: app.name, healthy: false, state: "ERROR", error: e.message, ui: app.ui || null });
          }
        }
        const html = generateStatusPage(appsStatus);
        return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
      }

      if (url.pathname === "/start") {
        ctx.waitUntil(monitorAllApps("manual").then(r => console.log("manual", r)));
        return json({ ok: true, msg: "已触发手动检测与启动" });
      }

      if (url.pathname === "/status") {
        const out = [];
        for (const app of MONITORED_APPS) {
          try {
            const found = await getAppByName(app.name);
            const detail = found ? await getAppDetails(found.app_id || found.id || found.appId) : null;
            const state = detail ? normalizeState(detail) : (found ? normalizeState(found) : "NOT_FOUND");
            out.push({ app: app.name, state, detail });
          } catch (e) {
            out.push({ app: app.name, state: "ERROR", error: e.message });
          }
        }
        return json({ ok: true, apps: out, timestamp: new Date().toISOString() });
      }

      if (url.pathname === "/logs") {
        const appName = url.searchParams.get("app");
        const limit = Number(url.searchParams.get("limit") || "200");
        const since = url.searchParams.get("since") || "";
        const level = url.searchParams.get("level") || "";
        if (!appName) return json({ ok: false, error: "missing app param" }, 400);

        const app = await getAppByName(appName);
        if (!app) return json({ ok: false, error: `app ${appName} not found` }, 404);
        const appId = app.app_id || app.id || app.appId;
        const logs = await getAppLogs(appId, { limit, since, level });
        return json({ ok: true, app: appName, logs });
      }

      return new Response("Databricks Apps Keepalive Worker 运行中", { status: 200 });
    } catch (e) {
      console.log("[error]", e.message);
      return json({ ok: false, error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    DATABRICKS_HOST = env.DATABRICKS_HOST || DATABRICKS_HOST;
    DATABRICKS_TOKEN = env.DATABRICKS_TOKEN || DATABRICKS_TOKEN;
    CHAT_ID = env.CHAT_ID || CHAT_ID;
    BOT_TOKEN = env.BOT_TOKEN || BOT_TOKEN;

    try {
      ctx.waitUntil(monitorAllApps("cron").then(r => console.log("cron", r)));
    } catch (e) {
      console.log("[cron-error]", e.message);
    }
  }
};

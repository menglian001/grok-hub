/* Grok Hub 控制台。前端布局脱胎于 u1s12api dashboard，数据层为 Grok 注册场景重写：
   - /api/stats            账号总数/活跃/今日入库/已上传 grok2api
   - /api/accounts         号池管理（email/SSO/额度 7次每日/风控状态/上传状态）
   - /api/grok2api/upload  ★ 上传账号到 grok2api（只调其管理 API，不改 grok2api）
   - /api/register/*       注册机（spawn grok-register-main，日志回显，自动入池）
   - /api/settings         grok2api 连接配置 + 探活间隔
   - /api/alerts           告警（额度用尽/探活失败/上传结果）
*/
(function () {
  'use strict';

  var state = {
    stats: {}, accounts: [], logs: [],
    analytics: {}, settings: {}, settingsDefs: [], apiKey: '',
    alerts: [], alertSummary: {},
    days: 14, paused: false, filter: 'ALL', query: '', poolQuery: '', poolStatus: 'ALL', alertTab: 'open'
  };
  var charts = {};
  var providerModels = [];

  function loadFragment(path) {
    return fetch('/dashboard/' + path).then(function (r) {
      if (!r.ok) throw new Error('无法加载前端片段：' + path);
      return r.text();
    });
  }

  function bootstrapDashboard() {
    var names = ['fragments/topnav.html', 'fragments/sidebar.html', 'fragments/page-overview.html', 'fragments/page-detect.html', 'fragments/page-alerts.html', 'fragments/page-settings.html'];
    return Promise.all(names.map(loadFragment)).then(function (parts) {
      var app = document.getElementById('dashboard-app');
      if (!app) return;
      app.innerHTML = parts[0] + '<div class="pt-16 flex">' + parts[1] + '<main class="ml-60 flex-1 min-h-[calc(100vh-4rem)]">' + parts.slice(2, 6).join('\n') + '</main></div>';
    });
  }

  function key() { return localStorage.getItem('grok_hub_token') || ''; }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]; }); }
  function fmt(value) { return Number(value || 0).toLocaleString('zh-CN'); }
  function ago(value) {
    if (!value) return '-';
    var n = Date.now() - new Date(value).getTime();
    if (!isFinite(n) || n < 0) return '刚刚';
    if (n < 60000) return Math.floor(n / 1000) + ' 秒前';
    if (n < 3600000) return Math.floor(n / 60000) + ' 分钟前';
    if (n < 86400000) return Math.floor(n / 3600000) + ' 小时前';
    return Math.floor(n / 86400000) + ' 天前';
  }
  function fmtMs(ms) {
    var v = Number(ms || 0);
    if (v <= 0) return '-';
    if (v >= 1000) return (v / 1000).toFixed(2) + 's';
    return Math.round(v) + 'ms';
  }
  function fmtCost(c) {
    var v = Number(c || 0);
    return '$' + (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toFixed(4));
  }
  function pct(r) { return (Number(r || 0) * 100).toFixed(2) + '%'; }
  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'Authorization': 'Bearer ' + key(), 'Content-Type': 'application/json' }, options.headers || {});
    options.credentials = 'same-origin'; // 带上面板会话 cookie
    return fetch(path, options).then(function (r) {
      return r.text().then(function (text) {
        var data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
        // 会话过期或未登录 → 回登录页
        if (r.status === 401 && data.error && data.error.type === 'unauthorized') {
          location.replace('/login.html'); throw new Error('会话已过期');
        }
        if (!r.ok) throw new Error(data.error && data.error.message || data.message || 'HTTP ' + r.status);
        return data;
      });
    });
  }
  function toast(message) { if (typeof window.showToast === 'function') window.showToast(message); else window.alert(message); }

  window.doLogout = function () {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function () { location.replace('/login.html'); })
      .catch(function () { location.replace('/login.html'); });
  };
  function setText(selector, value) { var el = document.querySelector(selector); if (el) el.textContent = value; }
  function download(name, content) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function sourceName(src) {
    return { 'grok-register': '注册机', 'manual': '手动导入', 'local': '本地导入' }[src] || (src ? src : 'grok');
  }
  function todayCalls(accountId) { return (state.analytics.todayCalls || {})[accountId] || 0; }

  window.showToast = function (message) {
    var el = document.getElementById('toast');
    if (!el) { window.alert(message); return; }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(window.__postmanToastTimer);
    window.__postmanToastTimer = setTimeout(function () { el.classList.remove('show'); }, 2500);
  };
  window.closeDrawer = function () {
    var drawer = document.getElementById('drawer');
    var backdrop = document.getElementById('drawerBackdrop');
    if (drawer) drawer.classList.remove('show');
    if (backdrop) backdrop.classList.remove('show');
  };
  window.switchPage = function (page) {
    document.querySelectorAll('.page').forEach(function (el) { el.classList.toggle('active', el.id === 'page-' + page); });
    document.querySelectorAll('.sidebar-item[data-page]').forEach(function (el) { el.classList.toggle('active', el.dataset.page === page); });
    var names = { overview:'概览', detect:'注册机', alerts:'告警中心', settings:'系统设置' };
    setText('#crumb', names[page] || page);
    if (page === 'detect') renderDetectLogs();
    if (page === 'alerts') renderAlertsReal();
    if (page === 'settings') renderSettingsReal();
  };

  function statusInfo(status) {
    if (status === 'active') return { dot: 'dot-online', tag: 'tag-green', label: '在线' };
    if (status === 'exhausted') return { dot: 'dot-idle', tag: 'tag-amber', label: '额度耗尽' };
    if (status === 'error') return { dot: 'dot-error', tag: 'tag-red', label: '异常' };
    return { dot: 'dot-offline', tag: 'tag-gray', label: status || '停用' };
  }

  /* 面板自举：/api/settings 不需要令牌，从它拿到控制台自用令牌后存进
     localStorage，后续打 /v1/* 的连通性测试才带得上 Bearer。 */
  function ensureKey() {
    if (key()) return Promise.resolve();
    return fetch('/api/settings', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.replace('/login.html'); return null; }
      return r.json();
    }).then(function (d) {
      if (d && d.apiKey) localStorage.setItem('grok_hub_token', d.apiKey);
    }).catch(function () { /* 拿不到就照常走，后续请求会报错提示 */ });
  }

  function loadAll() {
    return ensureKey().then(function () { return Promise.all([
      api('/api/stats'),
      api('/api/settings'),
      api('/api/alerts')
    ]); }).then(function (all) {
      state.stats = all[0] || {};
      state.logs = [];
      state.analytics = { todayCalls: {} };
      state.settings = (all[1] && (all[1].values || all[1].settings)) || {};
      state.settingsDefs = (all[1] && all[1].defs) || [];
      state.grok2api = (all[1] && all[1].grok2api) || {};
      state.alerts = (all[2] && all[2].data) || [];
      state.alertSummary = (all[2] && all[2].summary) || {};
      state.models = [];
      state.gateway = { running: false };
      renderAll();
    }).catch(function (err) { toast('加载数据失败：' + err.message); });
  }

  function renderAll() {
    renderRealData(); renderAlertsReal(); renderSettingsReal(); renderOverviewActivity(); renderSidebarBadges();
  }

  function renderSidebarBadges() {
    var lb = document.querySelector('.sidebar-item[data-page="logs"] .badge');
    if (lb) lb.textContent = state.logs.length;
    var pb = document.querySelector('.sidebar-item[data-page="pools"] .badge');
    if (pb) pb.textContent = state.accounts.length;
    var ab = document.querySelector('.sidebar-item[data-page="alerts"] .badge');
    if (ab) ab.textContent = state.alertSummary.open || 0;
    var nd = document.querySelector('.notif-dot');
    if (nd) nd.style.display = (state.alertSummary.open || 0) > 0 ? '' : 'none';
  }

  function renderRealData() {
    var s = state.stats;
    setText('body .hero-title em', fmt(s.registeredTotal));
    var kpis = document.querySelectorAll('#page-overview .kpi-value');
    if (kpis[0]) kpis[0].textContent = fmt(s.registeredToday); // 今日注册
    if (kpis[1]) kpis[1].innerHTML = fmt(s.registeredTotal) + '<span class="text-[20px]" style="color:var(--muted)"> 个</span>';
    if (kpis[2]) kpis[2].innerHTML = fmt(s.uploadedTotal) + '<span class="text-[20px]" style="color:var(--muted)"> 个</span>';
    if (kpis[3]) kpis[3].innerHTML = fmt(s.pendingUpload) + '<span class="text-[20px]" style="color:var(--muted)"> 个</span>';
    setText('#kpiErrors', '已上传 ' + fmt(s.uploadedTotal) + ' · 本地滞留 ' + fmt(s.pendingUpload));
    var usage = document.getElementById('sidebarUsage');
    if (usage) usage.innerHTML = '<div class="flex items-center justify-between mb-3"><div class="text-[11px] font-semibold tracking-wider uppercase" style="color: var(--muted);">累计调用</div><span class="text-[11px] font-mono" style="color: var(--accent);">'+fmt(s.totalRequests)+'</span></div><div class="progress mb-3"><div class="progress-fill" style="width: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2));"></div></div><div class="flex items-baseline gap-1.5 mb-1"><span class="font-display text-[22px] font-medium leading-none">'+fmt(s.totalRequests)+'</span><span class="text-[11px]" style="color: var(--muted);">次请求</span></div><div class="text-[11px]" style="color: var(--muted);">成功 '+fmt(s.successRequests)+' · 失败 '+fmt(s.errorRequests)+' · Token '+fmt(s.totalTokens)+'</div>';
    setText('#sysHost', window.location.host);
    setText('#sysAccounts', fmt(s.totalAccounts));
    setText('#sysActive', fmt(s.activeAccounts));
    var tag = document.querySelector('#page-overview .hero-title + *');
    var ok = document.querySelector('#page-overview .tag-green');
    if (ok) ok.textContent = '系统正常';
  }

  // ─── 号池管理 ───────────────────────────────────────────────
  function renderPoolsReal() {
    var body = document.getElementById('poolsBody'); if (!body) return;
    var list = state.accounts.filter(function (a) {
      var st = !a.enabled ? 'disabled' : (a.status === 'active' ? 'active' : a.status === 'exhausted' ? 'exhausted' : 'error');
      if (state.poolStatus !== 'ALL' && st !== state.poolStatus) return false;
      if (state.poolQuery && (a.email + ' ' + (a.source || '')).toLowerCase().indexOf(state.poolQuery.toLowerCase()) < 0) return false;
      return true;
    });
    body.innerHTML = list.length ? list.map(function (a) {
      var s = statusInfo(a.status), total = Number(a.quotaLimit || 0), remain = Number(a.quotaRemaining || 0);
      var pct = total > 0 ? Math.max(0, Math.min(100, (remain / total) * 100)) : 0;
      var color = pct < 20 ? 'var(--danger)' : pct < 50 ? 'var(--warning)' : 'var(--accent)';
      var upBtn = a._uploadedAt
        ? '<button class="btn btn-ghost" style="height:28px;padding:4px 8px;font-size:11px;color:var(--success)" title="已上传 grok2api · ' + esc(a._uploadedAt || '') + '" onclick="uploadAccount('+a.id+')">已传✓</button>'
        : '<button class="btn btn-ghost" style="height:28px;padding:4px 8px;font-size:11px;color:var(--accent)" title="上传 SSO 到 grok2api'+(a._uploadMessage ? '（上次：'+esc(a._uploadMessage)+'）' : '')+'" onclick="uploadAccount('+a.id+')">上传</button>';
      return '<tr><td><input type="checkbox"></td><td><div class="flex items-center gap-3"><span class="dot '+s.dot+'"></span><div><div class="font-mono font-semibold">'+esc(a.email)+'</div><div class="text-[11px]" style="color:var(--muted)">ID '+a.id+' · SSO '+esc(a._ssoPreview || '…')+'</div></div></div></td><td><span class="tag tag-gray">'+esc(sourceName(a.source))+'</span></td><td><span class="tag '+s.tag+'">'+s.label+'</span></td><td>'+esc(a.plan || 'free')+'</td><td><div class="w-32"><div class="flex items-center justify-between text-[11px] mb-1"><span class="font-mono">'+fmt(remain)+' / '+fmt(total)+'</span><span class="font-mono" style="color:'+color+'">'+(total ? pct.toFixed(1)+'%' : '-')+'</span></div><div class="progress" style="height:4px"><div class="progress-fill" style="width:'+pct+'%;background:'+color+'"></div></div></div></td><td class="font-mono">'+fmt(todayCalls(a.id))+'</td><td class="text-[12px]" style="color:var(--fg-2)">'+ago(a.lastUsedAt)+'</td><td><div class="flex items-center gap-1">'+upBtn+'<button class="btn btn-ghost" style="height:28px;padding:4px 8px;font-size:11px" onclick="toggleAccount('+a.id+','+(!a.enabled)+')">'+(a.enabled?'停用':'启用')+'</button><button class="btn btn-ghost" style="height:28px;padding:4px 8px;font-size:11px;color:var(--danger)" onclick="deleteAccount('+a.id+')">删除</button></div></td></tr>';
    }).join('') : '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--muted)">'+(state.accounts.length ? '没有匹配的账号' : '暂无账号：点「导入账号」贴 SSO，或用注册机批量注册')+'</td></tr>';
    var counts = { active:0, exhausted:0, error:0, disabled:0 };
    state.accounts.forEach(function (a) { if (!a.enabled) counts.disabled++; else if (counts[a.status] !== undefined) counts[a.status]++; });
    var rings = document.querySelectorAll('#page-pools .ring-stat .value');
    if (rings[0]) rings[0].textContent = counts.active; if (rings[1]) rings[1].textContent = counts.exhausted; if (rings[2]) rings[2].textContent = counts.error; if (rings[3]) rings[3].textContent = counts.disabled;
    var cnt = document.getElementById('poolCount');
    if (cnt) cnt.textContent = '共 ' + state.accounts.length + ' 条';
  }

  // ─── 额度管理（真实账号额度 + 配置规则读写）─────────────────
  function renderQuotaReal() {
    var total = state.accounts.reduce(function (n,a) { return n + Number(a.quotaLimit || 0); }, 0);
    var remain = state.accounts.reduce(function (n,a) { return n + Number(a.quotaRemaining || 0); }, 0);
    var used = Math.max(0, total - remain), usedPct = total ? used / total * 100 : 0;
    var nums = document.querySelectorAll('#page-quota .font-display');
    if (nums[0]) nums[0].textContent = fmt(total);
    if (nums[1]) nums[1].textContent = fmt(used);
    if (nums[2]) nums[2].textContent = fmt(remain);
    var dayOfMonth = new Date().getDate();
    if (nums[3]) nums[3].textContent = total ? fmt(Math.round(used / Math.max(1, dayOfMonth))) : '0';
    if (nums[4]) nums[4].textContent = total ? fmt(Math.round(used + (used / Math.max(1, dayOfMonth)) * Math.max(0, 30 - dayOfMonth))) : '0';
    var bar = document.querySelector('#page-quota .progress-fill');
    if (bar) bar.style.width = usedPct.toFixed(1) + '%';
    var progressText = document.getElementById('quotaProgressText');
    if (progressText) progressText.textContent = fmt(used);
    var progressTotal = document.getElementById('quotaProgressTotal');
    if (progressTotal) progressTotal.textContent = fmt(total);
    var channels = document.getElementById('quotaChannels');
    if (channels) channels.innerHTML = (state.analytics.channels && state.analytics.channels.length ? state.analytics.channels.map(function (c) {
      var cUsed = c.calls, cTotal = c.calls; // 调用次数即渠道消耗
      var cp = Math.min(100, c.calls && total ? (c.calls / Math.max(1, total) * 100) : 0);
      return '<div><div class="flex justify-between mb-1"><span>'+esc(c.channel)+'</span><span class="font-mono">'+fmt(c.calls)+' 次调用 · '+fmtCost(c.cost)+'</span></div><div class="progress"><div class="progress-fill" style="width:'+cp+'%;background:var(--accent)"></div></div><div class="text-[11px] mt-1" style="color:var(--muted)">成功率 '+pct(c.successRate)+' · 平均延迟 '+fmtMs(c.avgLatencyMs)+'</div></div>';
    }).join('') : '<div class="text-[12px]" style="color:var(--muted)">暂无调用数据，渠道配额按实际调用统计。</div>');
    var projects = document.getElementById('quotaProjects');
    if (projects) projects.innerHTML = state.accounts.map(function (a) {
      var ql = Number(a.quotaLimit || 0), qr = Number(a.quotaRemaining || 0);
      var ap = ql > 0 ? Math.min(100, Math.max(0, (ql - qr) / ql * 100)) : 0;
      return '<div><div class="flex justify-between mb-1"><span class="font-mono">'+esc(a.email)+'</span><span class="font-mono">'+fmt(ql - qr)+' / '+fmt(ql)+'</span></div><div class="progress"><div class="progress-fill" style="width:'+ap+'%;background:var(--accent-2)"></div></div></div>';
    }).join('') || '<div class="text-[12px]" style="color:var(--muted)">暂无账号</div>';
    var near = document.getElementById('quotaNear');
    if (near) near.textContent = usedPct >= 90 ? '已用 ' + usedPct.toFixed(1) + '% · 注意' : usedPct >= 70 ? '已用 ' + usedPct.toFixed(1) + '%' : '已用 ' + usedPct.toFixed(1) + '% · 充足';
    var reset = document.getElementById('quotaReset');
    if (reset) reset.textContent = '按账号 grok.com 每日次数统计（rate-limits 探活）';
    var rules = document.getElementById('quotaRules');
    if (rules) {
      var th = state.settings['alert_quota'] || '0.2';
      var quotaAlerts = state.alerts.filter(function (a) { return a.alertType === 'low_quota' || a.alertType === 'quota_exhausted'; });
      var thPct = (Number(th) * 100).toFixed(0);
      var rows = [
        { name: '额度不足告警', cond: '今日剩余次数偏低', notify: '面板告警中心', status: '已启用', recent: quotaAlerts.filter(function(a){return a.alertType==='low_quota';})[0] },
        { name: '额度耗尽告警', cond: 'rate-limits 探活返回剩余 0 次', notify: '面板告警中心', status: '已启用', recent: quotaAlerts.filter(function(a){return a.alertType==='quota_exhausted';})[0] }
      ];
      rules.innerHTML = rows.map(function (row) {
        return '<tr><td class="font-semibold">'+row.name+'</td><td>'+row.cond+'</td><td>'+row.notify+'</td><td><span class="tag tag-green">'+row.status+'</span></td><td class="font-mono text-[12px]">'+(row.recent ? ago(row.recent.createdAt) : '—')+'</td><td><span class="text-[12px]" style="color:var(--muted)">阈值可在系统设置修改</span></td></tr>';
      }).join('');
    }
  }

  // ─── 统计分析页 ─────────────────────────────────────────────
  function renderStatsReal() {
    var s = state.stats;
    var values = document.querySelectorAll('#page-stats .font-display');
    if (values[0]) values[0].textContent = fmt(s.totalRequests);
    if (values[1]) values[1].textContent = fmt(s.totalTokens);
    if (values[2]) values[2].textContent = fmtCost(s.estimatedCost);
    if (values[3]) values[3].textContent = fmtMs(s.p95LatencyMs);
    if (values[4]) values[4].textContent = pct(s.errorRate);
    setText('#statCostNote', '按模型单价估算');
    setText('#statP95Note', '来自真实请求日志');
    setText('#statErrNote', (s.totalRequests ? (s.successRequests / s.totalRequests * 100).toFixed(2) : '0') + '% 成功');
  }

  function renderTopAccounts() {
    var top = document.getElementById('topAccountsBody');
    if (!top) return;
    var list = state.analytics.topAccounts || [];
    top.innerHTML = list.map(function (a, i) {
      return '<tr><td>'+ (i + 1) +'</td><td class="font-mono">'+esc(a.email)+'</td><td><span class="tag tag-gray">'+esc(sourceName(a.source))+'</span></td><td class="font-mono">'+fmt(a.calls)+'</td><td class="font-mono">'+fmt(a.tokens)+'</td><td class="font-mono">'+fmtMs(a.avgLatencyMs)+'</td><td><span class="font-mono" style="color:'+(a.successRate >= 0.9 ? 'var(--success)' : a.successRate >= 0.7 ? 'var(--warning)' : 'var(--danger)')+'">'+pct(a.successRate)+'</span></td><td><span class="font-mono font-semibold" style="color:var(--accent)">'+Number(a.score || 0).toFixed(1)+'</span></td></tr>';
    }).join('') || '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted)">暂无账号数据</td></tr>';
  }

  function renderOverviewActivity() {
    var timeline = document.querySelector('#page-overview .timeline-item') && document.querySelector('#page-overview .timeline-item').parentElement;
    if (!timeline) return;
    timeline.innerHTML = state.logs.slice(0, 5).map(function (l) {
      var label = l.status === 'success' ? '请求成功' : '请求失败';
      var detail = l.model || l.errorMessage || '未知请求';
      return '<div class="timeline-item"><div class="flex items-start justify-between gap-3"><div><div class="text-[13px] font-semibold">'+label+' <span class="font-mono" style="color:var(--accent)">'+esc(detail)+'</span></div><div class="text-[12px] mt-0.5" style="color:var(--fg-2)">账号 #'+(l.accountId || '-')+' · '+(l.totalTokens || 0)+' tokens · '+(l.durationMs || 0)+'ms</div></div><span class="text-[11px] font-mono whitespace-nowrap" style="color:var(--muted)">'+ago(l.createdAt)+'</span></div></div>';
    }).join('') || '<div style="padding:20px;color:var(--muted)">暂无活动</div>';
  }

  // ─── 实时日志 ───────────────────────────────────────────────
  function renderLogsReal() {
    var stream = document.getElementById('logStream'); if (!stream) return;
    var rows = state.logs.filter(function (l) {
      var lv = l.status === 'success' ? 'SUCCESS' : 'ERROR';
      return (state.filter === 'ALL' || lv === state.filter) && (!state.query || (l.model || '').toLowerCase().indexOf(state.query.toLowerCase()) >= 0 || (l.errorMessage || '').toLowerCase().indexOf(state.query.toLowerCase()) >= 0);
    });
    var count = document.getElementById('logCount');
    if (count) count.textContent = rows.length + ' 条';
    stream.innerHTML = rows.map(function (l) { var level = l.status === 'success' ? 'SUCCESS' : 'ERROR'; return '<div class="log-line"><span class="log-time">'+new Date(l.createdAt).toLocaleTimeString()+'</span><span class="log-level '+level+'">'+level+'</span><span class="log-msg" style="flex:1">'+esc((l.model || '-')+' · '+(l.errorMessage || (l.totalTokens || 0)+' tokens · '+(l.durationMs || 0)+'ms'))+'</span></div>'; }).join('') || '<div style="padding:30px;color:var(--muted);text-align:center">暂无请求日志</div>';
  }

  // ─── 告警中心（真实告警记录）───────────────────────────────
  function renderAlertsReal() {
    var body = document.getElementById('alertsBody'); if (!body) return;
    var sum = state.alertSummary || {};
    var k = document.querySelectorAll('#page-alerts .font-display');
    if (k[0]) k[0].textContent = sum.severe || 0;
    if (k[1]) k[1].textContent = sum.warning || 0;
    if (k[2]) k[2].textContent = sum.info || 0;
    if (k[3]) k[3].textContent = sum.mttrMin ? Math.round(sum.mttrMin) + 'm' : '—';
    var list = state.alerts.filter(function (a) { return state.alertTab === 'all' || a.status === 'open'; });
    body.innerHTML = list.map(function (a) {
      var levelTag = a.level === 'severe' ? 'tag-red' : a.level === 'info' ? 'tag-blue' : 'tag-amber';
      var levelName = a.level === 'severe' ? '严重' : a.level === 'info' ? '信息' : '警告';
      var btn = a.status === 'open' ? '<button class="btn btn-ghost" onclick="resolveAlert('+a.id+')">处理</button>' : '<span class="tag tag-gray">已解决</span>';
      return '<tr><td><span class="tag '+levelTag+'">'+levelName+'</span></td><td><b>'+esc(a.title)+'</b><div class="text-[12px] mt-0.5" style="color:var(--fg-2)">'+esc(a.message)+'</div></td><td class="font-mono text-[12px]">'+(a.sourceType === 'account' && a.sourceId ? 'account #'+a.sourceId : 'system')+'</td><td class="text-[12px]">'+ago(a.createdAt)+'</td><td>'+(a.status === 'open' ? '<span class="tag tag-amber">未处理</span>' : '<span class="tag tag-green">已解决</span>')+'</td><td>'+btn+'</td></tr>';
    }).join('') || '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--muted)">暂无告警</td></tr>';
    var openTab = document.querySelector('#page-alerts .tab.active');
    var tabs = document.querySelectorAll('#page-alerts .tab');
    if (tabs[0]) tabs[0].classList.toggle('active', state.alertTab === 'open');
    if (tabs[1]) tabs[1].classList.toggle('active', state.alertTab === 'all');
    var resolveAllBtn = document.getElementById('resolveAllBtn');
    if (resolveAllBtn) resolveAllBtn.style.display = (sum.open || 0) > 0 ? '' : 'none';
  }

  // ─── 路由策略（真实配置读写）────────────────────────────────
  function renderRoutingReal() {
    var el = document.getElementById('routingWeights'); if (!el) return;
    var active = state.accounts.filter(function (a) { return a.enabled && a.status === 'active'; }).length;
    var channels = state.analytics.channels || [];
    var maxCalls = Math.max.apply(null, channels.map(function (c) { return c.calls; }).concat([1]));
    el.innerHTML = (channels.length ? channels.map(function (c) {
      var w = c.calls ? (c.calls / maxCalls * 100) : 0;
      return '<div class="flex items-center justify-between"><span>'+esc(c.channel)+'</span><span class="font-mono">'+fmt(c.calls)+' 次调用 · '+pct(c.successRate)+'</span></div><div class="progress"><div class="progress-fill" style="width:'+w+'%;background:var(--accent)"></div></div>';
    }).join('') : '<div class="text-[12px]" style="color:var(--muted)">暂无调用数据</div>') + '<p class="text-[12px] mt-3" style="color:var(--muted)">当前 ' + active + ' 个活跃账号 · 策略：轮询 + 最少在途，失败自动切换（重试 ' + (state.settings['retry_count'] || '3') + ' 次）。</p>';
    var retry = document.getElementById('routingRetry');
    if (retry) retry.value = state.settings['retry_count'] || '3';
    var failover = document.getElementById('routingFailover');
    if (failover) failover.checked = (state.settings['failover_enabled'] === 'false') ? false : true;
    var fvOn = (state.settings['failover_enabled'] === 'false') ? false : true;
    var rc = state.settings['retry_count'] || '3';
    var rTag = document.getElementById('fvRetryTag');
    if (rTag) { rTag.textContent = fvOn ? '重试 ' + rc + ' 次' : '不重试'; rTag.className = 'tag ' + (fvOn ? 'tag-green' : 'tag-gray'); }
    var rTitle = document.getElementById('fvRetryTitle');
    if (rTitle) rTitle.textContent = '请求重试 ' + rc + ' 次';
  }

  // ─── 系统设置（真实读写）────────────────────────────────────
  function renderSettingsReal() {
    var modelBox = document.getElementById('settingsModels');
    if (modelBox) modelBox.innerHTML = providerModels.map(function (m) { return '<span class="tag tag-blue font-mono">'+esc(m)+'</span>'; }).join(' ');
    var host = document.getElementById('settingsHost');
    if (host) host.textContent = window.location.protocol + '//' + window.location.host;
    var host2 = document.getElementById('settingsHost2');
    if (host2) host2.textContent = window.location.protocol + '//' + window.location.host;
    var auth = document.getElementById('settingsApiKey');
    if (auth) auth.textContent = state.apiKey || '未设置';
    var form = document.getElementById('settingsForm');
    if (form) {
      // 表单只构建一次；之后只同步「未被聚焦」字段的值——避免 5s 轮询重建表单冲掉正在编辑的输入
      if (!form.dataset.built) {
        form.dataset.built = '1';
        form.innerHTML = state.settingsDefs.filter(function (d) { return d.key.indexOf('proxy_') !== 0; }).map(function (d) {
          var val = state.settings[d.key] != null ? state.settings[d.key] : d.default;
          var ph = d.key === 'api_key' ? '留空 = 使用 API_KEY 环境变量' : '';
          var itype = /password/i.test(d.key) ? 'password' : 'text';
          var input = d.type === 'bool'
            ? '<label class="switch"><input type="checkbox" data-key="'+d.key+'" '+(val === 'true' ? 'checked' : '')+'><div class="slider"></div></label>'
            : '<input type="'+itype+'" class="input font-mono" data-key="'+d.key+'" value="'+esc(val)+'" placeholder="'+ph+'" style="max-width:220px">';
          return '<div class="flex items-center justify-between p-3 rounded-lg" style="background:var(--bg)"><div><div class="text-[13px] font-semibold">'+esc(d.label)+'</div><div class="text-[12px] mt-0.5" style="color:var(--fg-2)">'+esc(d.description)+'</div></div>'+input+'</div>';
        }).join('') + '<div class="pt-2"><button class="btn btn-primary" onclick="saveSettings()">保存配置</button></div>';
      }
      form.querySelectorAll('[data-key]').forEach(function (el) {
        if (document.activeElement === el) return; // 正在编辑的字段不被轮询覆盖
        var val = state.settings[el.dataset.key] != null ? state.settings[el.dataset.key] : '';
        if (el.type === 'checkbox') el.checked = val === 'true';
        else if (el.value !== val) el.value = val;
      });
    }
    renderProxySettings();
  }

  // ─── 出站代理（专属卡片：URL + 认证 + 开关 + 快速测试）──────────
  function renderProxySettings() {
    var on = document.getElementById('proxyEnabled');
    if (!on) return;
    on.checked = state.settings['proxy_enabled'] === 'true';
    var url = document.getElementById('proxyUrl');
    var user = document.getElementById('proxyUsername');
    var pass = document.getElementById('proxyPassword');
    if (document.activeElement !== url && url && url.value !== (state.settings['proxy_url'] || '')) url.value = state.settings['proxy_url'] || '';
    if (document.activeElement !== user && user && user.value !== (state.settings['proxy_username'] || '')) user.value = state.settings['proxy_username'] || '';
    if (document.activeElement !== pass && pass && pass.value !== (state.settings['proxy_password'] || '')) pass.value = state.settings['proxy_password'] || '';
  }
  window.saveProxySettings = function () {
    var settings = {
      proxy_enabled: (document.getElementById('proxyEnabled') || {}).checked ? 'true' : 'false',
      proxy_url: (document.getElementById('proxyUrl') || {}).value || '',
      proxy_username: (document.getElementById('proxyUsername') || {}).value || '',
      proxy_password: (document.getElementById('proxyPassword') || {}).value || ''
    };
    api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: settings }) }).then(function () {
      toast('出站代理配置已保存并立即生效');
      return loadAll();
    }).catch(function (e) { toast('保存失败：' + e.message); });
  };
  window.testProxy = function () {
    var pre = document.getElementById('proxyTestResult');
    var btn = document.getElementById('proxyTestBtn');
    if (pre) { pre.style.display = 'block'; pre.style.color = 'var(--fg-2)'; pre.textContent = '正在经代理访问 https://www.google.com …（最多 20 秒）'; }
    if (btn) { btn.disabled = true; btn.style.opacity = 0.6; }
    var body = {
      url: (document.getElementById('proxyUrl') || {}).value || '',
      username: (document.getElementById('proxyUsername') || {}).value || '',
      password: (document.getElementById('proxyPassword') || {}).value || ''
    };
    api('/api/proxy/test', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      if (!pre) return;
      pre.style.display = 'block';
      if (r.ok) {
        pre.style.color = 'var(--success)';
        pre.textContent = '✓ 代理可用：' + r.proxyUrl + '\n目标 ' + r.target + ' 返回 ' + r.status + '，耗时 ' + r.latencyMs + 'ms' + (r.exitIp ? '\n出口 IP：' + r.exitIp : '');
      } else {
        pre.style.color = 'var(--danger)';
        pre.textContent = '✗ 代理不可用：' + (r.error || ('HTTP ' + (r.status || '?'))) + '\n代理 ' + r.proxyUrl + '，耗时 ' + r.latencyMs + 'ms';
      }
    }).catch(function (e) {
      if (pre) { pre.style.display = 'block'; pre.style.color = 'var(--danger)'; pre.textContent = '测试失败：' + e.message; }
    }).then(function () {
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    });
  };

  // ─── 模型列表（真实 /v1/models + 测试对话）──────────────────
  function renderModelsReal() {
    var body = document.getElementById('modelsBody'); if (!body) return;
    var models = state.models || [];
    body.innerHTML = models.length ? models.map(function (m) {
      var id = m.id || '';
      var ctx = m.context_window ? m.context_window.toLocaleString('zh-CN') : '-';
      var out = m.max_output ? m.max_output.toLocaleString('zh-CN') : '-';
      var thinking = m.thinking ? '<span class="tag tag-blue">支持</span>' : '<span class="tag tag-gray">—</span>';
      return '<tr><td class="font-mono">'+esc(id)+'</td><td class="font-mono">'+ctx+'</td><td class="font-mono">'+out+'</td><td>'+thinking+'</td><td><div class="flex items-center gap-1"><button class="btn btn-ghost" style="height:28px;padding:4px 8px;font-size:11px" onclick="copyText(\''+id.replace(/'/g, '')+'\')">复制 ID</button><button class="btn btn-ghost" style="height:28px;padding:4px 8px;font-size:11px;color:var(--accent)" onclick="testModel(\''+id.replace(/'/g, '')+'\')">测试</button></div></td></tr>';
    }).join('') : '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--muted)">暂无模型数据</td></tr>';
  }

  function modelTestPrompt() {
    var el = document.getElementById('modelTestPrompt');
    var v = (el && el.value || '').trim();
    return v || 'hi';
  }
  function showModelTest(title, body, ok) {
    var pre = document.getElementById('modelTestResult'); if (!pre) return;
    pre.style.color = ok ? 'var(--fg-2)' : 'var(--danger)';
    pre.textContent = title + '\n' + body;
  }
  window.testModel = function (id) {
    var pre = document.getElementById('modelTestResult');
    if (pre) { pre.style.color = 'var(--fg-2)'; pre.textContent = '正在请求模型 ' + id + '（可能需数秒，失败会自动切号重试）…'; }
    var prompt = modelTestPrompt();
    api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: id, messages: [{ role: 'user', content: prompt }], stream: false }) }).then(function (d) {
      var c = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      var out = (typeof c === 'string' && c) ? c : (d && d.message && (d.message.content || d.message.text)) || JSON.stringify(d || {}, null, 2);
      showModelTest('✓ 成功 · 模型 ' + id, out, true);
    }).catch(function (e) {
      // 原始错误原样展示（含上游原始报错）
      showModelTest('✗ 失败 · 模型 ' + id + ' · 原始错误:', e.message || String(e), false);
    });
  };
  window.clearModelTest = function () {
    var pre = document.getElementById('modelTestResult');
    if (pre) { pre.style.color = 'var(--fg-2)'; pre.textContent = '暂无测试结果。点击下方任一模型行的「测试」按钮发起请求。'; }
  };

  // ─── 本地网关（一键启停 + 地址/Key 复制 + 连通测试）───────────
  window.copyText = function (t) {
    t = String(t == null ? '' : t);
    if (!t) { toast('没有可复制的内容'); return; }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (_) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast('已复制到剪贴板'); }, fallback);
    } else { fallback(); }
  };
  window.copyEl = function (id) { var el = document.getElementById(id); copyText(el ? el.value : ''); };

  function renderGatewayReal() {
    var g = state.gateway || { running: false, port: 8000, baseUrl: '' };
    var cfgPort = state.settings['gateway_port'] || 8000;
    var tag = document.getElementById('gatewayStateTag');
    if (tag) { tag.textContent = g.running ? '运行中 · 端口 ' + g.port : '已停止'; tag.className = 'tag ' + (g.running ? 'tag-green' : 'tag-gray'); }
    // 端口/Key 输入框：正在编辑（聚焦）时轮询不得覆盖
    var port = document.getElementById('gatewayPort');
    if (port && document.activeElement !== port) port.value = cfgPort;
    var base = document.getElementById('gatewayBaseUrl');
    // 运行中显示实时地址（当前真正生效）；停止时显示配置端口
    if (base) base.value = (g.running && g.baseUrl) ? g.baseUrl : ('http://127.0.0.1:' + cfgPort + '/v1');
    var hint = document.getElementById('gatewayPortHint');
    if (hint) {
      if (g.running && Number(g.port) !== Number(cfgPort)) hint.textContent = '当前运行于端口 ' + g.port + '；配置端口 ' + cfgPort + ' 重启网关后生效';
      else if (g.running) hint.textContent = '网关运行中，监听端口 ' + g.port;
      else hint.textContent = '已配置端口 ' + cfgPort + '，启动网关后生效';
    }
    var key = document.getElementById('gatewayApiKey');
    if (key && document.activeElement !== key) key.value = state.apiKey && state.apiKey !== '未设置' ? state.apiKey : '';
    var startBtn = document.getElementById('gatewayStartBtn');
    var stopBtn = document.getElementById('gatewayStopBtn');
    if (startBtn) { startBtn.disabled = g.running; startBtn.style.opacity = g.running ? '0.5' : '1'; }
    if (stopBtn) { stopBtn.disabled = !g.running; stopBtn.style.opacity = g.running ? '1' : '0.5'; }
  }
  window.saveGatewayKey = function () {
    var el = document.getElementById('gatewayApiKey');
    var v = ((el && el.value) || '').trim();
    if (!v) { toast('令牌不能为空'); return; }
    // Hub 的令牌在「令牌」接口签发，这里只切换面板本地使用的那一个
    localStorage.setItem('grok_hub_token', v);
    toast('面板已改用这个令牌');
    loadAll();
  };
  window.gatewayStart = function () {
    api('/api/gateway/start', { method: 'POST', body: '{}' }).then(function (d) {
      toast('本地网关已启动：' + (d.baseUrl || ''));
      return loadAll();
    }).catch(function (e) { toast('启动失败：' + e.message); });
  };
  window.gatewayStop = function () {
    api('/api/gateway/stop', { method: 'POST', body: '{}' }).then(function () {
      toast('本地网关已结束');
      return loadAll();
    }).catch(function (e) { toast('结束失败：' + e.message); });
  };
  window.saveGatewayPort = function () {
    var el = document.getElementById('gatewayPort');
    var v = parseInt((el || {}).value, 10);
    if (!v || v < 1 || v > 65535) { toast('端口无效（1-65535）'); return; }
    api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: { gateway_port: String(v) } }) }).then(function () {
      toast('端口已保存（下次启动网关生效）');
      return loadAll();
    }).catch(function (e) { toast('保存失败：' + e.message); });
  };
  window.gatewayTest = function () {
    var g = state.gateway || {};
    var pre = document.getElementById('gatewayTestResult');
    if (!g.running || !g.baseUrl) {
      if (pre) { pre.style.display = ''; pre.textContent = '网关未运行，请先启动。'; pre.style.color = 'var(--danger)'; }
      return;
    }
    if (pre) { pre.style.display = ''; pre.style.color = 'var(--fg-2)'; pre.textContent = '正在通过网关请求 ' + g.baseUrl + '/models …'; }
    fetch(g.baseUrl + '/models', { headers: { 'Authorization': 'Bearer ' + (state.apiKey && state.apiKey !== '未设置' ? state.apiKey : '') } })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (d) {
        if (pre) {
          pre.style.color = d.status === 200 ? 'var(--success)' : 'var(--danger)';
          pre.textContent = '网关连通性：HTTP ' + d.status + '\n' + (d.text ? d.text.slice(0, 2000) : '(空响应)');
        }
      })
      .catch(function (e) { if (pre) { pre.style.color = 'var(--danger)'; pre.textContent = '网关请求失败：' + e.message; } });
  };

  // ─── 图表（全部真实聚合数据）────────────────────────────────
  function destroyChart(name) { if (charts[name]) { charts[name].destroy(); delete charts[name]; } }
  function drawChart(id, cfg) {
    var c = document.getElementById(id);
    if (!c) return;
    if (charts[id]) charts[id].destroy();
    try { charts[id] = new Chart(c, cfg); } catch (e) { /* canvas 未就绪 */ }
  }

  function renderChartsReal() {
    if (typeof Chart === 'undefined') return;
    renderTrafficChart();
    renderPoolChart();
    renderHourlyChart();
    renderModelChart();
    renderChannelChart();
    renderHeatmap();
  }

  function renderTrafficChart() {
    var daily = state.analytics.daily || [];
    var labels = daily.map(function (p) { var d = p.label || ''; return d ? d.slice(5) : ''; });
    var total = daily.reduce(function (n, p) { return n + (p.total || 0); }, 0);
    setText('#trafficTotal', fmt(total));
    // 更新范围 tab 激活态
    document.querySelectorAll('#page-overview [data-range]').forEach(function (t) {
      t.classList.toggle('active', t.dataset.range === state.days + 'd');
    });
    drawChart('chartTraffic', { type: 'line', data: {
      labels: labels,
      datasets: [
        { label: '成功请求', data: daily.map(function (p) { return p.success || 0; }), borderColor: '#0B3D2E', backgroundColor: 'rgba(11,61,46,0.08)', fill: true, tension: .35, pointRadius: 2 },
        { label: '失败请求', data: daily.map(function (p) { return p.error || 0; }), borderColor: '#C2410C', backgroundColor: 'rgba(194,65,12,0.08)', fill: true, tension: .35, pointRadius: 2 }
      ]
    }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 8, color: '#8A8F96' } }, y: { beginAtZero: true, ticks: { color: '#8A8F96' } } } } });
  }

  function renderPoolChart() {
    var active = state.accounts.filter(function (a) { return a.status === 'active' && a.enabled; }).length;
    var exhausted = state.accounts.filter(function (a) { return a.status === 'exhausted'; }).length;
    var error = state.accounts.filter(function (a) { return a.status === 'error'; }).length;
    var disabled = state.accounts.filter(function (a) { return !a.enabled; }).length;
    drawChart('chartPool', { type: 'doughnut', data: { labels: ['在线', '额度耗尽', '异常', '停用'], datasets: [{ data: [active, exhausted, error, disabled], backgroundColor: ['#15803D', '#B45309', '#B91C1C', '#8A8F96'] }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false } } } });
    setText('#poolLegendActive', active); setText('#poolLegendExhausted', exhausted); setText('#poolLegendError', error); setText('#poolLegendDisabled', disabled);
  }

  function renderHourlyChart() {
    var hourly = state.analytics.hourly || [];
    var labels = hourly.map(function (p) { var h = (p.label || '').split(' ')[1] || ''; return h ? h.slice(0, 5) : ''; });
    drawChart('chartHourly', { type: 'bar', data: { labels: labels, datasets: [{ label: '调用量', data: hourly.map(function (p) { return p.total || 0; }), backgroundColor: 'rgba(11,61,46,0.75)', borderRadius: 3 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 12, color: '#8A8F96' } }, y: { beginAtZero: true, ticks: { color: '#8A8F96' } } } } });
  }

  function renderModelChart() {
    var models = state.analytics.models || [];
    var colors = ['#0B3D2E', '#C2410C', '#1D4ED8', '#B45309', '#6D28D9', '#15803D', '#0E7490', '#BE185D', '#4D7C0F', '#52525B'];
    drawChart('chartModel', { type: 'doughnut', data: { labels: models.map(function (m) { return m.model; }), datasets: [{ data: models.map(function (m) { return m.count; }), backgroundColor: colors.slice(0, models.length) }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { position: 'bottom' } } } });
  }

  function renderChannelChart() {
    var channels = state.analytics.channels || [];
    if (!channels.length) { destroyChart('chartRadar'); var c = document.getElementById('chartRadar'); if (c) c.parentElement.innerHTML = '<div class="text-[12px]" style="color:var(--muted);padding:40px 0;text-align:center">暂无调用数据</div>'; return; }
    var maxCalls = Math.max.apply(null, channels.map(function (x) { return x.calls; }).concat([1]));
    var maxTokens = Math.max.apply(null, channels.map(function (x) { return x.tokens; }).concat([1]));
    var maxCost = Math.max.apply(null, channels.map(function (x) { return x.cost; }).concat([1]));
    var maxLat = Math.max.apply(null, channels.map(function (x) { return x.avgLatencyMs; }).concat([1]));
    drawChart('chartRadar', { type: 'radar', data: { labels: ['调用量', '成功率', '低延迟', 'Token', '成本'], datasets: channels.map(function (c, i) {
      return { label: c.channel, data: [
        c.calls / maxCalls,
        c.successRate || 0,
        maxLat ? 1 - (c.avgLatencyMs / maxLat) : 0,
        c.tokens / maxTokens,
        maxCost ? 1 - (c.cost / maxCost) : 0
      ], borderColor: ['#0B3D2E', '#C2410C', '#1D4ED8'][i % 3], backgroundColor: ['rgba(11,61,46,0.12)', 'rgba(194,65,12,0.12)', 'rgba(29,78,216,0.12)'][i % 3], pointRadius: 2 };
    }) }, options: { responsive: true, maintainAspectRatio: false, scales: { r: { beginAtZero: true, max: 1, ticks: { display: false }, grid: { color: 'rgba(138,143,150,0.2)' } } }, plugins: { legend: { position: 'bottom' } } } });
  }

  function renderHeatmap() {
    var hm = document.getElementById('heatmap');
    if (!hm) return;
    var cells = state.analytics.heatmap || [];
    if (!cells.length) { hm.innerHTML = '<div class="text-[12px]" style="color:var(--muted);padding:20px 0;text-align:center">暂无热力分布</div>'; return; }
    var max = 1;
    cells.forEach(function (c) { if (c.count > max) max = c.count; });
    var days = ['日', '一', '二', '三', '四', '五', '六'];
    var byWd = {};
    cells.forEach(function (c) { (byWd[c.weekday] = byWd[c.weekday] || {})[c.hour] = c.count; });
    var html = '<div class="flex gap-1 items-center"><div class="w-4 shrink-0"></div>';
    for (var h = 0; h < 24; h++) html += '<div class="text-[9px] font-mono" style="width:14px;color:var(--muted);text-align:center">' + h + '</div>';
    html += '</div>';
    for (var w = 0; w < 7; w++) {
      html += '<div class="flex gap-1 items-center"><div class="w-4 shrink-0 text-[10px]" style="color:var(--muted)">' + days[w] + '</div>';
      for (var h2 = 0; h2 < 24; h2++) {
        var cnt = (byWd[w] && byWd[w][h2]) || 0;
        var level = cnt === 0 ? 0 : Math.min(5, Math.ceil(cnt / max * 5));
        html += '<div class="heat-cell heat-' + level + '" title="' + days[w] + ' ' + String(h2).padStart(2, '0') + ':00 · ' + cnt + ' 次"></div>';
      }
      html += '</div>';
    }
    hm.innerHTML = html;
  }

  // ─── 操作（全部真实写后端）──────────────────────────────────
  window.toggleAccount = function (id, enabled) { api('/api/accounts/'+id, {method:'PATCH',body:JSON.stringify({enabled:enabled})}).then(function(){toast('账号状态已更新');return loadAll();}).catch(function(e){toast(e.message);}); };
  window.deleteAccount = function (id) { if (!confirm('确定删除这个账号？')) return; api('/api/accounts/'+id,{method:'DELETE'}).then(function(){toast('账号已删除');return loadAll();}).catch(function(e){toast(e.message);}); };
  /* 手动导入：贴 SSO（每行一个，或 email:password:sso），POST /api/accounts 入池 */
  window.submitAccount = function () {
    var btn = document.getElementById('drawerSubmit');
    var text = (document.getElementById('drawerSsoText') || {}).value || '';
    if (!text.trim()) { toast('请先粘贴 SSO token'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    api('/api/accounts', { method: 'POST', body: JSON.stringify({ ssoText: text }) })
      .then(function (r) {
        toast('导入完成：新增 ' + r.added + ' 个，跳过 ' + r.skipped + ' 个');
        closeDrawer();
        return loadAll();
      })
      .catch(function (e) { toast(e.message); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = '导入号池'; } });
  };
  window.openDrawer = function () {
    var f = document.getElementById('drawer'); if (!f) return;
    var ta = document.getElementById('drawerSsoText');
    if (ta) ta.value = '';
    var btn = document.getElementById('drawerSubmit');
    if (btn) { btn.disabled = false; btn.textContent = '导入号池'; }
    f.classList.add('show'); document.getElementById('drawerBackdrop').classList.add('show');
  };
  window.resolveAlert = function (id) { api('/api/alerts/'+id+'/resolve', {method:'POST',body:'{}'}).then(function(){toast('告警已处理');return loadAll();}).catch(function(e){toast(e.message);}); };
  window.resolveAllAlerts = function () { if (!confirm('确定处理全部未处理告警？')) return; api('/api/alerts/resolve-all', {method:'POST',body:'{}'}).then(function(){toast('全部告警已处理');return loadAll();}).catch(function(e){toast(e.message);}); };  window.saveSettings = function () {
    var payload = {};
    document.querySelectorAll('#settingsForm [data-key]').forEach(function (el) {
      payload[el.dataset.key] = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
    });
    api('/api/settings', { method: 'PUT', body: JSON.stringify({settings:payload}) }).then(function () {
      // api_key 修改后立即更新本地会话 Key（含清空回退到环境变量 Key），避免面板后续请求被拦下
      if ('api_key' in payload) localStorage.setItem('grok_hub_token', payload['api_key'] || '');
      toast('配置已保存并生效');
      return loadAll();
    }).catch(function (e) { toast(e.message); });
  };
  window.saveRouting = function () {
    var retry = document.getElementById('routingRetry');
    var failover = document.getElementById('routingFailover');
    var payload = { settings: {} };
    if (retry) payload.settings['retry_count'] = retry.value;
    if (failover) payload.settings['failover_enabled'] = failover.checked ? 'true' : 'false';
    api('/api/settings', {method:'PUT', body:JSON.stringify(payload)}).then(function(){toast('路由策略已保存并生效');return loadAll();}).catch(function(e){toast(e.message);});
  };

  window.loadDashboard = loadAll;
  window.toggleNotif = function () { toast((state.alertSummary.open || 0) ? '有 ' + state.alertSummary.open + ' 条未处理告警' : '暂无未处理告警'); };
  window.refreshData = function () { loadAll().then(function () { toast('数据已刷新'); }); };
  // 号池自动健康检查状态徽标（读系统设置，仅展示）
  function renderHealthCheck() {
    var el = document.getElementById('hcStatus');
    if (!el) return;
    var on = state.settings['health_check_enabled'] !== 'false';
    var iv = state.settings['health_check_interval'] || '10';
    el.style.color = on ? 'var(--success)' : 'var(--fg-2)';
    el.textContent = on ? '健康检查：开（每 ' + iv + ' 分钟自动隔离风控账号）' : '健康检查：关';
  }
  window.runHealthCheck = function () {
    var btn = document.getElementById('hcRunBtn');
    if (btn) { btn.disabled = true; btn.style.opacity = 0.6; btn.textContent = '检查中…'; }
    api('/api/accounts/healthcheck', { method: 'POST', body: '{}' }).then(function (res) {
      toast('健康检查完成：本轮隔离 ' + (res.isolatedNow || 0) + ' 个风控账号');
      return loadAll();
    }).catch(function (e) { toast('健康检查失败：' + e.message); }).then(function () {
      if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.textContent = '立即检查'; }
    });
  };
  window.syncStatus = function () {
    var btn = document.getElementById('syncStatusBtn');
    if (btn) { btn.disabled = true; btn.style.opacity = 0.6; btn.textContent = '同步中…'; }
    api('/api/accounts/sync-status', { method: 'POST', body: '{}' }).then(function (res) {
      var n = res.updated || 0;
      toast(n ? n + ' 个账号已同步，额度/状态已实时刷新' : '没有可同步的账号（无凭证或全部停用）');
      return loadAll();
    }).catch(function (e) { toast('同步失败：' + e.message); }).then(function () {
      if (btn) {
        btn.disabled = false; btn.style.opacity = '';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg> 同步状态';
      }
    });
  };
  // ─── 上传已自动化：注册批次结束 → 自动上传 grok2api（派生三格式）→ 清本地。无手动按钮。
  window.testGrok2api = function () {
    var pre = document.getElementById('grok2apiTestResult');
    if (pre) { pre.style.display = 'block'; pre.style.color = 'var(--fg-2)'; pre.textContent = '正在登录 grok2api …'; }
    api('/api/grok2api/test', { method: 'POST', body: '{}' }).then(function (r) {
      if (pre) { pre.style.color = r.ok ? 'var(--success)' : 'var(--danger)'; pre.textContent = (r.ok ? '✓ ' : '✗ ') + r.message; }
    }).catch(function (e) { if (pre) { pre.style.color = 'var(--danger)'; pre.textContent = '测试失败：' + e.message; } });
  };

  // ─── 注册机（spawn grok-register-main）──────────────────────
  window.loadDetectConfig = function () { /* 配置即用即取，无预加载 */ };
  window.startDetect = function () {
    var count = parseInt((document.getElementById('detectCount') || {}).value, 10);
    if (isNaN(count) || count < 0) count = 1;
    var strictEl = document.getElementById('detectStrict');
    var strict = strictEl ? !!strictEl.checked : true;
    api('/api/register/start', { method: 'POST', body: JSON.stringify({ target: count, strict: strict }) })
      .then(function () {
        toast('注册已启动（目标 ' + (count || '不限') + '，' + (strict ? '严格精确' : '缓冲超发') + '模式）');
        renderDetectLogs();
      })
      .catch(function (e) { toast('启动失败：' + e.message); });
  };
  window.forceStopDetect = function () {
    if (!confirm('确定停止当前注册进程？')) return;
    api('/api/register/stop', { method: 'POST', body: '{}' }).then(function () {
      toast('已发送停止指令');
      renderDetectLogs();
    }).catch(function (e) { toast('停止失败：' + e.message); });
  };
  window.refreshQuota = function () { loadAll().then(function () { toast('已刷新'); }); };
  window.checkHealth = function () { loadAll().then(function () { toast('主动检查完成'); }); };
  window.toggleLogPause = function () {
    state.paused = !state.paused;
    var btn = document.getElementById('pauseBtn');
    if (btn) btn.innerHTML = state.paused
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg> 继续'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/></svg> 暂停';
    toast(state.paused ? '日志轮询已暂停' : '日志轮询已恢复');
  };
  window.clearLogs = function () { state.logs = []; renderLogsReal(); toast('日志已清空（仅本次会话，后端日志保留）'); };
  window.exportReport = function () {
    var data = JSON.stringify({ exported: new Date().toISOString(), stats: state.stats, accounts: state.accounts, alerts: state.alerts }, null, 2);
    download('grok-hub-report-' + new Date().toISOString().slice(0, 10) + '.json', data);
    toast('报表已导出（真实数据）');
  };
  window.exportLogs = function () {
    var data = JSON.stringify({ exported: new Date().toISOString(), logs: state.logs }, null, 2);
    download('grok-hub-logs-' + new Date().toISOString().slice(0, 10) + '.json', data);
    toast('明细已导出');
  };
  window.setTrafficRange = function (days) { state.days = days; loadAll().then(function () { toast('已切换为最近 ' + days + ' 天'); }); };

  // ─── 注册机（detect-web 全流程，2s 轮询）────────────────────
  var detectLastLen = -1;
  var detectWasRunning = false;
  var detectResultShown = null;
  window.renderDetectLogs = function () {
    var pre = document.getElementById('detectLogs');
    if (!pre) return;
    api('/api/detect-logs').then(function (d) {
      var logs = d.logs || [];
      var running = !!d.running;
      var result = d.result || null;
      // 收尾阶段（上传 grok2api）也算"忙"，此时进程已退出但活还没干完
      var busy = running || d.phase === 'finalize';
      var label = d.phaseText || (running ? '运行中' : '空闲');
      var shortLabel = d.phase === 'registering' ? '注册中'
        : d.phase === 'finalize' ? '上传中'
        : d.phase === 'done' ? '已完成' : '空闲';
      var stateEl = document.getElementById('detectLogState');
      if (stateEl) { stateEl.textContent = shortLabel; stateEl.className = 'tag ' + (busy ? 'tag-amber' : (d.phase === 'done' ? 'tag-green' : 'tag-gray')); }
      var runEl = document.getElementById('detectRunState');
      if (runEl) { runEl.textContent = label; runEl.style.color = busy ? 'var(--warning)' : 'var(--muted)'; }
      var countEl = document.getElementById('detectLogCount');
      if (countEl) countEl.textContent = logs.length + ' 行';
      var startBtn = document.getElementById('detectStartBtn');
      var stopBtn = document.getElementById('detectStopBtn');
      if (startBtn) { startBtn.disabled = busy; startBtn.style.opacity = busy ? '0.5' : '1'; }
      if (stopBtn) { stopBtn.disabled = !running; stopBtn.style.opacity = running ? '1' : '0.5'; }
      var resultTag = document.getElementById('detectResultTag');
      var resultText = document.getElementById('detectResultText');
      if (result) {
        if (resultTag) { resultTag.style.display = ''; resultTag.textContent = d.phase === 'finalize' ? '上传中' : (result.success ? '已完成' : '已结束'); resultTag.className = 'tag ' + (d.phase === 'finalize' ? 'tag-amber' : (result.success ? 'tag-green' : 'tag-red')); }
        if (resultText) resultText.textContent = result.message || '—';
      } else {
        if (resultTag) resultTag.style.display = 'none';
        if (resultText) resultText.textContent = busy ? label : '—';
      }
      // 只在收尾也结束后才提示，避免"注册完成"提前弹出
      if (detectWasRunning && !busy && result && result.finished_at !== detectResultShown) {
        detectResultShown = result.finished_at;
        toast(result.success ? ('本批完成：' + (result.message || '已接入 grok2api')) : ('本批结束：' + (result.message || '失败')));
        loadAll();
      }
      detectWasRunning = busy;
      if (logs.length > 0 && (detectLastLen < 0 || logs.length !== detectLastLen)) {
        pre.textContent = logs.join('\n');
        var auto = document.getElementById('autoScroll');
        if (!auto || auto.checked) pre.scrollTop = pre.scrollHeight;
      }
      detectLastLen = logs.length;
    }).catch(function () { /* 接口暂不可用则忽略 */ });
  };
  window.startDetectLogPoll = function () {
    setInterval(function () { if (document.getElementById('detectLogs')) renderDetectLogs(); }, 2500);
  };
  window.clearDetectLogs = function () { toast('日志由注册进程产生，仅保留最近数百行'); };

  // ─── 事件绑定 ───────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var filter = e.target.closest && e.target.closest('.log-filter');
    if (filter) { state.filter = filter.dataset.level || 'ALL'; renderLogsReal(); return; }
    var range = e.target.closest && e.target.closest('[data-range]');
    if (range) { var d = parseInt((range.dataset.range || '14').replace('d', ''), 10); if (d > 0) setTrafficRange(d); return; }
    var alertTab = e.target.closest && e.target.closest('#page-alerts .tab');
    if (alertTab) {
      state.alertTab = (alertTab.textContent || '').indexOf('全部') >= 0 ? 'all' : 'open';
      renderAlertsReal();
      return;
    }
  });
  // 注册机表单改动不再需要持久化（参数随启动下发），保留钩子为 no-op
  var __detectSaveTimer = null;
  function scheduleDetectSave() { /* no-op：参数在 startDetect 时直接下发 */ }
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'logSearch') { state.query = e.target.value; renderLogsReal(); }
    if (e.target && e.target.id === 'poolSearch') { state.poolQuery = e.target.value; renderPoolsReal(); }
    if (e.target && e.target.id && e.target.id.indexOf('detect') === 0) scheduleDetectSave();
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id && e.target.id.indexOf('detect') === 0) { scheduleDetectSave(); return; }
    if (e.target && e.target.id === 'poolStatus') { state.poolStatus = e.target.value || 'ALL'; renderPoolsReal(); }
    if (e.target && e.target.id === 'statsRange') {
      var v = e.target.value;
      var days = v === 'month' ? new Date().getDate() : parseInt(v, 10);
      if (days > 0 && days !== state.days) { state.days = days; loadAll().then(function () { toast('统计范围已更新'); }); }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawer();
  });

  function startDashboard() {
    bootstrapDashboard().then(function () {
      loadDetectConfig();
      loadAll();
      startDetectLogPoll();
      setInterval(function () { if (!state.paused) loadAll(); }, 5000);
    }).catch(function (err) {
      var app = document.getElementById('dashboard-app');
      if (app) app.innerHTML = '<div style="padding:32px;color:#B91C1C;font-family:monospace">Dashboard load failed: ' + esc(err.message) + '</div>';
      toast('加载控制台失败：' + err.message);
    });
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startDashboard);
  } else {
    startDashboard();
  }
}());

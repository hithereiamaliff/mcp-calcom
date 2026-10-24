/**
 * Analytics dashboard (HTML shell). The page itself is public; it asks for the server's
 * MCP_API_KEY and sends it as X-API-Key when fetching /analytics. All values from the API
 * are rendered with textContent (client user agents are untrusted input).
 */

export function renderDashboard(serverName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cal.com MCP - Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e4e4e7; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .header h1 { font-size: 1.8rem; color: #a78bfa; }
    .header p { color: #71717a; margin-top: 5px; font-size: 0.9rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; margin-left: 8px; }
    .badge-on { background: rgba(34,197,94,0.2); color: #22c55e; }
    .badge-off { background: rgba(234,179,8,0.2); color: #eab308; }
    .auth-card { max-width: 400px; margin: 60px auto; padding: 32px; background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; text-align: center; }
    .auth-card h2 { margin-bottom: 16px; font-size: 1.1rem; }
    .auth-card input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #3f3f46; background: #0f0f0f; color: #e4e4e7; margin-bottom: 12px; }
    .auth-card button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #a78bfa; color: #0f0f0f; font-weight: 600; cursor: pointer; }
    .auth-error { color: #f87171; font-size: 0.85rem; margin-top: 10px; min-height: 1em; }
    .hidden { display: none; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; padding: 20px; text-align: center; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #a78bfa; overflow-wrap: anywhere; }
    .stat-label { color: #71717a; font-size: 0.85rem; margin-top: 5px; }
    .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(400px, 100%), 1fr)); gap: 20px; margin-bottom: 30px; }
    .chart-card, .recent-calls { background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; padding: 20px; }
    .chart-card h3, .recent-calls h3 { color: #a1a1aa; font-size: 0.9rem; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.05em; }
    .chart-container { position: relative; height: 250px; }
    .call-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #27272a; }
    .call-item:last-child { border-bottom: none; }
    .call-tool { color: #a78bfa; font-weight: 600; font-size: 0.9rem; }
    .call-client { color: #71717a; font-size: 0.75rem; margin-top: 2px; overflow-wrap: anywhere; }
    .call-time { color: #52525b; font-size: 0.8rem; white-space: nowrap; }
    .refresh-btn { position: fixed; bottom: 20px; right: 20px; background: #a78bfa; color: white; border: none; border-radius: 50%; width: 50px; height: 50px; cursor: pointer; font-size: 1.2rem; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${serverName}</h1>
    <p id="uptime">Usage dashboard</p>
  </div>

  <div class="auth-card" id="auth">
    <h2>Enter the server's MCP_API_KEY</h2>
    <input type="password" id="apiKeyInput" placeholder="MCP_API_KEY" autocomplete="off">
    <button id="authButton">View analytics</button>
    <div class="auth-error" id="authError"></div>
  </div>

  <div id="content" class="hidden">
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value" id="totalRequests">-</div><div class="stat-label">Total Requests</div></div>
      <div class="stat-card"><div class="stat-value" id="totalToolCalls">-</div><div class="stat-label">Tool Calls</div></div>
      <div class="stat-card"><div class="stat-value" id="uniqueClients">-</div><div class="stat-label">Unique Clients</div></div>
      <div class="stat-card"><div class="stat-value" id="topTool">-</div><div class="stat-label">Top Tool</div></div>
    </div>
    <div class="charts-grid">
      <div class="chart-card"><h3>Tool Usage</h3><div class="chart-container"><canvas id="toolsChart"></canvas></div></div>
      <div class="chart-card"><h3>Hourly Requests (Last 24h)</h3><div class="chart-container"><canvas id="hourlyChart"></canvas></div></div>
      <div class="chart-card"><h3>Requests by Endpoint</h3><div class="chart-container"><canvas id="endpointChart"></canvas></div></div>
      <div class="chart-card"><h3>Top Clients by User Agent</h3><div class="chart-container"><canvas id="clientsChart"></canvas></div></div>
    </div>
    <div class="recent-calls"><h3>Recent Tool Calls</h3><div id="recentCalls"></div></div>
    <button class="refresh-btn" id="refreshButton" title="Refresh">&#x21bb;</button>
  </div>

  <script>
    const STORAGE_KEY = 'calcom-mcp-analytics-key';
    const basePath = window.location.pathname.replace(/\\/analytics\\/dashboard\\/?$/, '');
    const colors = ['#a78bfa','#3b82f6','#ec4899','#f59e0b','#10b981','#06b6d4','#f43f5e','#84cc16','#6366f1','#14b8a6'];
    const charts = {};
    const grid = { color: 'rgba(255,255,255,0.05)' };
    const ticks = { color: '#71717a' };

    function getKey() { try { return sessionStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; } }
    function setKey(value) { try { sessionStorage.setItem(STORAGE_KEY, value); } catch {} }

    async function loadData() {
      const key = getKey();
      if (!key) return showAuth('');
      const res = await fetch(basePath + '/analytics', { headers: { 'X-API-Key': key } });
      if (res.status === 401 || res.status === 503) {
        const body = await res.json().catch(() => ({}));
        return showAuth(body.message || 'Invalid key');
      }
      const data = await res.json();
      document.getElementById('auth').classList.add('hidden');
      document.getElementById('content').classList.remove('hidden');
      render(data);
    }

    function showAuth(message) {
      document.getElementById('auth').classList.remove('hidden');
      document.getElementById('content').classList.add('hidden');
      document.getElementById('authError').textContent = message;
    }

    function chart(id, config) {
      if (charts[id]) charts[id].destroy();
      charts[id] = new Chart(document.getElementById(id), config);
    }

    function render(data) {
      document.getElementById('totalRequests').textContent = data.summary.totalRequests.toLocaleString();
      document.getElementById('totalToolCalls').textContent = data.summary.totalToolCalls.toLocaleString();
      document.getElementById('uniqueClients').textContent = data.summary.uniqueClients.toLocaleString();
      const uptime = document.getElementById('uptime');
      uptime.textContent = 'Uptime: ' + data.uptime + ' ';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (data.firebase === 'enabled' ? 'badge-on' : 'badge-off');
      badge.textContent = data.firebase === 'enabled' ? 'Firebase' : 'Local only';
      uptime.appendChild(badge);

      const tools = Object.entries(data.breakdown.byTool);
      document.getElementById('topTool').textContent = tools.length ? tools[0][0] : '-';

      chart('toolsChart', { type: 'doughnut', data: { labels: tools.slice(0, 10).map(t => t[0]), datasets: [{ data: tools.slice(0, 10).map(t => t[1]), backgroundColor: colors, borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#a1a1aa', font: { size: 11 } } } } } });
      chart('hourlyChart', { type: 'line', data: { labels: Object.keys(data.hourlyRequests).map(h => h.split('T')[1] + ':00'), datasets: [{ data: Object.values(data.hourlyRequests), borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.1)', fill: true, tension: 0.4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks, grid }, y: { ticks, grid, beginAtZero: true } } } });
      chart('endpointChart', { type: 'bar', data: { labels: Object.keys(data.breakdown.byEndpoint), datasets: [{ data: Object.values(data.breakdown.byEndpoint), backgroundColor: colors, borderRadius: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks, grid: { display: false } }, y: { ticks, grid, beginAtZero: true } } } });
      const agents = Object.entries(data.clients.byUserAgent).slice(0, 5);
      chart('clientsChart', { type: 'bar', data: { labels: agents.map(([k]) => k.length > 30 ? k.slice(0, 30) + '…' : k), datasets: [{ data: agents.map(([, v]) => v), backgroundColor: colors.slice(0, 5), borderRadius: 8 }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks, grid, beginAtZero: true }, y: { ticks: { color: '#71717a', font: { size: 10 } }, grid: { display: false } } } } });

      const container = document.getElementById('recentCalls');
      container.replaceChildren();
      if (!data.recentToolCalls.length) {
        const empty = document.createElement('p');
        empty.style.color = '#71717a';
        empty.textContent = 'No tool calls yet';
        container.appendChild(empty);
        return;
      }
      for (const call of data.recentToolCalls) {
        const item = document.createElement('div');
        item.className = 'call-item';
        const left = document.createElement('div');
        const tool = document.createElement('span');
        tool.className = 'call-tool';
        tool.textContent = call.tool;
        const client = document.createElement('div');
        client.className = 'call-client';
        client.textContent = call.userAgent;
        left.append(tool, client);
        const time = document.createElement('span');
        time.className = 'call-time';
        time.textContent = new Date(call.timestamp).toLocaleTimeString();
        item.append(left, time);
        container.appendChild(item);
      }
    }

    function authenticate() {
      setKey(document.getElementById('apiKeyInput').value.trim());
      loadData();
    }

    document.getElementById('authButton').addEventListener('click', authenticate);
    document.getElementById('apiKeyInput').addEventListener('keypress', e => { if (e.key === 'Enter') authenticate(); });
    document.getElementById('refreshButton').addEventListener('click', loadData);
    loadData();
    setInterval(() => { if (getKey()) loadData(); }, 30000);
  </script>
</body>
</html>`;
}

// New Relic Node agent — must be required before anything else.
if (process.env.NEWRELIC_ENABLED === 'true' && process.env.NEW_RELIC_LICENSE_KEY) {
  // eslint-disable-next-line global-require
  require('newrelic');
}

const http = require('http');

const port = Number(process.env.PORT || 8000);
const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// New Relic Browser SDK config — env-driven, no hardcoded values.
// The bootstrap script in lib/newrelic-browser.js is loaded via a
// dynamic import that is gated on `NEXT_PUBLIC_NEWRELIC_ENABLED === 'true'`.
const newRelicBrowserEnabled =
  process.env.NEXT_PUBLIC_NEWRELIC_ENABLED === 'true';
const newRelicBrowserConfig = {
  enabled: newRelicBrowserEnabled,
  licenseKey: process.env.NEXT_PUBLIC_NEW_RELIC_BROWSER_LICENSE_KEY || '',
  applicationID: process.env.NEXT_PUBLIC_NEW_RELIC_BROWSER_APP_ID || '',
  accountID: process.env.NEXT_PUBLIC_NEW_RELIC_BROWSER_ACCOUNT_ID || '',
};

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser HITL Admin UI</title>
    <script>
      // New Relic Browser config — populated server-side from env. The
      // bootstrap module is loaded via dynamic import gated on
      // NEXT_PUBLIC_NEWRELIC_ENABLED so disabled-mode is zero-cost.
      window.__NEWRELIC_BROWSER_CONFIG__ = ${JSON.stringify({
        licenseKey: newRelicBrowserConfig.licenseKey,
        applicationID: newRelicBrowserConfig.applicationID,
        accountID: newRelicBrowserConfig.accountID,
      })};
      ${
        newRelicBrowserEnabled
          ? "if (typeof window !== 'undefined') { import('/_nr/newrelic-browser.js').catch(function(){}); }"
          : '// New Relic Browser disabled (NEXT_PUBLIC_NEWRELIC_ENABLED!=="true")'
      }
    </script>
    <style>
      :root {
        color-scheme: light;
        --bg-color: #f5f7fb;
        --text-color: #111827;
        --card-bg: #fff;
        --card-border: #dbe3f0;
        --code-bg: #edf2ff;
        --label-color: #374151;
        --input-bg: #fff;
        --input-border: #c7d2e5;
        --border-color: #e5e7eb;
        --btn-primary: #2563eb;
        --btn-secondary: #475569;
        --log-bg: #0f172a;
        --log-text: #e2e8f0;
      }
      :root.dark {
        color-scheme: dark;
        --bg-color: #0f172a;
        --text-color: #f8fafc;
        --card-bg: #1e293b;
        --card-border: #334155;
        --code-bg: #334155;
        --label-color: #cbd5e1;
        --input-bg: #0f172a;
        --input-border: #475569;
        --border-color: #334155;
        --btn-primary: #3b82f6;
        --btn-secondary: #64748b;
        --log-bg: #020617;
        --log-text: #e2e8f0;
      }
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        margin: 0;
        background: var(--bg-color);
        color: var(--text-color);
        transition: background-color 0.3s, color 0.3s;
      }
      .header-container {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .layout {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px 16px 40px;
      }
      .grid {
        display: grid;
        grid-template-columns: 320px 1fr;
        gap: 16px;
      }
      .card {
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 6px 24px rgba(16, 24, 40, 0.05);
      }
      h1 {
        margin: 0;
        font-size: 22px;
      }
      h2 {
        margin: 0 0 10px;
        font-size: 16px;
      }
      p {
        margin: 0 0 10px;
      }
      code {
        background: var(--code-bg);
        padding: 0.1rem 0.35rem;
        border-radius: 6px;
      }
      label {
        display: block;
        font-size: 13px;
        margin: 10px 0 4px;
        color: var(--label-color);
      }
      input {
        width: 100%;
        padding: 9px 10px;
        border: 1px solid var(--input-border);
        background: var(--input-bg);
        color: var(--text-color);
        border-radius: 8px;
        box-sizing: border-box;
      }
      button {
        margin-top: 10px;
        border: 0;
        border-radius: 8px;
        padding: 10px 12px;
        font-weight: 600;
        cursor: pointer;
        background: var(--btn-primary);
        color: #fff;
      }
      button.secondary {
        background: var(--btn-secondary);
      }
      button.theme-toggle {
        margin-top: 0;
        padding: 6px 12px;
        font-size: 12px;
        background: var(--btn-secondary);
      }
      button:disabled {
        background: #9ca3af;
        cursor: not-allowed;
      }
      .status {
        font-size: 13px;
        min-height: 20px;
        color: #3b82f6;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 8px;
        border-bottom: 1px solid var(--border-color);
        font-size: 13px;
      }
      .actions button {
        margin: 0 6px 0 0;
        padding: 6px 8px;
        font-size: 12px;
      }
      .pagination {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 16px;
        font-size: 13px;
      }
      .pagination-controls button {
        margin-top: 0;
        margin-left: 8px;
        padding: 6px 12px;
        font-size: 12px;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .log {
        background: var(--log-bg);
        color: var(--log-text);
        padding: 12px;
        border-radius: 8px;
        min-height: 130px;
        max-height: 260px;
        overflow: auto;
        white-space: pre-wrap;
        font-size: 12px;
      }
      @media (max-width: 960px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <h1 style="text-align:center;font-size:32px;margin-bottom:24px;">Hi, I'm Tabby 🤖</h1>
      <div class="header-container">
        <h1>Browser HITL Admin UI</h1>
        <button id="themeToggle" class="theme-toggle">Toggle Dark Mode</button>
      </div>
      <p>Phase 2 functional baseline console. API base: <code>${apiBase}</code></p>
      <div class="grid">
        <section class="card">
          <h2>Login</h2>
          <div id="oauthProviders" style="margin-bottom: 12px;"></div>
          <details id="pwdLoginDetails">
            <summary style="cursor:pointer; color: var(--btn-secondary); margin-bottom: 8px;">Sign in with email/password</summary>
            <label for="email">Email</label>
            <input id="email" value="admin@browser-hitl.local" />
            <label for="password">Password</label>
            <input id="password" type="password" value="" />
            <button id="loginBtn">Login</button>
          </details>
          <button id="loadBtn" class="secondary" style="margin-top: 8px;">Load Sessions</button>
          <div id="status" class="status"></div>
          <p class="mono">Token: <span id="tokenState">not set</span></p>
        </section>

        <section class="card">
          <h2>Sessions</h2>
          <table>
            <thead>
              <tr>
                <th>App</th>
                <th>ID</th>
                <th>State</th>
                <th>Health</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="sessionRows">
              <tr><td colspan="5">No session data loaded.</td></tr>
            </tbody>
          </table>
          <div class="pagination" id="pagination" style="display: none;">
            <div id="pageInfo">Showing 0-0 of 0</div>
            <div class="pagination-controls">
              <button id="prevBtn" class="secondary" disabled>Previous</button>
              <button id="nextBtn" class="secondary" disabled>Next</button>
            </div>
          </div>
        </section>
      </div>
      <section class="card" style="margin-top: 16px;">
        <h2>Operator Log</h2>
        <div id="log" class="log"></div>
      </section>
    </div>

    <script>
      (function () {
        const themeToggleBtn = document.getElementById('themeToggle');
        const root = document.documentElement;
        
        function setTheme(isDark) {
          if (isDark) {
            root.classList.add('dark');
            localStorage.setItem('theme', 'dark');
          } else {
            root.classList.remove('dark');
            localStorage.setItem('theme', 'light');
          }
        }
        
        // Initialize theme
        const savedTheme = localStorage.getItem('theme');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        setTheme(savedTheme === 'dark' || (!savedTheme && prefersDark));
        
        themeToggleBtn.addEventListener('click', () => {
          setTheme(!root.classList.contains('dark'));
        });

        const apiBase = ${JSON.stringify(apiBase)};
        let token = '';

        const statusEl = document.getElementById('status');
        const tokenStateEl = document.getElementById('tokenState');
        const logEl = document.getElementById('log');

        // ── OAuth token from redirect callback ─────────────────────
        (function extractOAuthToken() {
          const params = new URLSearchParams(window.location.search);
          const t = params.get('_token');
          if (t) {
            token = t;
            tokenStateEl.textContent = token.slice(0, 20) + '…';
            // Remove _token from URL without reload
            params.delete('_token');
            const newSearch = params.toString();
            history.replaceState({}, '', newSearch ? '?' + newSearch : window.location.pathname);
            appendLog('Signed in via OAuth ✓');
          }
        })();

        // ── Load OAuth providers ────────────────────────────────────
        (async function loadOAuthProviders() {
          try {
            const resp = await fetch(apiBase + '/auth/oauth/providers');
            if (!resp.ok) return;
            const providers = await resp.json();
            const container = document.getElementById('oauthProviders');
            providers.forEach(function(p) {
              const btn = document.createElement('button');
              btn.textContent = 'Sign in with ' + p.name;
              btn.style.marginBottom = '6px';
              btn.style.width = '100%';
              btn.addEventListener('click', function() {
                const callbackUrl = window.location.origin + window.location.pathname;
                window.location.href = apiBase + '/auth/oauth/' + p.id + '/login?redirect_uri=' + encodeURIComponent(callbackUrl);
              });
              container.appendChild(btn);
            });
            if (providers.length > 0) {
              document.getElementById('pwdLoginDetails').open = false;
            }
          } catch (e) {
            // No OAuth providers configured — email/password only
          }
        })();
        const rowsEl = document.getElementById('sessionRows');
        const emailEl = document.getElementById('email');
        const passwordEl = document.getElementById('password');
        const loginBtn = document.getElementById('loginBtn');
        const loadBtn = document.getElementById('loadBtn');
        const paginationEl = document.getElementById('pagination');
        const pageInfoEl = document.getElementById('pageInfo');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');

        let currentPage = 1;
        const pageSize = 10;
        let totalSessions = 0;

        function log(line) {
          const ts = new Date().toISOString();
          logEl.textContent += '[' + ts + '] ' + line + '\\n';
          logEl.scrollTop = logEl.scrollHeight;
        }

        function setStatus(msg, isError) {
          statusEl.textContent = msg;
          statusEl.style.color = isError ? '#b91c1c' : '#1d4ed8';
        }

        function authHeaders() {
          return token ? { Authorization: 'Bearer ' + token } : {};
        }

        async function login() {
          setStatus('Logging in...', false);
          const res = await fetch(apiBase + '/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: emailEl.value.trim(),
              password: passwordEl.value,
            }),
          });
          if (!res.ok) {
            throw new Error('Login failed (' + res.status + ')');
          }
          const json = await res.json();
          token = json.token;
          tokenStateEl.textContent = token ? 'set' : 'not set';
          setStatus('Login successful', false);
          log('Authenticated as ' + emailEl.value.trim());
        }

        function renderSessions(sessions) {
          rowsEl.innerHTML = '';
          if (!Array.isArray(sessions) || sessions.length === 0) {
            rowsEl.innerHTML = '<tr><td colspan="5">No sessions found.</td></tr>';
            return;
          }

          for (const s of sessions) {
            const tr = document.createElement('tr');
            const appName = (s.application && s.application.name) ? s.application.name : '-';
            const fullId = String(s.id || '');
            tr.innerHTML = ''
              + '<td>' + appName + '</td>'
              + '<td class="mono" title="' + fullId + '">' + fullId + '</td>'
              + '<td>' + (s.state || '-') + '</td>'
              + '<td>' + (s.health_result_type || '-') + '</td>'
              + '<td class="actions">'
              +   '<button data-action="stream" data-id="' + s.id + '">Stream URL</button>'
              +   '<button data-action="detail" data-id="' + s.id + '" class="secondary">Details</button>'
              + '</td>';
            rowsEl.appendChild(tr);
          }
        }

        async function loadSessions(page = 1) {
          if (!token) {
            throw new Error('Log in first');
          }
          setStatus('Loading sessions...', false);
          currentPage = page;
          const offset = (currentPage - 1) * pageSize;
          const res = await fetch(apiBase + '/sessions?limit=' + pageSize + '&offset=' + offset, {
            headers: authHeaders(),
          });
          if (!res.ok) {
            throw new Error('Failed to fetch sessions (' + res.status + ')');
          }
          const json = await res.json();
          const sessions = Array.isArray(json.data) ? json.data : [];
          totalSessions = typeof json.total === 'number' ? json.total : sessions.length;
          
          renderSessions(sessions);
          
          paginationEl.style.display = 'flex';
          const start = sessions.length > 0 ? offset + 1 : 0;
          const end = offset + sessions.length;
          pageInfoEl.textContent = 'Showing ' + start + '-' + end + ' of ' + totalSessions;
          prevBtn.disabled = currentPage === 1;
          nextBtn.disabled = end >= totalSessions;

          setStatus('Loaded ' + sessions.length + ' sessions', false);
          log('Loaded session list page ' + currentPage);
        }

        async function requestStream(sessionId) {
          const res = await fetch(apiBase + '/sessions/' + sessionId + '/stream', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders(),
            },
          });
          if (!res.ok) {
            throw new Error('Stream request failed (' + res.status + ')');
          }
          const json = await res.json();
          log('Stream URL for ' + sessionId + ': ' + json.url);
        }

        async function sessionDetail(sessionId) {
          const res = await fetch(apiBase + '/sessions/' + sessionId, {
            headers: authHeaders(),
          });
          if (!res.ok) {
            throw new Error('Session detail failed (' + res.status + ')');
          }
          const json = await res.json();
          log('Session ' + sessionId + ': ' + JSON.stringify(json));
        }

        loginBtn.addEventListener('click', async function () {
          try {
            loginBtn.disabled = true;
            await login();
          } catch (err) {
            setStatus(String(err.message || err), true);
            log('ERROR: ' + String(err.message || err));
          } finally {
            loginBtn.disabled = false;
          }
        });

        loadBtn.addEventListener('click', async function () {
          try {
            loadBtn.disabled = true;
            await loadSessions(1);
          } catch (err) {
            setStatus(String(err.message || err), true);
            log('ERROR: ' + String(err.message || err));
          } finally {
            loadBtn.disabled = false;
          }
        });

        prevBtn.addEventListener('click', async function () {
          if (prevBtn.disabled) return;
          try {
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            await loadSessions(currentPage - 1);
          } catch (err) {
            setStatus(String(err.message || err), true);
            log('ERROR: ' + String(err.message || err));
          }
        });

        nextBtn.addEventListener('click', async function () {
          if (nextBtn.disabled) return;
          try {
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            await loadSessions(currentPage + 1);
          } catch (err) {
            setStatus(String(err.message || err), true);
            log('ERROR: ' + String(err.message || err));
          }
        });

        rowsEl.addEventListener('click', async function (event) {
          const target = event.target;
          if (!(target instanceof HTMLButtonElement)) return;
          const sessionId = target.getAttribute('data-id');
          const action = target.getAttribute('data-action');
          if (!sessionId || !action) return;

          try {
            target.disabled = true;
            if (action === 'stream') {
              await requestStream(sessionId);
            } else if (action === 'detail') {
              await sessionDetail(sessionId);
            }
          } catch (err) {
            setStatus(String(err.message || err), true);
            log('ERROR: ' + String(err.message || err));
          } finally {
            target.disabled = false;
          }
        });
      })();
    </script>
  </body>
</html>`;

const path = require('path');
const fs = require('fs');
const nrBrowserPath = path.join(__dirname, 'lib', 'newrelic-browser.js');
let nrBrowserSource = '';
try {
  nrBrowserSource = fs.readFileSync(nrBrowserPath, 'utf8');
} catch (_e) {
  nrBrowserSource = '';
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Serve the gated Browser SDK loader module. Only fetched at runtime when
  // `NEXT_PUBLIC_NEWRELIC_ENABLED === 'true'` because the dynamic import in
  // the HTML head is itself gated.
  if (req.url === '/_nr/newrelic-browser.js') {
    if (!newRelicBrowserEnabled || !nrBrowserSource) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'newrelic_disabled' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(nrBrowserSource);
    return;
  }

  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, () => {
  console.log(`[admin-ui] placeholder server listening on :${port}`);
});

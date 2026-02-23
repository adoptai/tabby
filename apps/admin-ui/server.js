const http = require('http');

const port = Number(process.env.PORT || 3000);
const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser HITL Admin UI</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        margin: 0;
        background: #f5f7fb;
        color: #111827;
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
        background: #fff;
        border: 1px solid #dbe3f0;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 6px 24px rgba(16, 24, 40, 0.05);
      }
      h1 {
        margin: 0 0 8px;
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
        background: #edf2ff;
        padding: 0.1rem 0.35rem;
        border-radius: 6px;
      }
      label {
        display: block;
        font-size: 13px;
        margin: 10px 0 4px;
        color: #374151;
      }
      input {
        width: 100%;
        padding: 9px 10px;
        border: 1px solid #c7d2e5;
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
        background: #2563eb;
        color: #fff;
      }
      button.secondary {
        background: #475569;
      }
      button:disabled {
        background: #9ca3af;
        cursor: not-allowed;
      }
      .status {
        font-size: 13px;
        min-height: 20px;
        color: #1d4ed8;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 8px;
        border-bottom: 1px solid #e5e7eb;
        font-size: 13px;
      }
      .actions button {
        margin: 0 6px 0 0;
        padding: 6px 8px;
        font-size: 12px;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .log {
        background: #0f172a;
        color: #e2e8f0;
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
      <h1>Browser HITL Admin UI</h1>
      <p>Phase 2 functional baseline console. API base: <code>${apiBase}</code></p>
      <div class="grid">
        <section class="card">
          <h2>Login</h2>
          <label for="email">Email</label>
          <input id="email" value="admin@browser-hitl.local" />
          <label for="password">Password</label>
          <input id="password" type="password" value="" />
          <button id="loginBtn">Login</button>
          <button id="loadBtn" class="secondary">Load Sessions</button>
          <div id="status" class="status"></div>
          <p class="mono">Token: <span id="tokenState">not set</span></p>
        </section>

        <section class="card">
          <h2>Sessions</h2>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>State</th>
                <th>Health</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="sessionRows">
              <tr><td colspan="4">No session data loaded.</td></tr>
            </tbody>
          </table>
        </section>
      </div>
      <section class="card" style="margin-top: 16px;">
        <h2>Operator Log</h2>
        <div id="log" class="log"></div>
      </section>
    </div>

    <script>
      (function () {
        const apiBase = ${JSON.stringify(apiBase)};
        let token = '';

        const statusEl = document.getElementById('status');
        const tokenStateEl = document.getElementById('tokenState');
        const logEl = document.getElementById('log');
        const rowsEl = document.getElementById('sessionRows');
        const emailEl = document.getElementById('email');
        const passwordEl = document.getElementById('password');
        const loginBtn = document.getElementById('loginBtn');
        const loadBtn = document.getElementById('loadBtn');

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
            rowsEl.innerHTML = '<tr><td colspan="4">No sessions found.</td></tr>';
            return;
          }

          for (const s of sessions) {
            const tr = document.createElement('tr');
            const shortId = String(s.id || '').slice(0, 8);
            tr.innerHTML = ''
              + '<td class="mono">' + shortId + '</td>'
              + '<td>' + (s.state || '-') + '</td>'
              + '<td>' + (s.health_result_type || '-') + '</td>'
              + '<td class="actions">'
              +   '<button data-action="stream" data-id="' + s.id + '">Stream URL</button>'
              +   '<button data-action="detail" data-id="' + s.id + '" class="secondary">Details</button>'
              + '</td>';
            rowsEl.appendChild(tr);
          }
        }

        async function loadSessions() {
          if (!token) {
            throw new Error('Log in first');
          }
          setStatus('Loading sessions...', false);
          const res = await fetch(apiBase + '/sessions?limit=50&offset=0', {
            headers: authHeaders(),
          });
          if (!res.ok) {
            throw new Error('Failed to fetch sessions (' + res.status + ')');
          }
          const json = await res.json();
          const sessions = Array.isArray(json.data) ? json.data : [];
          renderSessions(sessions);
          setStatus('Loaded ' + sessions.length + ' sessions', false);
          log('Loaded session list');
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
            await loadSessions();
          } catch (err) {
            setStatus(String(err.message || err), true);
            log('ERROR: ' + String(err.message || err));
          } finally {
            loadBtn.disabled = false;
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

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
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

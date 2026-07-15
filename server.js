const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');
const CREDS_CANDIDATES = [
  path.join(ROOT, 'credentials.json'),
  path.join(ROOT, 'Digital-Footprint-Manager-feat-gmail-sender-prototype', 'credentials.json'),
  path.join(ROOT, 'Digital-Footprint-Manager-feat-gmail-sender-prototype', 'Digital-Footprint-Manager-feat-gmail-sender-prototype', 'credentials.json'),
];
const SESSION_COOKIE = 'dfm_sid';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const sessions = new Map();
const rules = [];
const history = [];

function readCredentials() {
  const file = CREDS_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) throw new Error('credentials.json not found');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.web || raw.installed || raw;
}

const credentials = readCredentials();
const redirectUri = credentials.redirect_uris?.[0] || `http://localhost:${PORT}/oauth2callback`;

function cookieHeader(value) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, item) => {
    const [k, ...rest] = item.trim().split('=');
    if (k) acc[k] = decodeURIComponent(rest.join('=') || '');
    return acc;
  }, {});
}

function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  return sid ? sessions.get(sid) || null : null;
}

function setSession(res, data) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, data);
  res.setHeader('Set-Cookie', cookieHeader(sid));
  return sid;
}

function clearSession(res, req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function send(res, code, body, type = 'text/html; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function serveIndex(req, res, session) {
  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  html = html.replace(/<script src="https:\/\/accounts\.google\.com\/gsi\/client" async defer><\/script>\n?/g, '');
  html = html.replace(/<script>\s*const API_BASE = 'http:\/\/127\.0\.0\.1:8000';/m, `<script>\n    const API_BASE = 'http://127.0.0.1:${PORT}';`);
  html = html.replace(/<button id="connectBtn" class="primary">Connect Google<\/button>/, session?.tokens ? '<button id="connectBtn" class="primary">Reconnect Google</button>' : '<button id="connectBtn" class="primary">Connect Google</button>');
  html = html.replace('</body>', `<script>window.__SESSION__ = ${JSON.stringify({ connected: !!session?.tokens, email: session?.email || null, origin: `http://localhost:${PORT}` })};</script></body>`);
  send(res, 200, html);
}

function authUrl() {
  const u = new URL(credentials.auth_uri);
  u.searchParams.set('client_id', credentials.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  return u.toString();
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(credentials.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function gmailFetch(token, pathName) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${pathName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function extractService(from, subject, snippet) {
  const addr = String(from || '');
  const domainMatch = addr.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  const domain = domainMatch ? domainMatch[1].toLowerCase() : 'unknown';
  return {
    service: domain.replace(/^mail\./, '').replace(/^www\./, '').split('.')[0],
    from,
    subject,
    snippet,
    domain,
  };
}

async function collectServices(token) {
  const list = await gmailFetch(token, 'users/me/messages?maxResults=30');
  const ids = (list.messages || []).map((m) => m.id);
  const out = new Map();
  for (const id of ids) {
    const msg = await gmailFetch(token, `users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const headers = msg.payload?.headers || [];
    const getHeader = (name) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
    const from = getHeader('From');
    const subject = getHeader('Subject');
    const item = extractService(from, subject, msg.snippet || '');
    if (!out.has(item.service)) out.set(item.service, { ...item, count: 0, lastSeen: null });
    const cur = out.get(item.service);
    cur.count += 1;
    cur.lastSeen = getHeader('Date') || cur.lastSeen;
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const session = getSession(req);

    if (u.pathname === '/') return serveIndex(req, res, session);

    if (u.pathname === '/auth/google') return res.writeHead(302, { Location: authUrl() }).end();

    if (u.pathname === '/oauth2callback') {
      const err = u.searchParams.get('error');
      if (err) return send(res, 400, `OAuth error: ${err}`);
      const code = u.searchParams.get('code');
      if (!code) return send(res, 400, 'Missing code');
      const tokens = await exchangeCode(code);
      const sid = session ? parseCookies(req)[SESSION_COOKIE] : setSession(res, { tokens: null, email: null });
      const who = await gmailFetch(tokens.access_token, 'users/me/profile').catch(() => null);
      sessions.set(sid, { tokens, email: who?.emailAddress || null });
      return res.writeHead(302, { Location: '/' }).end();
    }

    if (u.pathname === '/logout') {
      clearSession(res, req);
      return res.writeHead(302, { Location: '/' }).end();
    }

    if (u.pathname === '/api/me') {
      return send(res, 200, JSON.stringify({ connected: !!session?.tokens, email: session?.email || null }), 'application/json; charset=utf-8');
    }

    if (u.pathname === '/rules' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(rules), 'application/json; charset=utf-8');
    }

    if (u.pathname === '/rules' && req.method === 'POST') {
      const body = JSON.parse(await parseBody(req) || '{}');
      const rule = {
        id: crypto.randomUUID(),
        name: String(body.name || 'Custom rule'),
        mail_type: String(body.mail_type || 'UNKNOWN'),
        pattern: String(body.pattern || ''),
        enabled: body.enabled !== false,
        source: String(body.source || 'UI'),
        created_at: new Date().toISOString(),
      };
      rules.unshift(rule);
      return send(res, 200, JSON.stringify(rule), 'application/json; charset=utf-8');
    }

    if (u.pathname.startsWith('/rules/') && req.method === 'DELETE') {
      const id = u.pathname.split('/').pop();
      const idx = rules.findIndex((r) => r.id === id);
      if (idx >= 0) rules.splice(idx, 1);
      return send(res, 200, JSON.stringify({ deleted: true }), 'application/json; charset=utf-8');
    }

    if (u.pathname === '/history' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(history), 'application/json; charset=utf-8');
    }

    if (u.pathname === '/api/senders' && req.method === 'POST') {
      if (!session?.tokens?.access_token) return send(res, 401, JSON.stringify({ error: 'Not connected' }), 'application/json; charset=utf-8');
      const body = JSON.parse(await parseBody(req) || '{}');
      const services = await collectServices(session.tokens.access_token);
      history.unshift({
        id: history.length + 1,
        user_id: 1,
        status: 'COMPLETED',
        progress: 100,
        processed_messages: services.length,
        total_messages: services.length,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
      return send(res, 200, JSON.stringify({ ok: true, query: body.query || 'all', services }), 'application/json; charset=utf-8');
    }

    return send(res, 404, 'Not found');
  } catch (e) {
    send(res, 500, `Error: ${e.message || e}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Open http://localhost:${PORT}`);
});

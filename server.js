const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');
const SESSION_COOKIE = 'dfm_sid';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const sessions = new Map();

const CREDENTIALS_PATHS = [
  path.join(ROOT, 'credentials.json'),
  path.join(ROOT, 'Digital-Footprint-Manager-feat-gmail-sender-prototype', 'credentials.json'),
];

function readCredentials() {
  const file = CREDENTIALS_PATHS.find((p) => fs.existsSync(p));
  if (!file) {
    throw new Error('credentials.json not found');
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.web || raw.installed || raw;
}

const credentials = readCredentials();
const redirectUri = credentials.redirect_uris?.[0] || `http://localhost:${PORT}/oauth2callback`;

function parseCookies(req) {
  const out = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k) out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  return sid ? sessions.get(sid) || null : null;
}

function setSession(res, data) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, data);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`);
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

function serveIndex(res) {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
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

function labelFromMessage(subject = '', from = '') {
  const text = `${subject} ${from}`.toLowerCase();
  if (/welcome|verify|verification|confirm/.test(text)) return 'WELCOME_EMAIL';
  if (/login alert|sign[- ]?in|new login/.test(text)) return 'LOGIN_ALERT';
  if (/password reset|reset your password/.test(text)) return 'PASSWORD_RESET';
  if (/receipt|invoice|payment|purchase|order/.test(text)) return 'PAYMENT';
  if (/subscription|renewal|billing/.test(text)) return 'SUBSCRIPTION';
  if (/security|protect|alert/.test(text)) return 'SECURITY';
  if (/newsletter|digest|weekly/.test(text)) return 'NEWSLETTER';
  if (/update|notification/.test(text)) return 'ACCOUNT_UPDATE';
  return 'UNKNOWN';
}

function activitySignalForMailType(mailType) {
  if (mailType === 'LOGIN_ALERT' || mailType === 'PASSWORD_RESET' || mailType === 'PAYMENT') return 'HIGH';
  if (mailType === 'SUBSCRIPTION' || mailType === 'SECURITY' || mailType === 'ACCOUNT_UPDATE') return 'MEDIUM';
  if (mailType === 'WELCOME_EMAIL') return 'LOW';
  if (mailType === 'NEWSLETTER' || mailType === 'VERIFY_EMAIL' || mailType === 'UNKNOWN') return 'NONE';
  return 'NONE';
}

function canonicalServiceName(from = '') {
  const match = String(from).match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  const domain = match?.[1]?.toLowerCase() || 'unknown';
  return {
    domain,
    service: domain.replace(/^mail\./, '').replace(/^www\./, '').split('.')[0],
  };
}

async function collectServices(token) {
  const list = await gmailFetch(token, 'users/me/messages?maxResults=40');
  const ids = (list.messages || []).map((m) => m.id);
  const out = new Map();

  for (const id of ids) {
    const msg = await gmailFetch(token, `users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const headers = msg.payload?.headers || [];
    const getHeader = (name) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
    const from = getHeader('From');
    const subject = getHeader('Subject');
    const date = getHeader('Date');
    const { domain, service } = canonicalServiceName(from);
    const mailType = labelFromMessage(subject, from);
    const activitySignal = activitySignalForMailType(mailType);
    const scoreBoost = activitySignal === 'HIGH' ? 40 : activitySignal === 'MEDIUM' ? 20 : activitySignal === 'LOW' ? 10 : 0;
    const current = out.get(service) || {
      service,
      domain,
      from,
      count: 0,
      firstSeen: date,
      lastSeen: date,
      score: 0,
      mailTypes: new Set(),
      reasons: [],
    };

    current.count += 1;
    current.lastSeen = date || current.lastSeen;
    current.firstSeen = current.firstSeen || date;
    current.score += scoreBoost;
    current.mailTypes.add(mailType);
    current.reasons.push({ mailType, activitySignal, subject });
    out.set(service, current);
  }

  return [...out.values()]
    .map((item) => {
      const uniqueTypes = [...item.mailTypes];
      const confidence = Math.min(100, 35 + item.count * 8 + (uniqueTypes.includes('LOGIN_ALERT') ? 15 : 0));
      const recommendation = item.score >= 60 ? 'KEEP' : item.score >= 30 ? 'REVIEW' : 'LIKELY_UNUSED';
      return {
        service: item.service,
        domain: item.domain,
        count: item.count,
        firstSeen: item.firstSeen,
        lastSeen: item.lastSeen,
        activityScore: Math.min(100, item.score),
        confidence,
        recommendation,
        reasons: item.reasons.slice(0, 3).map((r) => `${r.mailType} / ${r.activitySignal}`),
      };
    })
    .sort((a, b) => b.activityScore - a.activityScore || b.count - a.count);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const session = getSession(req);

    if (u.pathname === '/') return serveIndex(res);
    if (u.pathname === '/auth/google') return res.writeHead(302, { Location: authUrl() }).end();

    if (u.pathname === '/oauth2callback') {
      const error = u.searchParams.get('error');
      if (error) return send(res, 400, `OAuth error: ${error}`);
      const code = u.searchParams.get('code');
      if (!code) return send(res, 400, 'Missing code');
      const tokens = await exchangeCode(code);
      const profile = await gmailFetch(tokens.access_token, 'users/me/profile').catch(() => null);
      setSession(res, { tokens, email: profile?.emailAddress || null });
      return res.writeHead(302, { Location: '/' }).end();
    }

    if (u.pathname === '/api/me') {
      return send(res, 200, JSON.stringify({ connected: !!session?.tokens, email: session?.email || null }), 'application/json; charset=utf-8');
    }

    if (u.pathname === '/api/senders' && req.method === 'POST') {
      if (!session?.tokens?.access_token) {
        return send(res, 401, JSON.stringify({ error: 'Not connected' }), 'application/json; charset=utf-8');
      }
      const services = await collectServices(session.tokens.access_token);
      return send(res, 200, JSON.stringify({ ok: true, services }), 'application/json; charset=utf-8');
    }

    if (u.pathname === '/logout') {
      clearSession(res, req);
      return res.writeHead(302, { Location: '/' }).end();
    }

    return send(res, 404, 'Not found');
  } catch (e) {
    send(res, 500, `Error: ${e.message || e}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Open http://localhost:${PORT}`);
});

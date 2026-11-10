#!/usr/bin/env node
/* 米家二维码登录助手（本地 127.0.0.1:1985）
 *
 * 1. 向小米账号页申请二维码并长轮询扫码结果
 * 2. 拿到 passToken 后写回 go2rtc.yaml 的 xiaomi: 段
 * 3. 重启 go2rtc 让新 token 生效
 *
 * 仅使用 Node 内置模块，可由 Electron 以 ELECTRON_RUN_AS_NODE=1 启动。
 * 二维码流程参考 MijiaLAN / MenuBarMijia (MIT, iPocket-APP) 的公开实现。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const BASE = __dirname;
const CONFIG = path.join(BASE, 'go2rtc.yaml');
const EXE = path.join(BASE, 'go2rtc.exe');
const HELPER_LOG = path.join(BASE, 'qr-login.log');
const GO2RTC_LOG = path.join(BASE, 'go2rtc-console.log');

const API_PORT = 1984;
const HELPER_PORT = 1985;
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:1984',
  'http://localhost:1984',
]);

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

let SESSION = null;
let STARTING = false;

function log(message) {
  try {
    if (fs.existsSync(HELPER_LOG) && fs.statSync(HELPER_LOG).size > 512 * 1024) {
      try { fs.renameSync(HELPER_LOG, HELPER_LOG + '.1'); } catch {}
    }
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    fs.appendFileSync(HELPER_LOG, `[${stamp}] ${message}\n`, 'utf8');
  } catch {}
}

function mask(uid) {
  const s = String(uid || '');
  return s.length > 4 ? s.slice(0, 2) + '****' + s.slice(-2) : '****';
}

function parseJsonp(text) {
  const mark = '&&&START&&&';
  const i = text.indexOf(mark);
  return JSON.parse(i >= 0 ? text.slice(i + mark.length) : text);
}

function cookieHeader(session) {
  return [...session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(session, res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  for (const item of list) {
    const pair = String(item).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) session.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function request(session, url, timeout = 20000) {
  const headers = { ...UA };
  const cookie = cookieHeader(session);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  storeCookies(session, res);
  return res;
}

async function requestFollow(session, url, timeout = 20000, max = 6) {
  let current = url;
  let res = null;
  for (let i = 0; i < max; i++) {
    res = await request(session, current, timeout);
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      await res.arrayBuffer().catch(() => {});
      if (!next) return res;
      current = new URL(next, current).toString();
      continue;
    }
    return res;
  }
  return res;
}

function portPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(':' + port) && /LISTENING/i.test(line)) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid) return pid;
      }
    }
  } catch {}
  return 0;
}

function apiUp() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${API_PORT}/api`, res => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function restartEngine() {
  const pid = portPid(API_PORT);
  if (pid) {
    log(`stopping go2rtc pid=${pid}`);
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    } catch {}
    for (let i = 0; i < 40; i++) {
      if (!portPid(API_PORT)) break;
      await sleep(250);
    }
  }
  log('starting go2rtc');
  let out = 'ignore';
  try {
    out = fs.openSync(GO2RTC_LOG, 'a');
    const child = spawn(EXE, ['-config', CONFIG], {
      cwd: BASE,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
  } catch (e) {
    log(`start failed: ${e.message}`);
    return false;
  } finally {
    if (typeof out === 'number') {
      try { fs.closeSync(out); } catch {}
    }
  }
  for (let i = 0; i < 60; i++) {
    if (await apiUp()) {
      log('go2rtc is up');
      return true;
    }
    await sleep(500);
  }
  log('go2rtc did not come up');
  return false;
}

function saveToken(user, token) {
  const original = fs.readFileSync(CONFIG);
  fs.writeFileSync(CONFIG + '.bak', original);

  let text = original.toString('utf8').replace(/^\uFEFF/, '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^xiaomi:\s*(?:#.*)?$/.test(lines[i])) { start = i; break; }
  }

  if (start >= 0) {
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j])) { end = j; break; }
    }
    const entries = {};
    for (let k = start + 1; k < end; k++) {
      const m = lines[k].match(/^\s+("[^"]+"|[^:\s]+)\s*:\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1].replace(/^"|"$/g, '');
      let value = m[2].trim();
      if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      entries[key] = value;
    }
    entries[user] = token;
    const block = ['xiaomi:', ...Object.entries(entries).map(
      ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`
    )];
    lines.splice(start, end - start, ...block);
  } else {
    let idx = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^streams:\s*$/.test(lines[i])) { idx = i; break; }
    }
    const block = ['xiaomi:', `  ${JSON.stringify(user)}: ${JSON.stringify(token)}`];
    if (idx < lines.length) block.push('');
    lines.splice(idx, 0, ...block);
  }

  fs.writeFileSync(CONFIG, lines.join(eol), 'utf8');
  log(`token saved for ${mask(user)}`);
}

class QRSession {
  constructor() {
    this.sid = crypto.randomBytes(8).toString('hex');
    this.state = 'starting';
    this.message = '';
    this.user = '';
    this.expires = 0;
    this.canceled = false;
    this.cookies = new Map();
    this.lp = '';
    this.image = Buffer.alloc(0);
  }

  cancel() {
    this.canceled = true;
    if (this.state !== 'done') {
      this.state = 'canceled';
      this.message = '已取消';
    }
  }

  snapshot() {
    return {
      state: this.state,
      user: this.state === 'done' ? this.user : mask(this.user),
      message: this.message,
      expiresIn: this.expires ? Math.max(0, Math.round((this.expires - Date.now()) / 1000)) : 0,
    };
  }

  async start() {
    const params = new URLSearchParams({
      _qrsize: '480',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      callback: 'https://sts.api.io.mi.com/sts',
      _hasLogo: 'false',
      sid: 'xiaomiio',
      serviceParam: '',
      _locale: 'zh_CN',
      _dc: String(Date.now()),
    });
    const url = 'https://account.xiaomi.com/longPolling/loginUrl?' + params.toString();
    const res = await requestFollow(this, url);
    const ticket = parseJsonp(await res.text());
    if (String(ticket.code ?? '0') !== '0') {
      throw new Error(`loginUrl code=${ticket.code}`);
    }

    this.lp = ticket.lp;
    const timeout = Number(ticket.timeout) || 300;
    const imgRes = await requestFollow(this, ticket.qr);
    this.image = Buffer.from(await imgRes.arrayBuffer());
    this.state = 'waiting';
    this.expires = Date.now() + timeout * 1000;
    this.message = '等待扫码';

    waitScan(this).catch(err => log(`wait scan failed: ${err.message}`));
    return 'data:image/png;base64,' + this.image.toString('base64');
  }

  async handleScan(data) {
    if (this.canceled) { this.state = 'canceled'; return; }
    this.user = String(data.userId || '');
    this.state = 'scanned';
    this.message = '已扫码，请在手机上确认';
    log(`scanned by ${mask(this.user)}`);

    let loc = data.location;
    for (let i = 0; i < 8 && loc; i++) {
      let res = null;
      try {
        res = await request(this, loc, 25000);
        await res.arrayBuffer();
      } catch {}
      if (this.cookies.get('passToken')) break;
      const next = res?.headers.get('location');
      if (!next) break;
      try { loc = new URL(next, loc).toString(); } catch { break; }
    }

    const token = this.cookies.get('passToken') || '';
    if (!token) {
      this.state = 'error';
      this.message = '登录成功但没拿到 passToken，请重试';
      log(`missing passToken for ${mask(this.user)}`);
      return;
    }
    if (this.canceled) { this.state = 'canceled'; return; }

    this.state = 'restarting';
    this.message = '登录成功，正在重启引擎';
    try {
      saveToken(this.user, token);
    } catch (e) {
      this.state = 'error';
      this.message = '写入 go2rtc.yaml 失败：' + e.message;
      log(`save token failed: ${e.message}`);
      return;
    }

    if (!await restartEngine()) {
      this.state = 'error';
      this.message = 'token 已保存，但引擎启动失败，请运行「启动监控.bat」';
      return;
    }
    this.state = 'done';
    this.message = '登录成功';
  }
}

async function waitScan(session) {
  while (Date.now() < session.expires) {
    if (session.canceled) { session.state = 'canceled'; return; }
    try {
      const res = await requestFollow(session, session.lp, 25000);
      if (res.status === 200) {
        const text = await res.text();
        let data = {};
        try { data = parseJsonp(text); } catch {}
        if (data.location && data.userId) {
          await session.handleScan(data);
          return;
        }
      }
      await sleep(1000);
    } catch {
      await sleep(1000);
    }
  }
  if (!session.canceled) {
    session.state = 'expired';
    session.message = '二维码已过期';
  }
}

async function startSession() {
  if (STARTING) throw new Error('另一个二维码正在生成');
  STARTING = true;
  try {
    const old = SESSION;
    if (old) old.cancel();
    const session = new QRSession();
    const qr = await session.start();
    SESSION = session;
    log('qr session started');
    return { session, qr };
  } finally {
    STARTING = false;
  }
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function sendJSON(req, res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  cors(req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendImage(req, res, body) {
  cors(req, res);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const sid = url.searchParams.get('sid') || '';

  if (req.method === 'OPTIONS') {
    cors(req, res);
    res.writeHead(204, { 'Content-Length': 0 });
    res.end();
    return;
  }

  try {
    if (url.pathname === '/health') {
      sendJSON(req, res, 200, { ok: true, service: 'qr-login' });
      return;
    }

    if (url.pathname === '/qr/new') {
      try {
        const { session, qr } = await startSession();
        sendJSON(req, res, 200, {
          ok: true,
          sid: session.sid,
          qr,
          expiresIn: Math.max(0, Math.round((session.expires - Date.now()) / 1000)),
        });
      } catch (e) {
        log(`qr start failed: ${e.message}`);
        sendJSON(req, res, 502, { ok: false, error: '获取二维码失败，请检查网络后重试' });
      }
      return;
    }

    if (url.pathname === '/qr/image') {
      const session = SESSION;
      if (!session || session.sid !== sid || !session.image.length) {
        sendJSON(req, res, 404, { ok: false, error: 'qr not found' });
        return;
      }
      sendImage(req, res, session.image);
      return;
    }

    if (url.pathname === '/qr/status') {
      const session = SESSION;
      if (!session || session.sid !== sid) {
        sendJSON(req, res, 200, { state: 'unknown', message: '会话不存在或已刷新' });
        return;
      }
      sendJSON(req, res, 200, session.snapshot());
      return;
    }

    if (url.pathname === '/qr/cancel') {
      const session = SESSION;
      if (session && session.sid === sid) {
        session.cancel();
        log('qr session canceled');
      }
      sendJSON(req, res, 200, { ok: true });
      return;
    }

    sendJSON(req, res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log(`handler failed: ${e.stack || e.message}`);
    try { sendJSON(req, res, 500, { ok: false, error: 'internal error' }); } catch {}
  }
});

server.on('error', err => {
  log(`helper port ${HELPER_PORT} unavailable: ${err.message}`);
  process.exit(0);
});

server.listen(HELPER_PORT, '127.0.0.1', () => {
  log(`helper listening on 127.0.0.1:${HELPER_PORT}`);
});

#!/usr/bin/env node
/* 米家二维码登录助手（默认 127.0.0.1:1985）
 *
 * 1. 向小米账号页申请二维码并长轮询扫码结果
 * 2. 拿到 passToken 后写回 go2rtc.yaml 的 xiaomi: 段
 * 3. 重启 go2rtc 让新 token 生效
 *
 * 仅使用 Node 内置模块，可由 Electron 以 ELECTRON_RUN_AS_NODE=1 启动。
 * NAS 版通过 IMI_CONFIG / IMI_HELPER_HOST / IMI_API_PORT 等环境变量定位配置和引擎。
 * 二维码流程参考 MijiaLAN / MenuBarMijia (MIT, iPocket-APP) 的公开实现。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const BASE = process.env.IMI_ROOT || __dirname;
const CONFIG = process.env.IMI_CONFIG || path.join(BASE, 'go2rtc.yaml');
const EXE = process.env.IMI_GO2RTC_BIN || path.join(BASE, 'go2rtc.exe');
const LOG_DIR = process.env.IMI_LOG_DIR || BASE;
const HELPER_LOG = path.join(LOG_DIR, 'qr-login.log');
const GO2RTC_LOG = path.join(LOG_DIR, 'go2rtc-console.log');

const API_HOST = process.env.IMI_API_HOST || '127.0.0.1';

function readApiPortFromConfig() {
  try {
    const lines = fs.readFileSync(CONFIG, 'utf8').split(/\r?\n/);
    let inApi = false;
    for (const line of lines) {
      if (/^api:\s*$/.test(line)) { inApi = true; continue; }
      if (inApi && /^\S/.test(line)) break;
      if (!inApi) continue;
      const m = line.match(/^\s+listen:\s*"[^"]*:(\d+)"/);
      if (m) return Number(m[1]);
    }
  } catch {}
  return 0;
}

// Windows 旧安装的配置还是 127.0.0.1:1984；1984 现在常被远程软件占用。
// 新版本统一迁到 19840，仅限本机默认配置，NAS（IMI_CONFIG/IMI_API_PORT）不动。
function migrateLegacyApiPort() {
  if (process.platform !== 'win32' || process.env.IMI_CONFIG || process.env.IMI_API_PORT) return;
  try {
    const text = fs.readFileSync(CONFIG, 'utf8');
    if (!/listen:\s*"127\.0\.0\.1:1984"/.test(text)) return;
    const next = text.replace(/listen:\s*"127\.0\.0\.1:1984"/, 'listen: "127.0.0.1:19840"');
    const tmp = CONFIG + '.tmp';
    fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG);
  } catch {}
}

migrateLegacyApiPort();
const API_PORT = Number(process.env.IMI_API_PORT || readApiPortFromConfig() || 19840);
const HELPER_HOST = process.env.IMI_HELPER_HOST || '127.0.0.1';
const HELPER_PORT = Number(process.env.IMI_HELPER_PORT || 1985);
// NAS 版由同一容器里的网关启动引擎，重启走 go2rtc 自带的 /api/restart
const RESTART_MODE = process.env.IMI_RESTART_MODE || (process.platform === 'win32' ? 'spawn' : 'api');

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
    const req = http.get(`http://${API_HOST}:${API_PORT}/api`, res => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function apiPost(path) {
  return new Promise(resolve => {
    const req = http.request({
      host: API_HOST,
      port: API_PORT,
      path,
      method: 'POST',
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode < 500));
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function restartEngine() {
  if (RESTART_MODE === 'api') {
    log('restarting go2rtc via api');
    await apiPost('/api/restart');
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
  if (process.platform !== 'win32') {
    try { fs.chmodSync(CONFIG, 0o600); } catch {}
  }
  roomsCache = { key: '', at: 0, data: null };
  authCache = { key: '', at: 0, auth: null, token: '' };
  roomsFail = { key: '', at: 0, message: '' };
  log(`token saved for ${mask(user)}`);
}

/* ------------------------------------------------------------------ */
/* 米家房间：只读云端查询，结果只回给本机网页                        */
/* ------------------------------------------------------------------ */

const CLOUD_HOSTS = {
  cn: 'https://api.io.mi.com/app',
  de: 'https://de.api.io.mi.com/app',
  i2: 'https://i2.api.io.mi.com/app',
  ru: 'https://ru.api.io.mi.com/app',
  sg: 'https://sg.api.io.mi.com/app',
  us: 'https://us.api.io.mi.com/app',
};

let roomsCache = { key: '', at: 0, data: null };
let authCache = { key: '', at: 0, auth: null, token: '' };
let roomsFail = { key: '', at: 0, message: '' };
const ROOMS_TTL = 10 * 60 * 1000;
const AUTH_TTL = 10 * 60 * 1000;
const ROOMS_FAIL_BACKOFF = 3 * 60 * 1000;

function readXiaomiTokens() {
  try {
    const lines = fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^xiaomi:\s*(?:#.*)?$/.test(lines[i])) { start = i; break; }
    }
    if (start < 0) return {};
    const out = {};
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const m = lines[i].match(/^\s+("[^"]+"|[^:\s]+)\s*:\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1].replace(/^"|"$/g, '');
      let value = m[2].trim();
      if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) value = value.slice(1, -1);
      if (value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function rc4(key, input) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  j = 0;
  const next = () => {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    return s[(s[i] + s[j]) & 255];
  };
  // go2rtc 的 RC4 实现会先丢弃 1024 字节
  for (let k = 0; k < 1024; k++) next();
  const out = Buffer.alloc(input.length);
  for (let k = 0; k < input.length; k++) out[k] = input[k] ^ next();
  return out;
}

function signedNonceOf(ssecurity, nonce) {
  return crypto.createHash('sha256').update(ssecurity).update(nonce).digest();
}

function signatureOf(method, apiPath, form, signedNonce) {
  let text = `${method}&${apiPath}&data=${form.get('data') || ''}`;
  if (form.has('rc4_hash__')) text += `&rc4_hash__=${form.get('rc4_hash__')}`;
  text += `&${signedNonce.toString('base64')}`;
  return crypto.createHash('sha1').update(text).digest('base64');
}

async function cloudLogin(user, token) {
  const session = { cookies: new Map() };
  session.cookies.set('userId', user);
  session.cookies.set('passToken', token);

  const res = await requestFollow(session, 'https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=xiaomiio');
  const data = parseJsonp(await res.text());
  if (data.code === 70016) throw new Error('小米账号需要验证，请稍后重试或重新扫码');
  if (!data.location) throw new Error('登录令牌已失效，请重新扫码');
  if (!data.ssecurity) throw new Error('小米云端未返回 ssecurity');
  const ssecurity = Buffer.from(String(data.ssecurity), 'base64');

  await requestFollow(session, data.location);
  for (const name of ['userId', 'cUserId', 'serviceToken']) {
    if (!session.cookies.get(name)) throw new Error('小米云端登录不完整');
  }
  return { session, ssecurity };
}

async function cloudRequest(auth, region, apiPath, body) {
  const base = CLOUD_HOSTS[region] || CLOUD_HOSTS.cn;
  const nonce = crypto.randomBytes(12);
  nonce.writeUInt32BE(Math.floor(Date.now() / 60000), 8);
  const signedNonce = signedNonceOf(auth.ssecurity, nonce);

  const form = new URLSearchParams();
  form.set('data', JSON.stringify(body || {}));
  form.set('rc4_hash__', signatureOf('POST', apiPath, form, signedNonce));
  for (const key of ['data', 'rc4_hash__']) {
    const value = form.get(key);
    form.set(key, rc4(signedNonce, Buffer.from(value, 'utf8')).toString('base64'));
  }
  form.set('signature', signatureOf('POST', apiPath, form, signedNonce));
  form.set('_nonce', nonce.toString('base64'));

  const cookie = ['userId', 'cUserId', 'serviceToken']
    .map(k => `${k}=${auth.session.cookies.get(k) || ''}`).join('; ');
  const res = await fetch(base + apiPath, {
    method: 'POST',
    headers: {
      ...UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`小米云端 HTTP ${res.status}`);
  const raw = Buffer.from((await res.text()).trim(), 'base64');
  const plain = rc4(signedNonce, raw).toString('utf8');
  const data = JSON.parse(plain);
  if (data.code !== 0) throw new Error(data.message || `小米云端错误 ${data.code}`);
  return data.result;
}

// 同一账号的云端登录、同一账号+区域的房间查询各只跑一次。
// 小米对同一个 passToken 的短时重复登录会触发风控，所以这里必须串行。
const inflight = new Map();

function once(key, task) {
  const running = inflight.get(key);
  if (running) return running;
  const p = Promise.resolve()
    .then(task)
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

function getAuth(user, token, force = false) {
  const key = user;
  if (force && authCache.key === key) authCache = { key: '', at: 0, auth: null, token: '' };
  return once(`login:${key}`, async () => {
    // 排队等锁期间，前一个调用可能已经登录完了
    if (authCache.auth && authCache.key === key && Date.now() - authCache.at < AUTH_TTL) {
      return { auth: authCache.auth, token: authCache.token };
    }
    const auth = await cloudLogin(user, token);
    authCache = { key, at: Date.now(), auth, token };
    return { auth, token };
  });
}

function fetchRooms(user, region) {
  return once(`rooms:${user}|${region}`, () => loadRooms(user, region));
}

// 小米会在登录时轮换 passToken。go2rtc 只在内存里用新 token，
// 这里把轮换后的值写回配置，避免引擎重启后又拿旧 token 要求重新扫码。
// authToken 是创建该会话时使用的 token；和配置不一致时说明配置已被引擎更新，
// 绝不能把旧会话里的 token 写回去。
function persistRefreshedToken(user, configToken, auth, authToken) {
  if (authToken !== configToken) return;
  const next = auth?.session?.cookies?.get('passToken') || '';
  if (!next || next === configToken) return;
  try {
    // 写前再读一次，避免覆盖另一个进程刚写好的新 token
    const current = readXiaomiTokens()[user] || '';
    if (current !== configToken) return;

    const original = fs.readFileSync(CONFIG);
    let text = original.toString('utf8').replace(/^\uFEFF/, '');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(l => /^xiaomi:\s*(?:#.*)?$/.test(l));
    if (start < 0) return;
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j])) { end = j; break; }
    }
    const entries = {};
    for (let k = start + 1; k < end; k++) {
      const m = lines[k].match(/^\s+("[^"]+"|[^:\s]+)\s*:\s*(.*?)\s*$/);
      if (!m) continue;
      const name = m[1].replace(/^"|"$/g, '');
      let value = m[2].trim();
      if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) value = value.slice(1, -1);
      entries[name] = value;
    }
    entries[user] = next;
    const block = ['xiaomi:', ...Object.entries(entries).map(
      ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`
    )];
    lines.splice(start, end - start, ...block);
    const tmp = CONFIG + '.tmp';
    fs.writeFileSync(tmp, lines.join(eol), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(CONFIG, 0o600); } catch {}
    }
    log(`token refreshed for ${mask(user)}`);
  } catch (e) {
    log(`token refresh failed: ${e.message}`);
  }
}

async function loadRooms(user, region) {
  const key = `${user}|${region}`;
  if (roomsCache.data && roomsCache.key === key && Date.now() - roomsCache.at < ROOMS_TTL) {
    return roomsCache.data;
  }
  if (roomsFail.key === key && Date.now() - roomsFail.at < ROOMS_FAIL_BACKOFF) {
    throw new Error(roomsFail.message);
  }

  try {
    const tokens = readXiaomiTokens();
    const token = tokens[user];
    if (!token) throw new Error('没有可用的登录令牌');

    let login = await getAuth(user, token);
    let auth = login.auth;
    persistRefreshedToken(user, token, auth, login.token);
    const homeBody = { limit: 150, fetch_share: true, fetch_share_dev: true, plat_form: 0, app_ver: 9 };
    let home;
    try {
      home = await cloudRequest(auth, region, '/v2/homeroom/gethome', homeBody);
    } catch (e) {
      if (!/HTTP 401/.test(e.message)) throw e;
      login = await getAuth(user, token, true);
      auth = login.auth;
      persistRefreshedToken(user, token, auth, login.token);
      home = await cloudRequest(auth, region, '/v2/homeroom/gethome', homeBody);
    }

    const homes = [...(home.homelist || []), ...(home.share_home_list || [])];
    const roomOf = new Map();
    const dids = [];
    for (const h of homes) {
      for (const room of h.roomlist || []) {
        for (const did of room.dids || []) {
          if (!roomOf.has(did)) roomOf.set(did, String(room.name || '未分配房间'));
          if (!dids.includes(did)) dids.push(did);
        }
      }
    }

    const devicesResult = await cloudRequest(auth, region, '/v2/home/device_list_page', {
      limit: 200,
      get_split_device: true,
      get_third_device: true,
      dids,
    });

    const devices = (devicesResult.list || [])
      .filter(d => /\.(camera|cateye|feeder)\./i.test(String(d.model || '')))
      .map(d => ({
        did: String(d.did || ''),
        name: String(d.name || ''),
        model: String(d.model || ''),
        room: roomOf.get(String(d.did || '')) || '未分配房间',
        online: !!(d.isOnline ?? d.online),
      }))
      .filter(d => d.did);

    const roomMap = new Map();
    for (const device of devices) {
      if (!roomMap.has(device.room)) roomMap.set(device.room, { name: device.room, online: 0, total: 0 });
      const room = roomMap.get(device.room);
      room.total += 1;
      if (device.online) room.online += 1;
    }

    const rooms = [...roomMap.values()].sort((a, b) => {
      if (a.name === '未分配房间') return 1;
      if (b.name === '未分配房间') return -1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    const data = {
      ok: true,
      rooms,
      devices: devices.map(({ did, room, online }) => ({ did, room, online })),
      total: {
        online: devices.filter(d => d.online).length,
        total: devices.length,
      },
      updatedAt: Date.now(),
    };
    roomsCache = { key, at: Date.now(), data };
    roomsFail = { key: '', at: 0, message: '' };
    return data;
  } catch (e) {
    roomsFail = { key, at: Date.now(), message: e.message };
    throw e;
  }
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
      this.message = 'token 已保存，但引擎重启失败，请重启 IMI-LAN 应用';
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
  if (!origin) return;
  try {
    const u = new URL(origin);
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (u.hostname === host || ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  } catch {}
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

    if (url.pathname === '/rooms') {
      const tokens = readXiaomiTokens();
      const user = url.searchParams.get('id') || Object.keys(tokens)[0] || '';
      const region = url.searchParams.get('region') || 'cn';
      if (!user || !tokens[user]) {
        sendJSON(req, res, 404, { ok: false, error: '没有可用的登录令牌' });
        return;
      }
      try {
        const data = await fetchRooms(user, region);
        sendJSON(req, res, 200, data);
      } catch (e) {
        log(`rooms failed for ${mask(user)}: ${e.message}`);
        sendJSON(req, res, 502, { ok: false, error: e.message });
      }
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

server.listen(HELPER_PORT, HELPER_HOST, () => {
  log(`helper listening on ${HELPER_HOST}:${HELPER_PORT}`);
});

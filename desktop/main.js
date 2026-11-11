const { app, BrowserWindow, Tray, Menu, dialog, shell, screen } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const ROOT = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const LOG_DIR = app.isPackaged ? ROOT : __dirname;
const ENGINE = path.join(ROOT, 'go2rtc.exe');
const CONFIG = path.join(ROOT, 'go2rtc.yaml');
const QR_SCRIPT = path.join(ROOT, 'qr-login.js');
const FW_BAT = path.join(ROOT, '修复网络权限（桌面版）.bat');

function readApiPort() {
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

function migrateLegacyApiPort() {
  try {
    const text = fs.readFileSync(CONFIG, 'utf8');
    if (!/listen:\s*"127\.0\.0\.1:1984"/.test(text)) return;
    const next = text.replace(/listen:\s*"127\.0\.0\.1:1984"/, 'listen: "127.0.0.1:19840"');
    const tmp = CONFIG + '.tmp';
    fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG);
  } catch {}
}

// 旧版的 1984 可能被远程/串流软件占用，升级时自动迁到 19840
migrateLegacyApiPort();
const API_PORT = readApiPort() || 19840;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const QR_PORT = 19841;
const PROBE = process.argv.includes('--probe');

function logHelper(message) {
  try {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    fs.appendFileSync(path.join(LOG_DIR, 'helper.log'), `[${stamp}] ${message}\n`, 'utf8');
  } catch {}
}

// 摄像头是 H.265，尽量走平台硬件解码
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let tray = null;
let engine = null;
let engineOwned = false;
let engineChecking = false;
let helper = null;
let helperOwned = false;
let helperStarting = false;
let helperRetry = 0;
let helperSince = 0;
let quitting = false;

// 助手异常退出后的重试间隔（退避封顶），避免每几秒 spawn 一次
const HELPER_RETRY_MS = [3000, 10000, 30000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function portOpen(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = ok => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(800, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
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

function httpOk(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitEngine(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await httpOk(API_URL + '/api')) return true;
    await sleep(500);
  }
  return false;
}

function spawnEngine() {
  const log = fs.openSync(path.join(LOG_DIR, 'engine.log'), 'a');
  engine = spawn(ENGINE, ['-config', CONFIG], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  engineOwned = true;
  engine.on('exit', () => {
    engine = null;
    if (quitting || !engineOwned) return;
    // 自己启动的引擎异常退出时自动拉起；如果二维码助手已经重启了引擎，则接管并刷新页面
    setTimeout(async () => {
      if (quitting || engine || engineChecking) return;
      if (await portOpen(API_PORT)) {
        engineOwned = false;
        if (win) win.webContents.reload();
        return;
      }
      spawnEngine();
      const ok = await waitEngine(20000);
      if (ok && win) win.webContents.reload();
    }, 2000);
  });
}

async function startEngine() {
  if (await portOpen(API_PORT)) {
    engineOwned = false;
    return true;
  }
  if (!fs.existsSync(ENGINE)) {
    dialog.showErrorBox('找不到 go2rtc.exe', '请把 Electron 应用放在 imi-lan 目录内。');
    return false;
  }
  spawnEngine();
  const ok = await waitEngine(20000);
  if (!ok) {
    dialog.showErrorBox('引擎启动失败', '请检查 go2rtc.exe 和 go2rtc.yaml，或运行「启动监控.bat」。');
  }
  return ok;
}

async function restartEngine() {
  engineChecking = true;
  try {
    if (engineOwned && engine) {
      try { engine.kill(); } catch {}
      engine = null;
    } else {
      const pid = portPid(API_PORT);
      if (pid) {
        try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }); } catch {}
      }
    }
    for (let i = 0; i < 40; i++) {
      if (!(await portOpen(API_PORT))) break;
      await sleep(250);
    }
    spawnEngine();
    const ok = await waitEngine(20000);
    if (win) win.webContents.reload();
    return ok;
  } finally {
    engineChecking = false;
  }
}

// 引擎兜底看门狗：扫码登录后引擎由二维码助手重启（归助手所有），
// 桌面版的 exit 监听管不到它。引擎无论被谁拉起，一旦退出且端口空了，
// 这里兜底接管重启，避免出现"引擎未启动"却没人救的局面。
async function watchEngine() {
  if (quitting || engine || engineChecking) return;
  engineChecking = true;
  try {
    if (await portOpen(API_PORT)) return;
    logHelper('engine watchdog: port closed, respawning engine');
    spawnEngine();
    const ok = await waitEngine(20000);
    if (ok && win) win.webContents.reload();
  } finally {
    engineChecking = false;
  }
}

function stopEngine() {
  if (engineOwned && engine) {
    try { engine.kill(); } catch {}
    engine = null;
  }
}

async function startHelper() {
  // 守卫必须在 await 之前置位：portOpen 最长要等 800ms，
  // 期间其他调用如果只看 helperStarting 会重复 spawn。
  if (quitting || helperStarting || helper) return;
  helperStarting = true;
  try {
    if (await portOpen(QR_PORT)) {
      helperRetry = 0;
      return;
    }
    if (!fs.existsSync(QR_SCRIPT)) return;
    // 用 Electron 自带 Node 运行，打包后也不需要用户安装 Python
    const child = spawn(process.execPath, [QR_SCRIPT], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    helper = child;
    helperOwned = true;
    helperSince = Date.now();
    child.on('exit', () => {
      if (helper === child) helper = null;
      if (quitting) return;
      // 端口被旧助手占用、脚本报错等情况会让助手启动后立刻退出。
      // 稳定运行超过 30 秒后重置退避；否则按 3s→10s→30s 重试并留日志。
      if (Date.now() - helperSince > 30000) helperRetry = 0;
      const delay = HELPER_RETRY_MS[Math.min(helperRetry, HELPER_RETRY_MS.length - 1)];
      helperRetry += 1;
      logHelper(`helper exited, retry in ${delay}ms`);
      setTimeout(() => { startHelper().catch(() => {}); }, delay);
    });
  } catch (e) {
    logHelper(`helper spawn failed: ${e.message}`);
  } finally {
    helperStarting = false;
  }
}

function stopHelper() {
  if (helperOwned && helper) {
    try { helper.kill(); } catch {}
    helper = null;
  }
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(statePath(), JSON.stringify({
      ...b,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    }));
  } catch {}
}

function onScreen(b) {
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x
      && b.y < a.y + a.height && b.y + b.height > a.y;
  });
}

function createWindow() {
  const saved = loadWindowState();
  const opts = {
    width: saved.width || 1440,
    height: saved.height || 900,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    title: 'IMI-LAN',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && onScreen(saved)) {
    opts.x = saved.x;
    opts.y = saved.y;
  }

  win = new BrowserWindow(opts);
  if (saved.maximized) win.maximize();
  if (saved.fullscreen) win.setFullScreen(true);
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${API_URL}/?app=1&t=${Date.now()}`);
  win.on('close', ev => {
    saveWindowState();
    if (quitting) return;
    ev.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('enter-full-screen', scheduleSave);
  win.on('leave-full-screen', scheduleSave);
  if (PROBE) runProbe();
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowState, 400);
}

function createTray() {
  const icon = path.join(__dirname, 'assets', 'icon-32.png');
  tray = new Tray(icon);
  tray.setToolTip('IMI-LAN');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开监控', click: showWindow },
    {
      label: '重启引擎',
      click: async () => {
        const ok = await restartEngine();
        if (!ok) dialog.showErrorBox('重启失败', '请检查 go2rtc 配置，或运行「启动监控.bat」。');
      },
    },
    ...(app.isPackaged ? [{
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => {
        try {
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
        } catch (e) {
          dialog.showErrorBox('设置失败', e.message);
        }
      },
    }] : []),
    { label: '修复网络权限（管理员）', click: () => shell.openPath(FW_BAT) },
    { label: '打开程序目录', click: () => shell.openPath(ROOT) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

async function runProbe() {
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await sleep(25000);
  const cards = await win.webContents.executeJavaScript(`(() => Array.from(document.querySelectorAll('.card')).map(c => {
    const el = c.querySelector('video-stream');
    const v = el && el.video;
    return {
      name: c.dataset.name,
      title: c.querySelector('.card-title b')?.textContent,
      badge: c.querySelector('.badge')?.textContent,
      link: c.querySelector('.link')?.textContent,
      mode: el && el.querySelector('.mode')?.textContent,
      w: v && v.videoWidth,
      h: v && v.videoHeight,
      ready: v && v.readyState,
      err: v && v.error && v.error.code
    };
  }))()`);
  fs.writeFileSync(path.join(LOG_DIR, 'probe.json'), JSON.stringify(cards, null, 2));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(LOG_DIR, 'probe.png'), img.toPNG());
  quitting = true;
  app.quit();
}

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  const ok = await startEngine();
  if (!ok) {
    app.quit();
    return;
  }
  await startHelper();
  // 每 10 秒兜底检查一次引擎是否还活着（见 watchEngine 注释）
  setInterval(() => { watchEngine().catch(() => {}); }, 10000);
  createWindow();
  createTray();
  if (app.isPackaged && !PROBE) {
    const flag = path.join(app.getPath('userData'), 'firewall-notice-v1');
    if (!fs.existsSync(flag)) {
      dialog.showMessageBox({
        type: 'info',
        title: 'IMI-LAN',
        message: '如果摄像头一直显示连接超时：右键托盘图标 →「修复网络权限（管理员）」，完成后点「重启引擎」。',
        buttons: ['知道了'],
        noLink: true,
      });
      try { fs.writeFileSync(flag, '1'); } catch {}
    }
  }
  app.on('activate', showWindow);
});

// 关闭窗口时隐藏到托盘，由托盘菜单退出
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  saveWindowState();
  stopEngine();
  stopHelper();
});

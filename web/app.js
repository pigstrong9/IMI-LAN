/* IMI-LAN · 局域网直连
 * 前端只与本机 go2rtc (127.0.0.1:19840) 通信。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  engine: null,
  engineOK: false,
  streams: {},
  meta: loadJSON('imi.meta', {}),
  region: localStorage.getItem('imi.region') || 'cn',
  user: localStorage.getItem('imi.user') || '',
  muted: true,
  cards: new Map(),      // name -> card controller
  pageHidden: false,     // 页面不可见：停止轮询、禁止新 mount；是否断流由 bgPaused / viewer 状态决定
  devices: [],
  viewer: null,          // {name, player, recorder, microphone}
  paused: new Set(loadJSON('imi.paused', [])),   // 用户手动暂停的摄像头
  settings: { layout: '1x1', gridLayout: '2x2', scope: 'room', display: 'fill', box: 'auto', fit: 'cover', hideBattery: true, keepAlive: true, bgSleep: true, theme: 'auto', roomLayouts: {}, ptzFlip: 'none', ptzStep: 1, setTab: 'display', ...loadJSON('imi.settings', {}) },
  streamUrls: {},        // name -> 配置里的流地址（/api/streams 激活后不含 url）
  roomData: cachedRooms(), // 本地助手 /rooms 返回的米家房间与设备映射（启动时先用上次缓存）
};

// NAS 版由内置网关把二维码助手代理到同源；桌面版仍直连本机 19841
const QR_ORIGIN = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname)
  ? `${location.protocol}//127.0.0.1:19841`
  : '';

// 桌面版加载页面时带 ?app=1，用来区分提示语（托盘重启 vs 运行 bat）
const IS_APP = new URLSearchParams(location.search).has('app');
// 安卓 WebView：主码流多为 H.265，移动端硬解不稳定，默认走子码流（一般是 H.264）。
// 只有安卓壳会注入 IMIAndroid 桥；桌面版和浏览器里这个值为 false。
const PREFER_SD = !!(window.IMIAndroid && window.IMIAndroid.preferSD && window.IMIAndroid.preferSD());

// 安卓壳通过 IMIShell 桥同步系统栏：网页全屏时隐藏状态栏/导航栏。
// 壳内不再走元素全屏（WebView 的 onShowCustomView 会另起一层视图，
// 只渲染全屏元素，右上角的退出按钮会跟着消失）；桌面浏览器仍用标准全屏。
const HAS_SHELL = !!(window.IMIShell && window.IMIShell.setFullscreen);
function setNativeFullscreen(on) {
  try { window.IMIShell?.setFullscreen?.(!!on); } catch {}
}
function requestWebFullscreen(el) {
  if (HAS_SHELL) return;
  el?.requestFullscreen?.().catch(() => {});
}
function exitWebFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// 后台保持连接最多维持 2 分钟，之后释放视频解码与引擎缓冲，回到前台自动重连
const BACKGROUND_IDLE_MS = 2 * 60 * 1000;
const HIDDEN_GRACE_MS = 4 * 1000;
const RESUME_STAGGER_MS = 450;
let bgTimer = 0;
let resumeToken = 0;
let pollTimers = [];
let authToastAt = 0;
let roomSyncFailed = false;
// 双击退出单画面后，浏览器还会补发一次 dblclick；短暂吞掉它，避免又触发卡片的双击打开
let viewerDblUntil = 0;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function cachedRooms() {
  const data = loadJSON('imi.rooms', null);
  return data && Array.isArray(data.devices) ? data : null;
}

/* 每个摄像头最近一帧：切画面、重连、换画质时先铺这张图，别直接黑屏。
   只放内存不落盘（一帧 480 长边约 25KB），最多留 12 台。 */
const stills = new Map();
const STILL_MAX = 12;

function rememberStill(name, video) {
  if (!name || !video) return;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  try {
    const scale = Math.min(1, 480 / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/jpeg', 0.7);
    stills.delete(name);
    stills.set(name, url);
    while (stills.size > STILL_MAX) stills.delete(stills.keys().next().value);
  } catch {
    // 跨域流会把 canvas 标成 tainted，取不到就算了，不影响播放
  }
}

function stillOf(name) {
  return (name && stills.get(name)) || '';
}

function saveMeta() {
  localStorage.setItem('imi.meta', JSON.stringify(state.meta));
}

/**
 * 复制一段文字。安卓 WebView 里 navigator.clipboard 只在部分版本可用，
 * 失败就退回 textarea + execCommand，这条路在 WebView 里一直是通的。
 */
function copyText(text, label) {
  const value = (text || '').trim();
  if (!value || value === '—') {
    toast('暂无可复制的内容', true);
    return;
  }
  const done = () => toast(`${label}已复制`);
  const legacy = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, value.length);
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (_) {
      toast('复制失败，可长按选中手动复制', true);
    }
  };
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(done, legacy);
      return;
    }
  } catch (_) { /* 落到 legacy */ }
  legacy();
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', !!isError);
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, { cache: 'no-store', ...options });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    const err = new Error(body || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return res.json();
  return res.text();
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pad(n) { return String(n).padStart(2, '0'); }

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function download(blob, filename) {
  if (window.IMIAndroid && window.IMIAndroid.beginDownload) {
    saveBlobToAndroid(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// WebView 里 <a download> 保存 blob 不会触发下载，分块交给安卓壳写入相册
async function saveBlobToAndroid(blob, filename) {
  let id = '';
  try {
    id = window.IMIAndroid.beginDownload(filename, blob.type || 'application/octet-stream');
    const CHUNK = 512 * 1024;
    for (let off = 0; off < blob.size; off += CHUNK) {
      const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      window.IMIAndroid.appendDownload(id, btoa(bin));
    }
    window.IMIAndroid.finishDownload(id);
    id = '';
  } catch (e) {
    if (id) window.IMIAndroid.abortDownload(id);
    toast('保存失败：' + e.message, true);
  }
}

function parseInfo(info) {
  const m = String(info || '').match(/ip:\s*([^,]+),\s*mac:\s*(.+)/i);
  return { ip: m ? m[1].trim() : '', mac: m ? m[2].trim() : '' };
}

function shortModel(model) {
  return String(model || '').replace(/^chuangmi\.camera\./, '').replace(/^mijia\.camera\./, 'mijia.');
}

function icon(id, cls = 'ic') {
  return `<svg class="${cls}"><use href="#${id}"/></svg>`;
}

function maskUser(value) {
  const s = String(value || '');
  if (!s) return '未登录';
  if (s.length <= 4) return '****';
  if (s.length <= 6) return s.slice(0, 2) + '****' + s.slice(-2);
  if (s.length <= 9) return s.slice(0, 3) + '****' + s.slice(-3);
  return s.slice(0, 3) + '****' + s.slice(-4);
}

function fallbackRoomLabel(name) {
  const title = state.meta[name]?.name || name;
  return String(title).replace(/摄像头$/, '').trim() || title;
}

function streamDid(name) {
  const metaDid = state.meta[name]?.did;
  if (metaDid) return String(metaDid);
  const url = streamUrl(name);
  if (url) {
    try {
      const did = new URL(url).searchParams.get('did');
      if (did) return did;
    } catch {}
  }
  const m = String(name).match(/^cam_(\d+)/);
  return m ? m[1] : '';
}

function roomDevice(name) {
  const did = streamDid(name);
  if (!did || !state.roomData?.devices) return null;
  return state.roomData.devices.find(d => String(d.did) === did) || null;
}

function roomLabel(name) {
  return roomDevice(name)?.room || fallbackRoomLabel(name);
}

function displayCameraName(name) {
  return state.meta[name]?.name || name;
}

// 米家里改过昵称后，把本地助手 /rooms 返回的云端 name 按 did 合并进 meta。
// 以前昵称只在「添加摄像头」时写入 localStorage，之后再也不更新，
// 所以米家改名 / 刷新页面都看不到变化。这里以云端为准同步过来。
function applyRoomNames() {
  const devices = state.roomData?.devices;
  if (!Array.isArray(devices)) return;
  const byDid = new Map();
  for (const d of devices) {
    const did = String(d?.did || '');
    if (did && d.name) byDid.set(did, String(d.name));
  }
  if (!byDid.size) return;
  let changed = false;
  for (const name of Object.keys(state.meta)) {
    const cloudName = byDid.get(String(streamDid(name)));
    if (cloudName && state.meta[name].name !== cloudName) {
      state.meta[name].name = cloudName;
      changed = true;
    }
  }
  if (changed) {
    saveMeta();
    refreshCameraNames();
  }
}

// 名称写入 meta 后，刷新界面上所有显示摄像头名称 / 房间名的地方
function refreshCameraNames() {
  for (const [name, card] of state.cards) {
    const title = displayCameraName(name);
    const hero = $('[data-role="heroName"]', card.el);
    if (hero) { hero.textContent = title; hero.title = title; }
    const room = $('.card-title b', card.el);
    if (room) room.textContent = roomLabel(name);
  }
  if (state.viewer && $('#viewerName')) {
    $('#viewerName').textContent = displayCameraName(state.viewer.name);
  }
  const single = $('#singleSelect');
  if (single) {
    for (const opt of single.options) {
      const title = displayCameraName(opt.value);
      if (opt.textContent !== title) opt.textContent = title;
    }
  }
  renderViewerChips();
}

function cameraOnline(name) {
  const device = roomDevice(name);
  if (device) return !!device.online;
  return isOnline(name);
}

function roomIcon(label) {
  if (/卧|床|主卧|次卧/.test(label)) return 'i-bed';
  if (/餐|厨|饭/.test(label)) return 'i-dining';
  if (/客厅|沙发|起居|厅/.test(label)) return 'i-sofa';
  if (/儿童|宝宝|婴儿|nursery/i.test(label)) return 'i-crib';
  if (/门|玄关|入户|阳台|院|花园/.test(label)) return 'i-door';
  return 'i-camera';
}

function layoutName(layout) {
  return { '1x1': '1窗口', '2x2': '4窗口', '3x2': '6窗口', '3x3': '9窗口', all: '全部' }[layout] || '1窗口';
}

function layoutIcon(layout) {
  return { '1x1': 'i-grid1', '2x2': 'i-grid2', '3x2': 'i-grid3', '3x3': 'i-grid9' }[layout] || 'i-grid1';
}

function themeMode() {
  return state.settings.theme || 'auto';
}

// 安卓 WebView 里 prefers-color-scheme 不一定可靠：改系统深色模式时页面不会重建，
// change 事件也未必往网页派发。所以读数统一走这里，并在多个时机主动重算。
// 优先级：壳的推送 > 壳的桥 > matchMedia。壳接管 uiMode 后 WebView 的
// prefers-color-scheme 可能停在旧值，所以启动时经 IMIShell 问一次，切系统主题时由壳推。
let shellDark = null;

function systemPrefersDark() {
  if (shellDark !== null) return shellDark;
  try {
    const bridge = window.IMIShell;
    if (bridge && typeof bridge.isNightMode === 'function') {
      const v = bridge.isNightMode();
      if (typeof v === 'boolean') return v;
    }
  } catch (_) { /* 桌面浏览器没有桥，走下面的 matchMedia */ }
  try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) { return false; }
}

function resolvedDark(mode) {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemPrefersDark();
}

// 自动模式下把系统读数写回设置面板：读得对不对一眼就能看出来，不用猜。
function updateThemeHint(mode = themeMode(), dark = resolvedDark(mode)) {
  const el = $('#themeHint');
  if (!el) return;
  if (mode === 'auto') {
    el.textContent = `自动：跟随手机的深色模式（当前判定为${dark ? '深色' : '浅色'}）`;
  } else if (mode === 'light') {
    el.textContent = '始终使用亮色，不跟随手机';
  } else {
    el.textContent = '始终使用深色，不跟随手机';
  }
}

/**
 * 壳的窗口底色与系统栏图标跟着「实际生效的外观」走，而不是跟着系统深浅色。
 * 手动选暗色时手机还是浅色模式，壳只按 isNightMode() 判断会把状态栏那条留成
 * 白色，和暗色页面拼在一起非常割裂。所以每次应用主题都通知壳一次。
 */
function syncShellChrome(dark) {
  try {
    const bridge = window.IMIShell;
    if (bridge && typeof bridge.setDarkChrome === 'function') bridge.setDarkChrome(!!dark);
  } catch (_) { /* 桌面浏览器 / 旧版壳没有这个桥 */ }
}

function applyTheme(mode, persist = true) {
  state.settings.theme = mode;
  if (persist) saveSettings();
  const dark = resolvedDark(mode);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('#btnTheme');
  if (btn) {
    btn.innerHTML = icon(mode === 'auto' ? 'i-auto' : mode === 'light' ? 'i-sun' : 'i-moon');
    btn.title = `主题：${mode === 'auto' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色'}（点击切换）`;
  }
  $$('#themeSeg [data-theme]').forEach(b => b.classList.toggle('on', b.dataset.theme === mode));
  updateThemeHint(mode, dark);
  syncShellChrome(dark);
}

// 回到前台 / 页面重新可见 / 窗口获焦时重算一次自动主题，
// 弥补 WebView 不派发 prefers-color-scheme change 的情况。
function resyncAutoTheme() {
  if (themeMode() !== 'auto') return;
  if (document.documentElement.dataset.theme !== (systemPrefersDark() ? 'dark' : 'light')) {
    applyTheme('auto', false);
  } else {
    updateThemeHint();
  }
}

// 安卓壳声明了 uiMode 变化由自己处理（configChanges 含 uiMode），页面不会重建。
// 切系统深浅色时壳会主动调这个函数，让自动模式立刻跟上。
window.__imiResyncTheme = resyncAutoTheme;
// 壳在系统深浅色变化时推过来；传 null（或非布尔）表示交回 matchMedia 自己判断。
window.__imiSetSystemDark = (v) => {
  shellDark = typeof v === 'boolean' ? v : null;
  resyncAutoTheme();
};

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  applyTheme(order[(order.indexOf(themeMode()) + 1) % order.length]);
}

function updateLayoutUI() {
  const layout = state.settings.layout;
  const label = $('#layoutLabel');
  if (label) label.textContent = layoutName(layout);
  const ico = $('#layoutIcon use');
  if (ico) ico.setAttribute('href', '#' + layoutIcon(layout));
  $$('#layoutMenu [data-layout]').forEach(b => b.classList.toggle('on', b.dataset.layout === layout));
  $$('#layoutTiles [data-layout-grid]').forEach(b => b.classList.toggle('on', b.dataset.layoutGrid === layout));
  const sel = $('#setLayout');
  if (sel) sel.value = layout;
  const tools = $('#gridTools');
  if (tools) tools.hidden = layout === '1x1';
  const box = state.settings.box || 'auto';
  const fit = state.settings.fit || 'cover';
  $$('#boxSeg [data-box]').forEach(b => b.classList.toggle('on', b.dataset.box === box));
  $$('#fitSeg [data-fit]').forEach(b => b.classList.toggle('on', b.dataset.fit === fit));
}

/**
 * 切换「填充方式」时已连上的播放器不会重建（重建就要重新握手、画面闪一下），
 * 所以直接把 object-fit 改到现有 video 上；之后新建的播放器仍走 makePlayer 的选项。
 */
function applyFitLive() {
  const fit = state.settings.fit === 'contain' ? 'contain' : 'cover';
  document.querySelectorAll('.card-media video, #viewerStage video').forEach((v) => {
    v.style.objectFit = fit;
  });
}

function closeLayoutMenu() {
  $('#layoutMenu')?.classList.remove('on');
  $('#btnLayout')?.setAttribute('aria-expanded', 'false');
}

function layoutScopeKey() {
  if (state.settings.scope === 'all') return 'all';
  const name = state.settings.single;
  return name ? roomLabel(name) : '';
}

function rememberLayout() {
  if (!state.settings.roomLayouts || typeof state.settings.roomLayouts !== 'object') {
    state.settings.roomLayouts = {};
  }
  const key = layoutScopeKey();
  if (key) state.settings.roomLayouts[key] = state.settings.layout;
}

function savedLayoutFor(key) {
  const saved = state.settings.roomLayouts?.[key];
  return LAYOUTS[saved] ? saved : (state.settings.gridLayout || '2x2');
}

function selectLayout(layout) {
  if (!LAYOUTS[layout] && layout !== 'all') layout = '2x2';
  state.settings.layout = layout;
  if (layout === 'all') state.settings.scope = 'all';
  if (layout !== '1x1' && layout !== 'all') state.settings.gridLayout = layout;
  const key = layoutScopeKey();
  if (key) {
    if (!state.settings.roomLayouts || typeof state.settings.roomLayouts !== 'object') {
      state.settings.roomLayouts = {};
    }
    state.settings.roomLayouts[key] = layout;
  }
  saveSettings();
  closeLayoutMenu();
  updateLayoutUI();
  refreshStreams();
}

function selectRoom(name) {
  rememberLayout();
  state.settings.single = name;
  state.settings.scope = 'room';
  // 手机上点房间 = 看这一路：保持单画面。原来会回落到 gridLayout（默认 2x2），
  // 于是每点一次摄像机都被弹成 4 宫格。
  state.settings.layout = narrowScreen() ? '1x1' : savedLayoutFor(roomLabel(name));
  saveSettings();
  closeLayoutMenu();
  updateLayoutUI();
  refreshStreams();
}

function selectAllRooms() {
  rememberLayout();
  state.settings.scope = 'all';
  state.settings.layout = savedLayoutFor('all');
  saveSettings();
  closeLayoutMenu();
  updateLayoutUI();
  refreshStreams();
}

const LAYOUTS = {
  '1x1': { cols: 1, limit: 1 },
  '2x2': { cols: 2, limit: 4 },
  '3x2': { cols: 3, limit: 6 },
  '3x3': { cols: 3, limit: 9 },
  all: { cols: 3, limit: 0 },
};

function layoutSpec() {
  return LAYOUTS[state.settings.layout] || LAYOUTS['2x2'];
}

// 首页布局要同时满足：媒体区按所选比例、不裁剪、尽量铺满窗口。
// 宽度受限时按宽度算；高度受限时按高度反推卡片宽度，再整体居中。
/** 「窗口比例」的数值形式；自适应（auto）返回 0，表示由窗口决定。 */
function boxAspect() {
  const box = state.settings.box || 'auto';
  if (box === '4:3') return 4 / 3;
  if (box === '16:9') return 16 / 9;
  return 0;
}

function fitGrid(count) {
  const grid = $('#grid');
  if (document.body.classList.contains('wall')) return;
  if (!grid.classList.contains('fit') || grid.classList.contains('fill')) {
    grid.style.removeProperty('--grid-card-w');
    grid.style.removeProperty('--grid-row-h');
    return;
  }

  const spec = layoutSpec();
  const cols = spec.cols;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
  const availW = grid.clientWidth;
  const availH = grid.clientHeight;
  if (!availW || !availH) return;

  const rows = spec.limit ? Math.ceil(spec.limit / cols) : Math.max(1, Math.ceil(count / cols));
  const ar = boxAspect(); // 16:9 或 4:3，自适应布局不会走到这里
  const byWidth = (availW - gap * (cols - 1)) / cols;
  const byHeight = (availH - gap * (rows - 1)) / rows * ar;
  const width = Math.max(200, Math.floor(Math.min(byWidth, byHeight)));
  const rowH = Math.ceil((width - 2) / ar);
  grid.style.setProperty('--grid-card-w', width + 'px');
  grid.style.setProperty('--grid-row-h', rowH + 'px');
}

function saveSettings() {
  localStorage.setItem('imi.settings', JSON.stringify(state.settings));
}

function savePaused() {
  localStorage.setItem('imi.paused', JSON.stringify([...state.paused]));
}

function cameraList() {
  return Object.keys(state.streams).filter(name =>
    !state.settings.hideBattery || !isBatteryModel(streamInfo(name).model)
  );
}

function cardStatus(name) {
  const card = state.cards.get(name);
  if (!card) return 'live';
  if (card.isSuspended?.()) return 'warn';
  return card.isLive?.() ? 'live' : 'err';
}

// 单路模式只会挂载当前摄像头；未挂载的设备按“已配置在线”处理，
// 已挂载则以播放器实际状态为准。
function isOnline(name) {
  const card = state.cards.get(name);
  if (!card) return true;
  if (card.isSuspended?.()) return true;
  return !!card.isLive?.();
}

function updateOnlineStatus() {
  const names = cameraList();
  const live = names.filter(cameraOnline).length;
  const foot = $('#footOnline');
  if (foot) foot.textContent = `${live} / ${names.length} 路在线`;

  const badge = $('#onlineBadge');
  if (!badge) return;
  if (state.settings.layout === '1x1') {
    const active = state.settings.single;
    const card = state.cards.get(active);
    const on = card ? !!card.isLive?.() : cameraOnline(active);
    badge.className = 'online-badge' + (on ? '' : card || roomDevice(active) ? ' warn' : ' err');
    badge.innerHTML = `<i></i>${on ? '在线' : card || roomDevice(active) ? '连接中' : '离线'}`;
  } else {
    badge.className = 'online-badge';
    badge.innerHTML = `<i></i>${live}/${names.length} 在线`;
  }
}

// 房间条上一次渲染的签名：每 5 秒整体 innerHTML 重建会连带重排整个侧栏
let roomsSig = '';

function renderRooms() {
  const box = $('#roomList');
  if (!box) return;
  const names = cameraList();
  if (!names.length) {
    if (roomsSig !== '@empty') {
      box.innerHTML = '<div class="room-empty">还没有摄像头</div>';
      roomsSig = '@empty';
    }
    updateOnlineStatus();
    return;
  }

  const groups = new Map();
  for (const name of names) {
    const label = roomLabel(name);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(name);
  }

  const allLive = names.filter(cameraOnline).length;
  const scopeAll = state.settings.scope === 'all';
  const activeRoom = scopeAll ? '' : roomLabel(state.settings.single || '');

  const sig = names.map(n => n + ':' + roomLabel(n) + ':' + (cameraOnline(n) ? 1 : 0)).join('|')
    + '#' + scopeAll + '#' + activeRoom;
  if (sig === roomsSig) {
    updateOnlineStatus();
    return;
  }
  roomsSig = sig;

  let html = '';
  for (const [label, group] of groups) {
    const live = group.filter(cameraOnline).length;
    const active = !scopeAll && label === activeRoom;
    html += `
      <button class="room ${active ? 'on' : ''}" data-room="${escapeHTML(group[0])}" title="${escapeHTML(label)} · ${live}/${group.length} 在线" aria-current="${active ? 'true' : 'false'}">
        <span class="room-ico">${icon(roomIcon(label))}<i class="room-dot ${live ? '' : 'err'}"></i></span>
        <b>${escapeHTML(label)}</b>
        <em>${live}/${group.length}</em>
      </button>`;
  }
  html += `
    <button class="room ${scopeAll ? 'on' : ''}" data-all="1" title="全部房间 · ${allLive}/${names.length} 在线" aria-current="${scopeAll ? 'true' : 'false'}">
      <span class="room-ico">${icon('i-grid9')}</span>
      <b>全部房间</b>
      <em>${allLive}/${names.length}</em>
    </button>`;
  box.innerHTML = html;

  // 手机上是横向滚动条：把当前选中的摄像机滚到可视区中间。
  // 不用 scrollIntoView —— 它会连带滚动所有可滚祖先，横向条里容易把页面一起带跑。
  if (box.scrollWidth > box.clientWidth) {
    const on = box.querySelector('.room.on');
    if (on) {
      const target = on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2;
      box.scrollLeft = Math.max(0, Math.min(target, box.scrollWidth - box.clientWidth));
    }
  }

  updateOnlineStatus();
}

/* 信号条：按摄像头下行码率估算，1 格红 / 2-3 格黄 / 4-5 格绿 */
const signalSamples = new Map();   // name -> { bytes, at, ema }
let signalBusy = false;

function levelForRate(mbps) {
  if (mbps >= 1.5) return 5;
  if (mbps >= 1.0) return 4;
  if (mbps >= 0.6) return 3;
  if (mbps >= 0.3) return 2;
  return 1;
}

// 手机上码率信息是隐藏的，没必要每 2 秒取一次数据再写 DOM
let lastSignalAt = 0;

async function pollSignals() {
  if (state.pageHidden || state.viewer || signalBusy || !state.cards.size) return;
  if (narrowScreen() && Date.now() - lastSignalAt < 10000) return;
  lastSignalAt = Date.now();
  signalBusy = true;
  try {
    const data = await api('/api/streams');
    const now = Date.now();
    for (const [name, card] of state.cards) {
      if (card.isSuspended()) {
        signalSamples.delete(name);
        card.setSignal(0, '链路质量 · 已暂停');
        continue;
      }
      const producer = (data[name]?.producers || [])[0];
      let bytes = producer?.bytes_recv;
      if (typeof bytes !== 'number' && Array.isArray(producer?.receivers)) {
        bytes = producer.receivers.reduce((sum, r) => sum + (r.bytes || 0), 0);
      }
      const active = !!producer?.protocol;
      if (typeof bytes !== 'number' || !active) {
        signalSamples.delete(name);
        card.setSignal(0, card.isSuspended() ? '链路质量 · 已暂停' : '链路质量 · 未连接');
        continue;
      }

      const prev = signalSamples.get(name);
      if (!prev) {
        signalSamples.set(name, { bytes, at: now, ema: 0 });
        card.setSignal(0, '链路质量 · 测速中…');
        continue;
      }

      let rate = 0;
      if (bytes >= prev.bytes && now > prev.at) {
        rate = (bytes - prev.bytes) * 8 / ((now - prev.at) / 1000) / 1e6;
      }
      const ema = prev.ema ? prev.ema * 0.6 + rate * 0.4 : rate;
      signalSamples.set(name, { bytes, at: now, ema });

      const level = levelForRate(ema);
      card.setSignal(level, `链路质量 ${level}/5 · 下载 ${ema.toFixed(2)} Mbps`);
    }
    updateOnlineStatus();
  } catch {}
  signalBusy = false;
}

function updateSingleNav(names) {
  const nav = $('#singleNav');
  const show = state.settings.layout === '1x1' && names.length > 1;
  nav.hidden = !show;
  if (!show) return;
  const sel = $('#singleSelect');
  const sig = names.join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = names.map(name => {
      const title = state.meta[name]?.name || name;
      return `<option value="${escapeHTML(name)}">${escapeHTML(title)}</option>`;
    }).join('');
  }
  if (sel.value !== state.settings.single) {
    sel.value = state.settings.single || names[0];
  }
}

// 手机窄屏判定，与 CSS 的 600px 断点保持一致
function narrowScreen() {
  try { return matchMedia('(max-width: 600px)').matches; } catch (_) { return false; }
}

// 触屏判定：决定「单击卡片是否直接进单画面」
function pointerCoarse() {
  try { return matchMedia('(pointer: coarse)').matches; } catch (_) { return false; }
}

// 单画面刚打开的时刻：手指第二下落下时要忽略，否则会被当成「双击退出」
let viewerOpenedAt = 0;

// 轻触反馈：安卓 / 鸿蒙 有振动马达，iOS 浏览器忽略即可
function haptic(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (_) {}
}

function stepSingle(dir) {
  const names = cameraList();
  if (names.length < 2) return;
  let i = names.indexOf(state.settings.single);
  if (i < 0) i = 0;
  state.settings.single = names[(i + dir + names.length) % names.length];
  saveSettings();
  refreshStreams();
}

// 单画面左右滑动切换摄像机：HIG 与鸿蒙都以此为主手势，
// 比去够顶部的下拉框顺手得多。缩放手势开启或落在按钮上时不接管。
let swipeX = 0, swipeY = 0, swipeAt = 0, swipeOn = false;

function bindSwipeSwitch() {
  const host = document.querySelector('.stage-body');
  if (!host) return;

  host.addEventListener('touchstart', ev => {
    swipeOn = false;
    if (state.viewer) return;
    if (state.settings.layout !== '1x1') return;
    if (ev.touches.length !== 1) return;
    if (ev.target.closest('button, .card-tools, .card-menu-btn, .zoom-hud, .zoom-on')) return;
    const t = ev.touches[0];
    swipeX = t.clientX; swipeY = t.clientY; swipeAt = Date.now();
    swipeOn = true;
  }, { passive: true });

  host.addEventListener('touchend', ev => {
    if (!swipeOn) return;
    swipeOn = false;
    const t = ev.changedTouches && ev.changedTouches[0];
    if (!t) return;
    if (Date.now() - swipeAt > 700) return;
    const dx = t.clientX - swipeX;
    const dy = t.clientY - swipeY;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    stepSingle(dx < 0 ? 1 : -1);
    haptic();
  }, { passive: true });
}

function isBatteryModel(model) {
  return /\.(cateye|feeder|chime)\./i.test(model || '');
}

function parseStreamUrls(text) {
  const out = {};
  let inStreams = false;
  let current = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^streams:\s*$/.test(line)) { inStreams = true; continue; }
    if (!inStreams) continue;
    if (/^\S/.test(line)) break;
    const name = line.match(/^\s+([^:\s]+):\s*$/);
    if (name) { current = name[1]; continue; }
    const url = line.match(/^\s*-\s*(\S+)/);
    if (url && current) { out[current] = url[1]; current = ''; }
  }
  return out;
}

let configFetchedAt = 0;

async function loadStreamUrls() {
  configFetchedAt = Date.now();
  try {
    state.streamUrls = parseStreamUrls(await api('/api/config'));
  } catch {}
}

async function ensureStreamUrls(names) {
  if (!names.some(name => !state.streamUrls[name])) return;
  if (Date.now() - configFetchedAt < 30000) return;
  await loadStreamUrls();
}

function streamUrl(name) {
  return state.streamUrls[name] || state.streams[name]?.producers?.[0]?.url || '';
}

// 卡片信息优先用导入时保存的元数据，缺失时从流地址回退解析
function streamInfo(name) {
  const meta = state.meta[name] || {};
  let model = meta.model || '';
  let ip = meta.ip || '';
  const url = streamUrl(name);
  if (url) {
    try {
      const u = new URL(url);
      if (!model) model = u.searchParams.get('model') || '';
      if (!ip) ip = u.hostname || '';
    } catch {}
  }
  return { meta, model, ip };
}

function setEngine(ok, text) {
  state.engineOK = ok;
  const box = $('#engine');
  box.classList.toggle('ok', ok);
  box.classList.toggle('bad', !ok);
  $('#engineText').textContent = text;
}

/* ------------------------------------------------------------------ */
/* engine / stream list                                                */
/* ------------------------------------------------------------------ */

async function checkEngine() {
  if (state.pageHidden) return;
  const wasOK = state.engineOK;
  try {
    const info = await api('/api');
    state.engine = info;
    setEngine(true, `引擎 ${info.version || ''} 运行中`);
    $('#engineVersion').textContent = info.version || '—';
    $('#setVersion').textContent = info.version || '—';
    // 引擎重启后旧的 video 元素容易卡在错误状态，重建一次播放器
    if (!wasOK) {
      for (const card of state.cards.values()) card.reload();
    }
  } catch {
    setEngine(false, IS_APP
      ? '引擎未启动 · 稍等约 10 秒会自动重启，也可右键托盘图标选「重启引擎」'
      : '引擎未启动 · 请运行“启动监控.bat”');
  }
}

// 上一次渲染用的布局签名：可见集合与布局都没变时，不再写 DOM
let lastGridSig = '';

async function refreshStreams() {
  if (state.pageHidden) return;
  let data;
  try {
    data = await api('/api/streams');
  } catch {
    return;
  }

  state.streams = data || {};
  const allNames = Object.keys(state.streams);
  await ensureStreamUrls(allNames);
  const spec = layoutSpec();

  const candidates = cameraList();
  if (candidates.length && !candidates.includes(state.settings.single)) {
    state.settings.single = candidates[0];
    saveSettings();
  }

  let pool = candidates;
  if (state.settings.layout !== '1x1' && state.settings.scope === 'room' && state.settings.single) {
    const activeRoom = roomLabel(state.settings.single);
    const scoped = candidates.filter(name => roomLabel(name) === activeRoom);
    if (scoped.length) pool = scoped;
  }

  let visible;
  if (state.settings.layout === '1x1') {
    visible = pool.includes(state.settings.single)
      ? [state.settings.single]
      : (pool[0] ? [pool[0]] : []);
  } else {
    visible = pool;
    if (spec.limit) visible = visible.slice(0, spec.limit);
  }
  updateSingleNav(candidates);

  const single = state.settings.layout === '1x1';
  const cols = single ? 1 : spec.cols;
  const rows = single ? 1 : (spec.limit ? Math.ceil(spec.limit / spec.cols) : Math.max(1, Math.ceil(visible.length / spec.cols)));

  // 原来这里每 5 秒无条件重设 grid 变量、重建空窗口、重算 fitGrid，
  // 会强制整页重排一次；视频正在解码时就是肉眼可见的周期性卡顿。
  // 布局与可见集合都没变化时直接跳过，只做不产生重排的轻量更新。
  const gridSig = [
    state.settings.layout, state.settings.box, state.settings.fit, cols, rows,
    visible.join('|'), allNames.length, spec.limit || 0,
    // 卡片数量也要进签名：清空 / 删除一路会先销毁卡片再回来重建，
    // 只比对 names 与布局的话会漏掉这一种，导致画面空白。
    state.cards.size,
  ].join('#');
  if (gridSig === lastGridSig) {
    // 布局没变也要对齐云台状态：从查看器回到 1×1 时卡片开关要重新出现
    syncCardPtz(single && !state.viewer ? visible[0] || '' : '');
    updateLayoutUI();
    updateSettings();
    renderRooms();
    updateOnlineStatus();
    return;
  }
  lastGridSig = gridSig;

  $('#grid').querySelectorAll('.grid-slot').forEach(el => el.remove());

  visible.forEach((name, i) => {
    if (!state.cards.has(name)) createCard(name, i * 600);
  });
  for (const [name, card] of state.cards) {
    if (!visible.includes(name)) {
      if (state.viewer?.name === name) closeViewer();
      // 方向盘可能临时挂在卡片里，销毁卡片前先移回去，别跟着 DOM 一起被删掉
      restorePtzPad();
      card.destroy();
      state.cards.delete(name);
    }
  }

  // 1×1 单窗口也支持云台：只探当前这一张，开关长在卡片工具栏里
  syncCardPtz(single && !state.viewer ? visible[0] || '' : '');

  const grid = $('#grid');
  grid.style.setProperty('--grid-cols', String(cols));
  grid.style.setProperty('--grid-rows', String(rows));
  grid.dataset.layout = state.settings.layout;
  grid.classList.toggle('single', single);
  grid.classList.toggle('fit', !single && state.settings.layout !== 'all');
  // 「自适应」＝格子随窗口铺满（原来的「铺满窗口」）；16:9 / 4:3 则按比例排布
  const ar = boxAspect();
  grid.classList.toggle('fill', ar === 0);
  grid.style.setProperty('--card-ar', ar === 4 / 3 ? '4 / 3' : '16 / 9');

  const hiddenCount = allNames.length - visible.length;
  $('#streamCount').textContent = hiddenCount
    ? `${allNames.length} 路视频 · 显示 ${visible.length}`
    : `${allNames.length} 路视频`;

  const capacity = spec.limit || 0;
  if (capacity > visible.length) {
    const slots = Array.from({ length: capacity - visible.length }, () =>
      `<button class="grid-slot" data-slot-add type="button">${icon('i-plus')}<span>空窗口</span></button>`
    ).join('');
    grid.insertAdjacentHTML('beforeend', slots);
  }

  const empty = $('#empty');
  empty.style.display = visible.length ? 'none' : 'flex';
  grid.style.display = visible.length ? (single ? 'block' : 'grid') : 'none';
  if (single && visible.length) {
    grid.style.removeProperty('--grid-card-w');
    grid.style.removeProperty('--grid-row-h');
  } else {
    fitGrid(visible.length);
  }

  if (!visible.length) {
    const title = $('#empty h2');
    const text = $('#empty p');
    if (allNames.length) {
      title.textContent = '没有可显示的摄像头';
      text.innerHTML = '门铃/电池设备已被过滤，或首页布局数量不足。<br>可在「设置」里调整布局或关闭过滤。';
    } else {
      title.textContent = '还没有添加摄像头';
      text.innerHTML = '使用小米账号登录后，会自动读取米家设备列表。<br>视频只在本机与摄像头之间通过局域网传输。';
    }
  }

  updateLayoutUI();
  updateSettings();
  renderRooms();
  updateOnlineStatus();
}

function updateSettings() {
  const masked = maskUser(state.user);
  const userEl = $('#setUser');
  if (userEl) userEl.textContent = masked;
  const nameEl = $('#accountName');
  if (nameEl) nameEl.textContent = masked;
  const regionEl = $('#accountRegion');
  if (regionEl) regionEl.textContent = regionName(state.region);
  const setRegion = $('#setRegion');
  if (setRegion) setRegion.textContent = regionName(state.region);
}

/* 设置项涨到十几条后一屏拉不完，按「显示 / 云台 / 其他」分成三页 */
const SET_TABS = ['display', 'ptz', 'more'];

function applySettingsTab(name) {
  const tab = SET_TABS.includes(name) ? name : 'display';
  state.settings.setTab = tab;
  $$('#setTabs [data-set-tab]').forEach(b => {
    const on = b.dataset.setTab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('[data-set-pane]').forEach(p => { p.hidden = p.dataset.setPane !== tab; });
}

// 云台两项设置：方向镜像、轻点步长。纯本地，改完立即生效。
function syncPtzSettingsUI() {
  const flip = state.settings.ptzFlip || 'none';
  $$('#ptzFlipSeg [data-flip]').forEach(b => b.classList.toggle('on', b.dataset.flip === flip));
  const step = String(Math.round(Number(state.settings.ptzStep) || 1));
  $$('#ptzStepSeg [data-step]').forEach(b => b.classList.toggle('on', b.dataset.step === step));
}

function tickClock() {
  const d = new Date();
  const text = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const foot = $('#footClock');
  if (foot) foot.textContent = text;
  const viewer = $('#viewerClock');
  if (viewer) viewer.textContent = text;
}

async function syncRooms(force = false) {
  if (state.pageHidden || !state.user) return;
  try {
    const params = new URLSearchParams({ region: state.region });
    params.set('id', state.user);
    // 手动刷新时带上 force，让助手跳过 10 分钟房间缓存，重读米家的最新昵称
    if (force) params.set('force', '1');
    const res = await fetch(QR_ORIGIN + '/rooms?' + params.toString(), {
      cache: 'no-store',
      // 助手冷启动时要做一次云端登录，超时必须比服务端的 20s 宽松
      signal: AbortSignal.timeout(25000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok || !Array.isArray(data.devices)) {
      throw new Error((data && data.error) || `房间助手返回 ${res.status}`);
    }
    state.roomData = data;
    localStorage.setItem('imi.rooms', JSON.stringify(data));
    roomSyncFailed = false;
    // 以米家云端为准更新昵称（改名后这里才会真正变化），再统一刷新界面
    applyRoomNames();
    refreshCameraNames();
    renderRooms();
    updateOnlineStatus();
  } catch (e) {
    // 只报一次，恢复后再失败才重新提醒，避免每 5 分钟刷屏
    if (!roomSyncFailed) {
      roomSyncFailed = true;
      toast(`读不到米家房间：${e.message}，暂用设备昵称显示`, true);
    }
  }
}

function regionName(region) {
  return {
    cn: '中国大陆', de: '欧洲', i2: '印度', ru: '俄罗斯', sg: '新加坡', us: '美国',
  }[region] || region;
}

/* ------------------------------------------------------------------ */
/* camera cards                                                        */
/* ------------------------------------------------------------------ */

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

// 画面缩放/平移：滚轮、双指捏合或 HUD 缩放，拖动平移，双击复位
function createZoom(surface, { onChange } = {}) {
  if (surface._zoom) return surface._zoom;

  const st = { enabled: false, scale: 1, tx: 0, ty: 0, dragging: false, pointerId: null, sx: 0, sy: 0, stx: 0, sty: 0 };
  const pointers = new Map();
  let pinch = null;
  const hud = document.createElement('div');
  hud.className = 'zoom-hud';
  hud.innerHTML = '<button type="button" data-zoom="-" aria-label="缩小">−</button>'
    + '<button type="button" data-zoom="reset" aria-label="复位">100%</button>'
    + '<button type="button" data-zoom="+" aria-label="放大">+</button>';
  surface.appendChild(hud);
  const level = hud.querySelector('[data-zoom="reset"]');
  const host = () => surface.querySelector('video-stream') || surface.querySelector('video');

  function apply() {
    if (st.scale === 1) { st.tx = 0; st.ty = 0; }
    const el = host();
    if (el) {
      el.style.transformOrigin = 'center center';
      el.style.transform = st.scale === 1 && !st.tx && !st.ty
        ? ''
        : `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
    }
    level.textContent = Math.round(st.scale * 100) + '%';
    level.classList.toggle('at-fit', st.scale === 1);
  }

  function clamp() {
    const r = surface.getBoundingClientRect();
    const maxX = Math.max(0, (st.scale - 1) * r.width / 2);
    const maxY = Math.max(0, (st.scale - 1) * r.height / 2);
    st.tx = Math.min(maxX, Math.max(-maxX, st.tx));
    st.ty = Math.min(maxY, Math.max(-maxY, st.ty));
  }

  function reset() {
    st.scale = 1;
    st.tx = 0;
    st.ty = 0;
    apply();
  }

  function zoomAt(factor, clientX, clientY) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, st.scale * factor));
    if (Math.abs(next - st.scale) < 0.001) return;
    const r = surface.getBoundingClientRect();
    const dx = clientX - r.left - r.width / 2;
    const dy = clientY - r.top - r.height / 2;
    const k = next / st.scale;
    st.tx = dx - (dx - st.tx) * k;
    st.ty = dy - (dy - st.ty) * k;
    st.scale = next;
    clamp();
    apply();
  }

  function startDrag(pointerId, x, y) {
    st.dragging = true;
    st.pointerId = pointerId;
    st.sx = x;
    st.sy = y;
    st.stx = st.tx;
    st.sty = st.ty;
    surface.classList.add('zoom-drag');
  }

  function stopDrag() {
    st.dragging = false;
    st.pointerId = null;
    surface.classList.remove('zoom-drag');
  }

  function startPinch() {
    if (pointers.size < 2) return;
    const [a, b] = pointers.values();
    pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      scale: st.scale,
      tx: st.tx,
      ty: st.ty,
    };
  }

  // 双指捏合：围绕两指中点缩放，并跟随中点移动
  function movePinch() {
    if (!pinch || pointers.size < 2) return;
    const [a, b] = pointers.values();
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.scale * dist / pinch.dist));
    const r = surface.getBoundingClientRect();
    const dx0 = pinch.mx - r.left - r.width / 2;
    const dy0 = pinch.my - r.top - r.height / 2;
    const dx1 = mx - r.left - r.width / 2;
    const dy1 = my - r.top - r.height / 2;
    const k = next / pinch.scale;
    st.scale = next;
    st.tx = dx1 - (dx0 - pinch.tx) * k;
    st.ty = dy1 - (dy0 - pinch.ty) * k;
    clamp();
    apply();
    // 以当前实际状态为新起点，避免缩到 1 倍时平移被清零后再次放大产生跳变
    pinch = { dist, mx, my, scale: st.scale, tx: st.tx, ty: st.ty };
  }

  function setEnabled(on) {
    on = !!on;
    if (st.enabled === on) {
      if (!on) {
        reset();
        pointers.clear();
        pinch = null;
        stopDrag();
      }
      return;
    }
    st.enabled = on;
    pointers.clear();
    pinch = null;
    stopDrag();
    surface.classList.toggle('zoom-on', on);
    hud.classList.toggle('on', on);
    reset();
    onChange?.(on);
  }

  const onWheel = ev => {
    if (!st.enabled) return;
    ev.preventDefault();
    zoomAt(ev.deltaY < 0 ? 1.18 : 1 / 1.18, ev.clientX, ev.clientY);
  };
  const onDown = ev => {
    if (!st.enabled) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ev.target.closest('button, .zoom-hud, .card-tools, .card-menu-btn, [data-act], .mask-btn')) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try { surface.setPointerCapture(ev.pointerId); } catch {}
    if (pointers.size === 1) {
      startDrag(ev.pointerId, ev.clientX, ev.clientY);
    } else if (pointers.size === 2) {
      stopDrag();
      startPinch();
    }
    ev.preventDefault();
  };
  const onMove = ev => {
    if (!st.enabled) return;
    if (pointers.has(ev.pointerId)) {
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }
    if (pointers.size >= 2) {
      if (!pinch) startPinch();
      movePinch();
      ev.preventDefault();
      return;
    }
    if (!st.dragging || ev.pointerId !== st.pointerId) return;
    st.tx = st.stx + ev.clientX - st.sx;
    st.ty = st.sty + ev.clientY - st.sy;
    clamp();
    apply();
  };
  const onUp = ev => {
    pointers.delete(ev.pointerId);
    try { surface.releasePointerCapture(ev.pointerId); } catch {}
    if (pinch) {
      if (pointers.size >= 2) {
        startPinch();
      } else {
        pinch = null;
        stopDrag();
        if (pointers.size === 1) {
          const [id, p] = pointers.entries().next().value;
          startDrag(id, p.x, p.y);
        }
      }
      return;
    }
    if (!st.dragging || ev.pointerId !== st.pointerId) return;
    stopDrag();
  };
  const onDbl = ev => {
    if (!st.enabled || ev.target.closest('button, .card-tools, .zoom-hud')) return;
    ev.preventDefault();
    ev.stopPropagation();
    reset();
  };
  const onHud = ev => {
    const btn = ev.target.closest('[data-zoom]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = surface.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (btn.dataset.zoom === '+') zoomAt(1.25, cx, cy);
    else if (btn.dataset.zoom === '-') zoomAt(1 / 1.25, cx, cy);
    else reset();
  };

  surface.addEventListener('wheel', onWheel, { passive: false });
  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onUp);
  surface.addEventListener('dblclick', onDbl, true);
  hud.addEventListener('click', onHud);

  const api = {
    setEnabled,
    reset,
    toggle: () => setEnabled(!st.enabled),
    get enabled() { return st.enabled; },
    destroy() {
      setEnabled(false);
      surface.removeEventListener('wheel', onWheel);
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onUp);
      surface.removeEventListener('dblclick', onDbl, true);
      hud.removeEventListener('click', onHud);
      hud.remove();
      delete surface._zoom;
    },
  };
  surface._zoom = api;
  apply();
  return api;
}

function createCard(name, delay = 0) {
  const { meta, model, ip } = streamInfo(name);
  const title = displayCameraName(name);
  const roomName = roomLabel(name);
  const qualityLabel = state.meta[name]?.quality === 'sd' ? '流畅' : '高清';
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.name = name;

  card.innerHTML = `
    <div class="card-head">
      <div class="card-title">
        <b>${escapeHTML(roomName)}</b>
        <span>${escapeHTML(shortModel(model) || '米家摄像头')}</span>
      </div>
      <span class="signal" data-role="signal" data-level="0" data-tip="链路质量 · 等待数据"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="badge" data-role="badge">连接中</span>
    </div>
    <div class="card-media">
      <div class="card-still" data-role="still" aria-hidden="true"></div>
      <div class="card-mask" data-role="mask">
        <div><div class="spinner"></div>正在建立局域网连接…</div>
      </div>
      <div class="card-hero-info">
        <b data-role="heroName" title="${escapeHTML(title)}">${escapeHTML(title)}</b>
        <span class="hero-model" data-role="heroModel">${escapeHTML(shortModel(model) || '')}</span>
        <span class="sep">·</span>
        <span class="mono ip" data-role="heroIp">IP ${escapeHTML(ip || '—')}</span>
        <span class="sep">/</span>
        <span class="link" data-role="heroLink"></span>
        <span class="signal" data-role="heroSignal" data-level="0" data-tip="链路质量 · 等待数据"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
      <div class="card-tools">
        <button class="tool ${state.muted ? '' : 'on'}" data-act="mute" title="静音">${icon(state.muted ? 'i-muted' : 'i-volume')}</button>
        <button class="tool" data-act="shot" title="截图">${icon('i-shot')}</button>
        <button class="tool" data-act="hold" title="暂停加载">${icon('i-pause')}</button>
        <button class="tool quality-tool" data-act="quality" title="切换画质"><span data-quality-label>${qualityLabel}</span></button>
        <button class="tool" data-act="zoom" title="缩放/平移">${icon('i-zoom')}</button>
        <button class="tool ptz-tool" data-act="ptz" title="云台控制" aria-label="云台控制" hidden>${icon('i-ptz')}</button>
        <button class="tool" data-act="open" title="全屏">${icon('i-expand')}</button>
        <button class="tool del" data-act="del" title="删除">${icon('i-trash')}</button>
      </div>
      <button class="hero-expand" data-act="open" title="全屏查看" aria-label="全屏查看">${icon('i-expand')}</button>
      <button class="card-menu-btn" data-act="menu" title="更多操作" aria-label="更多操作">${icon('i-more')}</button>
    </div>
    <div class="card-foot">
      <span class="model">${escapeHTML(shortModel(model) || '')}</span>
      <span class="spacer"></span>
      <span class="link" data-role="link"></span>
      <span class="ip">${escapeHTML(ip || '')}</span>
    </div>
  `;

  const media = $('.card-media', card);
  createZoom(media, {
    onChange: on => $('[data-act="zoom"]', card)?.classList.toggle('on', on),
  });
  const mask = $('[data-role="mask"]', card);
  const still = $('[data-role="still"]', card);
  const badge = $('[data-role="badge"]', card);
  const signal = $('[data-role="signal"]', card);
  const heroSignal = $('[data-role="heroSignal"]', card);
  const link = $('[data-role="link"]', card);
  const heroLink = $('[data-role="heroLink"]', card);

  let player = null;
  let timer = 0;
  let mountTimer = 0;
  let errorTimer = 0;
  let retryTimer = 0;
  let retryCount = 0;
  let suspended = false;    // 用户手动暂停，不自动重连
  let bgPaused = false;     // 后台休眠，回到前台自动恢复
  let startedAt = 0;
  let lastLiveAt = 0;
  let lastStillAt = 0;      // 上次抓帧时间，用来定期刷新占位图
  let slowHinted = false;   // 12 秒没出画时已经换过提示文案
  let phase = 'idle';
  let lastError = '';

  const BADGE = {
    live: ['live', 'LIVE'],
    err: ['err', '错误'],
    timeout: ['warn', '超时'],
    paused: ['warn', '暂停'],
    dormant: ['warn', '休眠'],
  };

  function setBadge(kind) {
    phase = kind;
    const [cls, text] = BADGE[kind] || ['', '连接中'];
    badge.className = 'badge ' + cls;
    badge.textContent = kind === 'live' ? '' : text;
    badge.hidden = kind === 'live';
  }

  function setSignal(level, text) {
    for (const el of [signal, heroSignal]) {
      if (!el) continue;
      el.dataset.level = String(level);
      el.dataset.tip = text;
    }
  }

  function spinnerMask() {
    mask.innerHTML = '<div><div class="spinner"></div><span data-role="maskText">正在建立局域网连接…</span></div>';
  }

  // 占位图：切回来/重连时先看到上一帧，而不是一块黑
  function showCardStill() {
    const url = stillOf(name);
    if (!url) {
      still.classList.remove('on');
      return;
    }
    if (still.dataset.url !== url) {
      still.dataset.url = url;
      still.style.backgroundImage = `url("${url}")`;
    }
    still.classList.add('on');
  }

  function hideCardStill() {
    still.classList.remove('on');
  }

  function errorMask(title, detail, withLogin = false) {
    mask.innerHTML = `<div><div class="mask-title">${escapeHTML(title)}</div>${
      detail ? `<div class="mask-sub">${escapeHTML(detail)}</div>` : ''
    }<div class="mask-actions"><button class="mask-btn" data-act="retry">重试</button>${
      withLogin ? '<button class="mask-btn" data-act="login">重新登录</button>' : ''
    }</div></div>`;
  }

  function pausedMask() {
    mask.innerHTML = '<div><div class="mask-title">已暂停</div><div class="mask-sub">不会自动重连，点下方按钮继续</div><button class="mask-btn" data-act="resume">继续加载</button></div>';
  }

  function updateHoldButton() {
    const btn = $('[data-act="hold"]', card);
    if (!btn) return;
    btn.innerHTML = icon(suspended ? 'i-play' : 'i-pause');
    btn.title = suspended ? '继续加载' : '暂停加载';
    btn.classList.toggle('on', suspended);
  }

  // 持续重连：5s → 10s → 20s → 30s 封顶；401/令牌失效时退到 5 分钟，避免把小米风控拖长
  function scheduleRetry(title = '连接失败') {
    if (suspended || retryTimer || state.pageHidden) return;
    retryCount += 1;
    const authFail = /401|unauthorized|令牌|登录/i.test(String(lastError || ''));
    const delay = authFail ? 300000 : Math.min(30000, 5000 * 2 ** (retryCount - 1));
    if (authFail && Date.now() - authToastAt > 600000) {
      authToastAt = Date.now();
      toast('登录已失效，请点右上角账号重新扫码', true);
    }
    errorMask(authFail ? '登录已失效' : title, authFail
      ? '请重新扫码登录 · 5 分钟后自动重试'
      : `${lastError || '连接中断'} · ${Math.round(delay / 1000)}s 后进行第 ${retryCount} 次重连`, authFail);
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (suspended) return;
      reload();
    }, delay);
  }

  function mount() {
    if (state.pageHidden) {
      backgroundPause();
      return;
    }
    if (player || suspended || bgPaused) return;
    clearTimeout(errorTimer);
    errorTimer = 0;
    startedAt = Date.now();
    lastLiveAt = 0;
    lastError = '';
    slowHinted = false;
    setBadge('connecting');
    mask.classList.remove('hide');
    spinnerMask();
    showCardStill();
    setSignal(0, '正在连接…');

    player = makePlayer(name, {
      // 卡片里的视频按「填充方式」铺：铺满=裁切填满，完整=整幅显示留黑边
      contain: state.settings.fit === 'contain',
      muted: state.muted,
      followGlobalMute: true,
      holdWhileViewer: true,
      onReady: () => {
        if (suspended || !player) return;
        lastLiveAt = Date.now();
        retryCount = 0;
        clearTimeout(retryTimer);
        retryTimer = 0;
        clearTimeout(errorTimer);
        errorTimer = 0;
        setBadge('live');
        mask.classList.add('hide');
        rememberStill(name, player.video);
        lastStillAt = Date.now();
        hideCardStill();
        if (state.viewer) {
          try { player?.video?.pause(); } catch {}
        }
      },
      onError: code => {
        if (suspended || !player) return;
        const hints = {
          2: '网络中断，正在自动重连',
          3: '视频解码失败，可在全屏里试试「流畅」画质',
          4: '视频源不可用，正在自动重连',
        };
        lastError = hints[code] || '播放中断，正在自动重连';
        setBadge('err');
        mask.classList.remove('hide');
        scheduleRetry();
      },
      onStatus: text => {
        if (suspended || !player) return;
        if (text) lastError = text;
        setBadge('err');
        mask.classList.remove('hide');
        scheduleRetry();
      },
      onMode: text => {
        if (suspended || !player) return;
        const mode = String(text || '').toUpperCase();
        const value = mode === 'LOADING' ? '' : mode;
        link.textContent = value;
        if (heroLink) heroLink.textContent = value;
      },
    });
    media.insertBefore(player.el, media.querySelector('.card-tools'));

    clearInterval(timer);
    timer = setInterval(() => {
      if (!player || suspended || state.pageHidden) return;
      const v = player.video;
      const waited = Date.now() - (lastLiveAt || startedAt);
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        lastLiveAt = Date.now();
        setBadge('live');
        mask.classList.add('hide');
        hideCardStill();
        if (Date.now() - lastStillAt > 30000) {
          lastStillAt = Date.now();
          rememberStill(name, v);
        }
      } else if (phase !== 'timeout' && waited > 30000) {
        setBadge('timeout');
        mask.classList.remove('hide');
        lastError = lastError || '摄像头可能休眠或离线';
        scheduleRetry('连接超时');
      } else if (waited > 12000 && !slowHinted) {
        // 12 秒还没出画：先给个「还在等」的具体说法，别让用户以为卡死
        slowHinted = true;
        const tip = mask.querySelector('[data-role="maskText"]');
        if (tip) tip.textContent = '连接较慢，正在重试…';
      }
    }, 1000);
  }

  function unmount() {
    media._zoom?.setEnabled(false);
    clearInterval(timer);
    clearTimeout(mountTimer);
    clearTimeout(errorTimer);
    clearTimeout(retryTimer);
    timer = 0;
    mountTimer = 0;
    errorTimer = 0;
    retryTimer = 0;
    link.textContent = '';
    if (player) {
      const p = player;
      player = null;
      p.destroy();
    }
  }

  function reload() {
    unmount();
    mask.classList.remove('hide');
    if (suspended) {
      setBadge('paused');
      pausedMask();
    } else {
      mount();
    }
  }

  function suspend(quiet = false) {
    if (suspended) return;
    suspended = true;
    state.paused.add(name);
    savePaused();
    unmount();
    setBadge('paused');
    mask.classList.remove('hide');
    pausedMask();
    updateHoldButton();
    setSignal(0, '已暂停');
    if (!quiet) toast('已暂停，不会自动重连');
  }

  function resumeStream() {
    if (!suspended) return;
    suspended = false;
    retryCount = 0;
    state.paused.delete(name);
    savePaused();
    updateHoldButton();
    setSignal(0, '正在连接…');
    mount();
  }

  function backgroundPause() {
    if (suspended || bgPaused) return;
    bgPaused = true;
    unmount();
    setBadge('dormant');
    mask.classList.remove('hide');
    mask.innerHTML = '<div><div class="mask-title">后台休眠</div><div class="mask-sub">回到前台后自动恢复</div></div>';
    setSignal(0, '后台休眠');
  }

  function backgroundResume() {
    if (!bgPaused) return;
    bgPaused = false;
    if (suspended) return;
    mount();
  }

  function holdForViewer() {
    const v = player?.video;
    if (!v) return;
    try { v.pause(); } catch {}
  }

  function releaseForViewer() {
    const v = player?.video;
    if (!v) return;
    v.play().catch(() => {});
  }

  // 页面被最小化/切到后台时播放器会主动断开，回来时重新计一个完整的超时窗口
  function onVisible() {
    if (!player || suspended) return;
    startedAt = Date.now();
    const v = player.video;
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      lastLiveAt = Date.now();
      return;
    }
    lastLiveAt = 0;
    setBadge('connecting');
    mask.classList.remove('hide');
    spinnerMask();
  }

  card.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'menu') {
      const open = card.classList.contains('menu-open');
      $$('.card.menu-open').forEach(el => el.classList.remove('menu-open'));
      card.classList.toggle('menu-open', !open);
      return;
    }
    card.classList.remove('menu-open');
    if (act === 'mute') {
      const v = player?.video;
      if (!v) return;
      v.muted = !v.muted;
      btn.classList.toggle('on', !v.muted);
      btn.innerHTML = icon(v.muted ? 'i-muted' : 'i-volume');
      if (!v.muted) v.play().catch(() => {});
    } else if (act === 'shot') {
      snapshot(player?.video, (state.meta[name] || {}).name || title);
    } else if (act === 'hold') {
      if (suspended) resumeStream();
      else suspend();
    } else if (act === 'quality') {
      cycleQuality(name);
    } else if (act === 'zoom') {
      media._zoom?.toggle();
    } else if (act === 'ptz') {
      ptzToggle();
    } else if (act === 'resume') {
      resumeStream();
    } else if (act === 'open') {
      openViewer(name);
    } else if (act === 'retry') {
      retryCount = 0;
      clearTimeout(retryTimer);
      retryTimer = 0;
      reload();
    } else if (act === 'login') {
      openRelogin();
    } else if (act === 'del') {
      deleteCamera(name, title);
    }
  });

  // 单击不再进全屏，避免点空白处误开；双击或右上角 ⛶ 才进入
  card.addEventListener('dblclick', ev => {
    if (document.body.classList.contains('wall')) return;
    if (ev.target.closest('[data-act]') || ev.target.closest('.card-mask')) return;
    openViewer(name);
  });

  // 触屏上双击既难触发、又和缩放手势打架，回到单击进单画面；
  // 桌面端维持原样（单击容易误开全屏）。
  card.addEventListener('click', ev => {
    if (!pointerCoarse()) return;
    if (document.body.classList.contains('wall')) return;
    if (ev.target.closest('[data-act], .card-tools, .card-menu-btn, .zoom-hud, .card-mask')) return;
    viewerOpenedAt = performance.now();
    openViewer(name);
  });

  const controller = {
    el: card,
    name,
    mount,
    unmount,
    reload,
    suspend,
    resumeStream,
    backgroundPause,
    backgroundResume,
    holdForViewer,
    releaseForViewer,
    onVisible,
    setSignal,
    isSuspended: () => suspended,
    isLive: () => phase === 'live',
    get player() { return player; },
    destroy() {
      clearInterval(timer);
      clearTimeout(mountTimer);
      clearTimeout(errorTimer);
      clearTimeout(retryTimer);
      signalSamples.delete(name);
      if (player) player.destroy();
      card.remove();
    },
  };

  state.cards.set(name, controller);

  const grid = $('#grid');
  grid.appendChild(card);

  // 多路同时拨号容易触发摄像头/路由器的 P2P 抖动，新卡片错峰连接
  if (state.paused.has(name)) {
    suspend(true);
  } else if (state.pageHidden) {
    backgroundPause();
  } else if (delay > 0) {
    mountTimer = setTimeout(mount, delay);
  } else {
    mount();
  }
  return controller;
}

async function deleteCamera(name, title = name) {
  if (!confirm(`确定删除「${title}」吗？只删除本机配置，不影响米家 App 里的设备。`)) return;

  try {
    await api(`/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' });
    delete state.meta[name];
    saveMeta();
    state.paused.delete(name);
    savePaused();
    if (state.viewer?.name === name) closeViewer();
    restorePtzPad();
    state.cards.get(name)?.destroy();
    state.cards.delete(name);
    await refreshStreams();
    toast('已删除');
  } catch (e) {
    toast('删除失败：' + e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* player                                                              */
/* ------------------------------------------------------------------ */

function makePlayer(name, opts = {}) {
  const el = document.createElement('video-stream');
  el.mode = 'webrtc,mse,mjpeg';
  el.media = opts.microphone ? 'video,audio,microphone' : 'video,audio';
  // 最小化/切到后台时是否保持连接（设置里可关，省流量/CPU）
  el.visibilityCheck = state.settings.keepAlive === false;
  el.visibilityThreshold = 0.02;
  el.background = false;
  el.pcConfig = {
    bundlePolicy: 'max-bundle',
    iceServers: [],
    sdpSemantics: 'unified-plan',
  };
  el.style.width = '100%';
  el.style.height = '100%';

  let destroyed = false;
  const alive = () => !destroyed;

  el.addEventListener('playstatus', ev => { if (alive()) opts.onStatus?.(ev.detail); });
  el.addEventListener('playmode', ev => { if (alive()) opts.onMode?.(ev.detail); });

  const api_ = {
    el,
    get video() { return el.video; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { el.dispose?.(); } catch {}
      if (el.parentNode) el.remove();
    },
  };

  const configure = () => {
    if (destroyed) return false;
    const v = el.video;
    if (!v) return false;
    v.controls = false;
    v.muted = opts.followGlobalMute ? state.muted : opts.muted !== false;
    v.playsInline = true;
    v.autoplay = true;
    v.style.objectFit = opts.contain ? 'contain' : 'cover';
    v.style.background = '#05080b';
    if (opts.holdWhileViewer && state.viewer) {
      try { v.pause(); } catch {}
    }

    v.addEventListener('loadeddata', () => { if (alive()) opts.onReady?.(); });
    v.addEventListener('playing', () => { if (alive()) opts.onReady?.(); });
    v.addEventListener('error', () => { if (alive()) opts.onError?.(v.error?.code); });
    v.addEventListener('stalled', () => {});
    return true;
  };

  // video element is created in connectedCallback, so wait for it
  const wait = setInterval(() => {
    if (destroyed) {
      clearInterval(wait);
      return;
    }
    if (configure()) clearInterval(wait);
  }, 30);
  setTimeout(() => clearInterval(wait), 3000);

  queueMicrotask(() => {
    if (destroyed) return;
    el.src = '/api/ws?src=' + encodeURIComponent(name);
  });

  return api_;
}

function snapshot(video, name = 'snapshot') {
  if (!video || !video.videoWidth) {
    toast('画面还没准备好', true);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(blob => {
    if (!blob) return;
    download(blob, `${safeFile(name)}_${stamp()}.jpg`);
    toast('截图已保存');
  }, 'image/jpeg', 0.94);
}

function safeFile(name) {
  return String(name || 'camera').replace(/[\\/:*?"<>|]/g, '_');
}

/* ------------------------------------------------------------------ */
/* viewer                                                              */
/* ------------------------------------------------------------------ */

function visibleCardNames() {
  return $$('#grid .card').map(c => c.dataset.name);
}

function playableCardNames() {
  return cameraList().filter(name => !state.paused.has(name));
}

function renderViewerChips() {
  const box = $('#viewerChips');
  if (!box) return;
  const names = cameraList();
  box.innerHTML = names.map(name => {
    const on = state.viewer?.name === name;
    const status = cardStatus(name);
    return `<button data-viewer-cam="${escapeHTML(name)}" class="${on ? 'on' : ''}"><i class="dot ${status}"></i>${escapeHTML(roomLabel(name))}</button>`;
  }).join('');
}

function stepViewer(dir) {
  if (!state.viewer) return;
  const names = playableCardNames();
  if (names.length < 2) return;
  const i = names.indexOf(state.viewer.name);
  const next = names[(i + dir + names.length) % names.length];
  if (next && next !== state.viewer.name) openViewer(next);
}

function holdCardsForViewer() {
  for (const card of state.cards.values()) card.holdForViewer();
}

function releaseCardsForViewer() {
  if (document.hidden || state.pageHidden) return;
  for (const card of state.cards.values()) card.releaseForViewer();
}

function setViewerState(live) {
  if (!state.viewer) return;
  const meta = state.meta[state.viewer.name] || {};
  const dot = $('#viewerDot');
  const pill = $('#viewerState');
  const sub = $('#viewerSub');
  if (dot) dot.className = 'live-dot ' + (live ? '' : 'warn');
  if (pill) {
    pill.className = 'state-pill ' + (live ? 'live' : 'warn');
    pill.textContent = live ? 'LIVE' : '连接中';
  }
  if (sub) sub.textContent = [meta.ip, live ? 'RTC' : '等待重连'].filter(Boolean).join(' · ');
}

function openViewer(name) {
  if (state.paused.has(name)) {
    toast('该摄像头已暂停，先点卡片上的「▶」继续加载', true);
    return;
  }
  if (state.viewer) closeViewer();

  const meta = state.meta[name] || {};
  const title = displayCameraName(name);
  const live = !!state.cards.get(name)?.isLive?.();

  const stage = $('#viewerStage');
  stage._zoom?.destroy();
  stage.innerHTML = '';
  showViewerStill(name);

  const cardVideo = state.cards.get(name)?.player?.video;
  const initialMuted = cardVideo ? cardVideo.muted : state.muted;

  // 先建 viewer 播放器；失败时不影响卡片和 state.viewer
  let player;
  try {
    player = makePlayer(name, {
      contain: state.settings.fit === 'contain',
      muted: initialMuted,
      microphone: false,
      onReady: () => {
        rememberStill(name, player.video);
        hideViewerStill(name);
        clearViewerWatch();
        setViewerState(true);
      },
      onError: () => setViewerState(false),
      onStatus: () => setViewerState(false),
    });
  } catch (e) {
    toast('打开大屏失败：' + e.message, true);
    return;
  }

  // 卡片播放器保留，只暂停画面；大屏走同一个 go2rtc producer，避免摄像头重复握手
  const viewer = {
    name,
    player,
    recorder: null,
    microphone: false,
    bgSuspended: false,
    muted: initialMuted,
  };
  state.viewer = viewer;
  startViewerWatch(name);
  holdCardsForViewer();
  stage.appendChild(player.el);
  viewer.zoom = createZoom(stage, {
    onChange: on => $('#btnViewerZoom')?.classList.toggle('on', on),
  });

  $('#viewerName').textContent = title;
  $('#viewerModel').textContent = shortModel(meta.model || '');
  $('#viewerDot').className = 'live-dot ' + (live ? '' : 'warn');
  $('#viewerState').className = 'state-pill ' + (live ? 'live' : 'warn');
  $('#viewerState').textContent = live ? 'LIVE' : '连接中';
  $('#viewerSub').textContent = [meta.ip, live ? 'RTC' : '等待重连'].filter(Boolean).join(' · ');
  $('#btnViewerMute').innerHTML = icon(initialMuted ? 'i-muted' : 'i-volume');
  $('#btnViewerMute').classList.toggle('on', !initialMuted);
  renderQualityButton(name);

  renderViewerChips();
  tickClock();
  // 云台：只有 /ptz/spec 报告该型号支持时才会显示方向盘
  ptzProbe(name);

  $('#modalViewer').classList.remove('chrome-off');
  $('#modalViewer').classList.add('open');
  $('#modalViewer').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  // 单画面查看本身就是全屏：进来就隐藏安卓系统栏，
  // 否则状态栏会一直压在画面上方（桌面浏览器保持原样，按 F 才进入元素全屏）。
  if (HAS_SHELL) {
    viewer.nativeFull = true;
    setNativeFullscreen(true);
  }
}

function closeViewer() {
  const viewer = state.viewer;
  if (!viewer) return;

  if (document.fullscreenElement) exitWebFullscreen();
  if (viewer.nativeFull) {
    viewer.nativeFull = false;
    setNativeFullscreen(false);
  }

  if (viewer.recorder && viewer.recorder.state !== 'inactive') {
    try { viewer.recorder.stop(); } catch {}
  }

  if (viewer.player) viewer.player.destroy();
  viewer.zoom?.destroy();
  viewer.zoom = null;
  state.viewer = null;

  $('#viewerStage').innerHTML = '';
  const chips = $('#viewerChips');
  if (chips) chips.innerHTML = '';
  $('#qualityMenu').classList.remove('open');
  $('#modalViewer').classList.remove('open');
  $('#modalViewer').classList.remove('chrome-off');
  $('#modalViewer').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  releaseCardsForViewer();
  setRecUI(false);
  clearViewerWatch();
  ptzReset();
  // 回到 1×1 时把当前卡片的云台能力重新探一遍（开关在卡片工具栏里）
  if (state.settings.layout === '1x1') syncCardPtz(state.settings.single);
}

/* ---------------------------------------------------------------- */
/* 单画面：上一帧占位 + 首帧看门狗                                   */
/* ---------------------------------------------------------------- */

let viewerStillLast = '';   // 上一台看过的画面，目标没有存帧时兜底
let viewerWatch = 0;

function showViewerStill(name) {
  const el = $('#viewerStill');
  if (!el) return;
  const url = stillOf(name) || viewerStillLast;
  if (!url) {
    el.classList.remove('on');
    return;
  }
  if (el.dataset.url !== url) {
    el.dataset.url = url;
    el.style.backgroundImage = `url("${url}")`;
  }
  el.classList.add('on');
}

function hideViewerStill(name) {
  const el = $('#viewerStill');
  const url = stillOf(name);
  if (url) viewerStillLast = url;
  el?.classList.remove('on');
}

function clearViewerWatch() {
  clearTimeout(viewerWatch);
  viewerWatch = 0;
  $('#viewerSlow')?.setAttribute('hidden', '');
}

// 12 秒还不出画就把「连接中」换成可操作的建议；
// 无子码流的机型（比如母婴看护版）常见症状就是黑屏且没有兜底。
function startViewerWatch(name) {
  clearViewerWatch();
  const startedAt = Date.now();
  const tick = () => {
    if (!state.viewer || state.viewer.name !== name) return;
    const v = state.viewer.player?.video;
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      clearViewerWatch();
      return;
    }
    const el = $('#viewerSlow');
    const txt = $('#viewerSlowText');
    if (!el || !txt) return;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const sd = state.meta[name]?.quality === 'sd';
    // 已经是高清时说「换成高清」会自相矛盾，所以两种档位分开措辞
    txt.textContent = secs >= 25
      ? (sd
        ? `已经等了 ${secs} 秒，当前走「流畅」。先试「改用高清」，还不行就回卡片看它是不是休眠或离线。`
        : `已经等了 ${secs} 秒，当前已是「高清」。这台可能休眠或离线，也可能这一路暂时取不到视频。`)
      : (sd
        ? `已经等了 ${secs} 秒，当前走「流畅」。这台如果没有子码流，换成高清往往就能出画面。`
        : `已经等了 ${secs} 秒，当前已是「高清」。无子码流的机型会慢一些，再等等或点重试。`);
    // 已是高清时，那颗按钮点了也没意义，直接收起来只留「重试」
    const hdBtn = el.querySelector('[data-slow="hd"]');
    if (hdBtn) hdBtn.hidden = !sd;
    el.removeAttribute('hidden');
    viewerWatch = setTimeout(tick, 1000);
  };
  viewerWatch = setTimeout(tick, 12000);
}

// 单画面里单击画面：隐藏/显示顶部和底部控件（右上角菜单一起收起）
function toggleViewerChrome(show) {
  const modal = $('#modalViewer');
  if (!modal.classList.contains('open')) return;
  const off = typeof show === 'boolean' ? !show : !modal.classList.contains('chrome-off');
  modal.classList.toggle('chrome-off', off);
  if (off) $('#qualityMenu').classList.remove('open');
}

function recreateViewerPlayer({ microphone } = {}) {
  const viewer = state.viewer;
  if (!viewer || !viewer.player || viewer.bgSuspended) return;
  const v = viewer.player.video;
  const wasMuted = v ? v.muted : state.muted;

  viewer.player.destroy();
  viewer.zoom?.destroy();
  viewer.zoom = null;
  const name = viewer.name;
  const player = makePlayer(name, {
    contain: state.settings.fit === 'contain',
    muted: wasMuted,
    microphone: microphone ?? viewer.microphone,
    onReady: () => {
      rememberStill(name, player.video);
      hideViewerStill(name);
      clearViewerWatch();
      setViewerState(true);
    },
    onError: () => setViewerState(false),
    onStatus: () => setViewerState(false),
  });
  viewer.player = player;
  viewer.microphone = microphone ?? viewer.microphone;
  viewer.muted = wasMuted;
  $('#viewerStage').innerHTML = '';
  $('#viewerStage').appendChild(player.el);
  showViewerStill(name);
  startViewerWatch(name);
  viewer.zoom = createZoom($('#viewerStage'), {
    onChange: on => $('#btnViewerZoom')?.classList.toggle('on', on),
  });
  $('#btnViewerMute').innerHTML = icon(wasMuted ? 'i-muted' : 'i-volume');
  $('#btnViewerMute').classList.toggle('on', !wasMuted);
}

function suspendViewerForBackground() {
  const viewer = state.viewer;
  if (!viewer || !viewer.player) return;
  // 录制中不打断；只保留这一路
  if (viewer.recorder && viewer.recorder.state !== 'inactive') return;
  viewer.muted = viewer.player.video?.muted ?? state.muted;
  viewer.player.destroy();
  viewer.player = null;
  viewer.bgSuspended = true;
  $('#viewerStage').innerHTML = '<div class="viewer-sleep"><b>后台休眠</b><span>回到前台后自动恢复</span></div>';
}

function resumeViewerFromBackground() {
  const viewer = state.viewer;
  if (!viewer || !viewer.bgSuspended) return;
  const muted = viewer.muted ?? state.muted;
  const player = makePlayer(viewer.name, {
    contain: state.settings.fit === 'contain',
    muted,
    microphone: viewer.microphone || false,
  });
  $('#viewerStage').innerHTML = '';
  $('#viewerStage').appendChild(player.el);
  viewer.player = player;
  viewer.bgSuspended = false;
  $('#btnViewerMute').innerHTML = icon(muted ? 'i-muted' : 'i-volume');
  $('#btnViewerMute').classList.toggle('on', !muted);
}

function pauseAllForBackground() {
  if (!document.hidden) return;
  state.pageHidden = true;
  for (const card of state.cards.values()) card.backgroundPause();
  suspendViewerForBackground();
}

function enterWall() {
  if (document.body.classList.contains('wall')) return;
  if (!state.cards.size) {
    toast('没有可显示的摄像头', true);
    return;
  }
  if (state.viewer) closeViewer();
  if ($('#modalSettings').classList.contains('open')) closeSettings();
  if ($('#modalLogin').classList.contains('open')) closeAdd();
  $('#qualityMenu').classList.remove('open');
  document.body.classList.add('wall');
  setNativeFullscreen(true);
  requestWebFullscreen(document.documentElement);
}

function exitWall() {
  if (!document.body.classList.contains('wall')) return;
  document.body.classList.remove('wall');
  setNativeFullscreen(false);
  exitWebFullscreen();
  refreshStreams();
}

function applyMute(muted) {
  state.muted = muted;
  if (state.viewer) state.viewer.muted = muted;

  const allBtn = $('#btnMuteAll');
  if (allBtn) {
    allBtn.innerHTML = icon(muted ? 'i-muted' : 'i-volume');
    allBtn.classList.toggle('on', !muted);
  }

  for (const card of state.cards.values()) {
    const v = card.player?.video;
    // 不要在这里 play：viewer 打开时卡片可能正被 hold，play 会唤醒后台解码
    if (v) v.muted = muted;
    const btn = $('[data-act="mute"]', card.el);
    if (btn) {
      btn.innerHTML = icon(muted ? 'i-muted' : 'i-volume');
      btn.classList.toggle('on', !muted);
    }
  }

  const viewerVideo = state.viewer?.player?.video;
  if (viewerVideo) {
    viewerVideo.muted = muted;
    if (!muted) viewerVideo.play().catch(() => {});
  }
  if (state.viewer) {
    const vbtn = $('#btnViewerMute');
    if (vbtn) {
      vbtn.innerHTML = icon(muted ? 'i-muted' : 'i-volume');
      vbtn.classList.toggle('on', !muted);
    }
  }
}

function toggleViewerMute() {
  const viewer = state.viewer;
  if (!viewer?.player?.video) return;
  applyMute(!viewer.player.video.muted);
}

function toggleViewerFullscreen() {
  const viewer = state.viewer;
  const on = !(document.fullscreenElement || viewer?.nativeFull);
  if (viewer) viewer.nativeFull = on;
  setNativeFullscreen(on);
  if (on) {
    // 壳内只隐藏系统栏；浏览器里再叠一层标准全屏
    requestWebFullscreen($('#modalViewer'));
  } else {
    exitWebFullscreen();
  }
}

function setRecUI(recording) {
  const btn = $('#btnViewerRec');
  if (!btn) return;
  btn.innerHTML = icon('i-record');
  btn.classList.toggle('on', recording);
  btn.title = recording ? '停止录制并保存' : '录制';
}

function toggleRecord() {
  const viewer = state.viewer;
  if (!viewer) return;

  if (viewer.recorder && viewer.recorder.state !== 'inactive') {
    viewer.recorder.stop();
    return;
  }

  const v = viewer.player?.video;
  if (!v || !v.captureStream) {
    toast('当前浏览器不支持录制', true);
    return;
  }

  const stream = v.captureStream();
  const hasAudio = stream.getAudioTracks().length > 0;
  const list = hasAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = list.find(t => MediaRecorder.isTypeSupported(t)) || '';

  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    toast('无法开始录制：' + e.message, true);
    return;
  }

  const name = viewer.name;
  const title = (state.meta[name] || {}).name || name;
  const chunks = [];

  rec.addEventListener('dataavailable', ev => {
    if (ev.data && ev.data.size) chunks.push(ev.data);
  });
  rec.addEventListener('stop', () => {
    if (viewer.recorder === rec) viewer.recorder = null;
    setRecUI(false);
    if (!chunks.length) return;
    download(new Blob(chunks, { type: mime || 'video/webm' }), `${safeFile(title)}_${stamp()}.webm`);
    toast('录像已保存');
  });

  viewer.recorder = rec;
  rec.start(1000);
  setRecUI(true);
  toast('开始录制，再点一次保存');
}

/* ------------------------------------------------------------------ */
/* add / login                                                         */
/* ------------------------------------------------------------------ */

function showStep(name) {
  $$('.step').forEach(el => el.classList.toggle('on', el.dataset.step === name));
}

/* ------------------------------------------------------------------ */
/* QR login (local Node helper)                                        */
/* ------------------------------------------------------------------ */

let qrSid = '';
let qrTimer = 0;
let qrSeq = 0;
let qrFails = 0;

async function qrApi(path) {
  const res = await fetch(QR_ORIGIN + path, { cache: 'no-store' });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res.json();
}

function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function stopQrLogin(cancel = true) {
  qrSeq++;
  if (qrTimer) {
    clearTimeout(qrTimer);
    qrTimer = 0;
  }
  const sid = qrSid;
  qrSid = '';
  qrFails = 0;
  if (cancel && sid) qrApi('/qr/cancel?sid=' + encodeURIComponent(sid)).catch(() => {});
}

function setLoginTab(tab) {
  $$('.login-tab').forEach(el => el.classList.toggle('on', el.dataset.loginTab === tab));
  $$('.login-pane').forEach(el => { el.hidden = el.dataset.loginPane !== tab; });
  if (tab === 'qr') {
    startQrLogin();
  } else {
    stopQrLogin(true);
    setTimeout(() => $('#formLogin').elements['username'].focus(), 50);
  }
}

function openLoginStep() {
  $('#loginStatus').textContent = '';
  showStep('login');
  setLoginTab('qr');
}

async function startQrLogin() {
  stopQrLogin(true);
  if (!$('#modalLogin').classList.contains('open')) return;

  const seq = ++qrSeq;
  const img = $('#qrImg');
  const status = $('#qrStatus');
  const btn = $('#btnQrRefresh');
  img.hidden = true;
  img.removeAttribute('src');
  status.className = 'qr-status';
  status.textContent = '正在获取二维码…';
  btn.disabled = true;

  let data;
  try {
    data = await qrApi('/qr/new');
  } catch {
    if (seq !== qrSeq) return;
    status.className = 'qr-status err';
    status.textContent = '二维码服务未启动：请重新打开桌面版或「启动监控.bat」，也可以切换到账号密码登录。';
    btn.disabled = false;
    return;
  }

  if (seq !== qrSeq) {
    qrApi('/qr/cancel?sid=' + encodeURIComponent(data.sid)).catch(() => {});
    return;
  }

  qrSid = data.sid;
  qrFails = 0;
  img.src = QR_ORIGIN + '/qr/image?sid=' + encodeURIComponent(data.sid);
  img.hidden = false;
  status.textContent = `请用米家 App 扫码（${mmss(data.expiresIn)}）`;
  btn.disabled = false;
  qrTimer = setTimeout(pollQr, 1500);
}

async function pollQr() {
  qrTimer = 0;
  if (!qrSid) return;
  const sid = qrSid;
  const status = $('#qrStatus');
  try {
    const st = await qrApi('/qr/status?sid=' + encodeURIComponent(sid));
    if (sid !== qrSid) return;
    qrFails = 0;
    if (st.state === 'waiting') {
      status.className = 'qr-status';
      status.textContent = `请用米家 App 扫码（${mmss(st.expiresIn)}）`;
      qrTimer = setTimeout(pollQr, 1500);
    } else if (st.state === 'scanned') {
      status.className = 'qr-status ok';
      status.textContent = '已扫码，请在手机上确认…';
      qrTimer = setTimeout(pollQr, 1000);
    } else if (st.state === 'restarting') {
      status.className = 'qr-status ok';
      status.textContent = '登录成功，正在重启引擎…';
      qrTimer = setTimeout(pollQr, 1000);
    } else if (st.state === 'done') {
      await onQrDone(st);
    } else if (st.state === 'expired') {
      status.className = 'qr-status err';
      status.textContent = '二维码已过期，点「刷新二维码」重试';
    } else if (st.state === 'error') {
      status.className = 'qr-status err';
      status.textContent = st.message || '登录失败，请重试';
    } else if (st.state === 'unknown' || st.state === 'canceled') {
      // 已切换/关闭，不再轮询
    } else {
      qrTimer = setTimeout(pollQr, 1500);
    }
  } catch {
    if (++qrFails >= 3) {
      status.className = 'qr-status err';
      status.textContent = '二维码服务连接中断，请确认「启动监控.bat」的助手仍在运行。';
      return;
    }
    qrTimer = setTimeout(pollQr, 2000);
  }
}

async function waitEngine(timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      await api('/api');
      return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function onQrDone(st) {
  stopQrLogin(false);
  const status = $('#qrStatus');
  status.className = 'qr-status ok';
  status.textContent = '登录成功，等待引擎恢复…';

  const region = $('#loginRegion').value || 'cn';
  state.region = region;
  localStorage.setItem('imi.region', region);
  const user = st.user || '';

  const up = await waitEngine(30000);
  if (!up) {
    status.className = 'qr-status err';
    status.textContent = IS_APP
      ? '登录成功，但引擎未恢复：请右键托盘图标选「重启引擎」。'
      : '登录成功，但引擎未恢复：请运行「启动监控.bat」后重试。';
    toast('引擎未恢复', true);
    return;
  }

  await checkEngine();
  await refreshStreams();
  for (const card of state.cards.values()) card.reload();
  if (user) {
    state.user = user;
    localStorage.setItem('imi.user', user);
  }

  try {
    if (!user) await afterLogin();
    else await loadDevices(user, region);
    toast('登录成功');
  } catch (e) {
    $('#devicesStatus').textContent = '读取设备失败：' + e.message;
  }
}

function openAdd() {
  $('#modalLogin').classList.add('open');
  $('#modalLogin').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#loginStatus').textContent = '';
  $('#captchaStatus').textContent = '';
  $('#verifyStatus').textContent = '';
  $('#devicesStatus').textContent = '';
  $('#loginRegion').value = state.region;

  if (state.user) {
    loadDevices(state.user, state.region).catch(() => openLoginStep());
  } else {
    openLoginStep();
  }
}

function openRelogin() {
  $('#modalLogin').classList.add('open');
  $('#modalLogin').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#loginStatus').textContent = '';
  $('#captchaStatus').textContent = '';
  $('#verifyStatus').textContent = '';
  $('#loginRegion').value = state.region;
  openLoginStep();
}

function closeAdd() {
  stopQrLogin(true);
  $('#qrImg').hidden = true;
  $('#qrImg').removeAttribute('src');
  $('#qrStatus').className = 'qr-status';
  $('#modalLogin').classList.remove('open');
  $('#modalLogin').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function postLogin(payload) {
  const res = await fetch('/api/xiaomi', {
    method: 'POST',
    body: new URLSearchParams(payload),
  });

  if (res.status === 401) {
    let data = {};
    try { data = await res.json(); } catch {}
    return { challenge: data };
  }
  if (!res.ok) {
    throw new Error((await res.text()) || `HTTP ${res.status}`);
  }
  return { ok: true };
}

function handleChallenge(data) {
  if (data.captcha) {
    $('#captchaImg').src = 'data:image/jpeg;base64,' + data.captcha;
    showStep('captcha');
    setTimeout(() => $('#formCaptcha').elements['captcha'].focus(), 50);
    return;
  }
  const tip = data.verify_email || data.verify_phone;
  if (tip) {
    $('#verifyTip').textContent = `验证码已发送到 ${tip}，请输入。`;
    showStep('verify');
    setTimeout(() => $('#formVerify').elements['verify'].focus(), 50);
    return;
  }
  throw new Error('登录失败：' + JSON.stringify(data));
}

// 新浏览器/桌面窗口里没有 imi.user，但引擎里可能已有有效 token
async function restoreUser() {
  if (state.user) return;
  try {
    const users = await api('/api/xiaomi');
    if (Array.isArray(users) && users.length) {
      state.user = String(users[0]);
      localStorage.setItem('imi.user', state.user);
      updateSettings();
    }
  } catch {}
}

async function syncDeviceMeta() {
  if (!state.user) return;
  try {
    const data = await api(`/api/xiaomi?id=${encodeURIComponent(state.user)}&region=${encodeURIComponent(state.region)}`);
    mergeDeviceMeta(data.sources || []);
    renderRooms();
  } catch {}
}

async function afterLogin() {
  const users = await api('/api/xiaomi');
  const list = Array.isArray(users) ? users : [];
  const prevUser = localStorage.getItem('imi.user');
  state.user = list.find(id => !(state.usersBefore || []).includes(id)) || list[0] || '';
  if (prevUser && prevUser !== state.user) {
    state.roomData = null;
    localStorage.removeItem('imi.rooms');
  }
  localStorage.setItem('imi.user', state.user);
  roomSyncFailed = false;
  if (!state.user) throw new Error('登录成功，但没有读到账号信息');

  // 读取设备列表
  await loadDevices(state.user, state.region);
}

async function loadDevices(user, region) {
  showStep('devices');
  $('#devicesTip').textContent = `账号 ${user} · ${regionName(region)}，正在读取米家设备…`;
  $('#deviceList').innerHTML = '<div class="muted" style="padding:18px;text-align:center">读取中…</div>';
  $('#devicesStatus').textContent = '';
  $('#btnAddSelected').disabled = true;

  let data;
  try {
    data = await api(`/api/xiaomi?id=${encodeURIComponent(user)}&region=${encodeURIComponent(region)}`);
  } catch (e) {
    if (e.status === 404) {
      $('#devicesTip').textContent = `账号 ${user} · ${regionName(region)}，没有找到摄像头。`;
      $('#deviceList').innerHTML = '';
      $('#devicesStatus').textContent = '该区域下没有可用摄像头，或账号尚未绑定设备。';
      return;
    }
    throw e;
  }

  state.devices = data.sources || [];
  mergeDeviceMeta(state.devices);
  $('#devicesTip').textContent = `账号 ${maskUser(user)} · ${regionName(region)}，共 ${state.devices.length} 个设备。勾选后添加。`;
  renderDevices(state.devices);
}

function applyMetaToCard(name) {
  const meta = state.meta[name] || {};
  const card = state.cards.get(name);
  if (!card) return;
  const el = card.el;
  const titleEl = $('.card-title b', el);
  if (titleEl) titleEl.textContent = roomLabel(name);
  const subEl = $('.card-title span', el);
  if (subEl) subEl.textContent = shortModel(meta.model) || '米家摄像头';
  const modelEl = $('.card-foot .model', el);
  if (modelEl) modelEl.textContent = meta.model || '';
  const ipEl = $('.card-foot .ip', el);
  if (ipEl) ipEl.textContent = meta.ip || '';
  const heroName = $('[data-role="heroName"]', el);
  if (heroName) {
    heroName.textContent = displayCameraName(name);
    heroName.title = displayCameraName(name);
  }
  const heroModel = $('[data-role="heroModel"]', el);
  if (heroModel) heroModel.textContent = shortModel(meta.model) || '';
  const heroIp = $('[data-role="heroIp"]', el);
  if (heroIp) heroIp.textContent = 'IP ' + (meta.ip || '—');
}

// 已存在的流在换浏览器/清缓存后没有昵称，读取设备列表时顺手补回来
function mergeDeviceMeta(sources) {
  let changed = false;
  for (const source of sources) {
    try {
      const u = new URL(source.url);
      const did = u.searchParams.get('did') || '';
      const name = 'cam_' + did;
      if (!did || !state.streams[name]) continue;
      const { ip, mac } = parseInfo(source.info);
      const old = state.meta[name] || {};
      const next = {
        ...old,
        name: old.name || source.name || name,
        model: old.model || u.searchParams.get('model') || '',
        ip: old.ip || ip,
        mac: old.mac || mac,
        did: old.did || did,
        src: old.src || source.url,
        user: old.user || state.user,
        region: old.region || state.region,
        addedAt: old.addedAt || Date.now(),
      };
      if (JSON.stringify(next) !== JSON.stringify(old)) {
        state.meta[name] = next;
        changed = true;
      }
      applyMetaToCard(name);
    } catch {}
  }
  if (changed) saveMeta();
}

function pickRows() {
  return $$('#deviceList .device');
}

function pickBoxOf(row) {
  return row ? $('.device-box', row) : null;
}

function pickVisible() {
  return pickRows().filter(r => !r.classList.contains('pick-hide'));
}

function syncPickRow(row) {
  const box = pickBoxOf(row);
  if (box) row.classList.toggle('on', !!box.checked);
}

// 搜索只改变「看得见哪些」，不改变已勾选集合：先全选再搜出来取消几个，
// 是这页最常见的用法，过滤时把勾选清掉会让人白选一遍。
function applyPickFilter() {
  const input = $('#pickSearch');
  const q = (input ? input.value : '').trim().toLowerCase();
  for (const row of pickRows()) {
    const hit = !q || (row.dataset.search || '').toLowerCase().includes(q);
    row.classList.toggle('pick-hide', !hit);
  }
  const empty = $('#pickEmpty');
  if (empty) empty.hidden = !(pickRows().length > 0 && pickVisible().length === 0);
  updateAddButton();
}

function renderDevices(sources) {
  const box = $('#deviceList');
  box.innerHTML = '';

  const search = $('#pickSearch');
  if (search) search.value = '';
  const toolbar = $('#pickToolbar');
  // 设备少的时候不摆全选/搜索，省两行空间
  if (toolbar) toolbar.hidden = sources.length === 0;
  const searchWrap = $('#pickSearchWrap');
  if (searchWrap) searchWrap.hidden = sources.length < 5;
  const empty = $('#pickEmpty');
  if (empty) empty.hidden = true;

  if (!sources.length) {
    box.innerHTML = '<div class="pick-empty">这个账号下没有摄像头</div>';
    updateAddButton();
    return;
  }

  for (const source of sources) {
    const { ip, mac } = parseInfo(source.info);
    const u = new URL(source.url);
    const did = u.searchParams.get('did') || '';
    const model = u.searchParams.get('model') || '';
    const name = 'cam_' + (did || Math.random().toString(36).slice(2, 8));
    const added = !!state.meta[name] || !!state.streams[name];
    const title = source.name || '未命名摄像头';
    const sub = [ip, model].filter(Boolean).join(' · ');

    const row = document.createElement('label');
    row.className = 'device';
    // 名称 / IP / 型号都能搜到；型号用全名，短名会搜不着
    row.dataset.search = [title, ip, model, name].join(' ');
    row.innerHTML = `
      <input type="checkbox" class="device-box" ${added ? '' : 'checked'} value="${escapeHTML(name)}">
      <span class="device-tick"><svg class="ic"><use href="#i-check"/></svg></span>
      <span class="device-text">
        <b>${escapeHTML(title)}</b>
        <span class="device-sub">${escapeHTML(sub || '地址未知')}</span>
      </span>
      ${added ? '<span class="device-badge">已添加</span>' : ''}
    `;
    row.dataset.source = JSON.stringify({ ...source, did, ip, mac, streamName: name });
    const input = $('.device-box', row);
    input.addEventListener('change', () => {
      syncPickRow(row);
      updateAddButton();
    });
    syncPickRow(row);
    box.appendChild(row);
  }

  updateAddButton();
}

function updateAddButton() {
  const rows = pickRows();
  const boxes = rows.map(pickBoxOf).filter(Boolean);
  const checked = boxes.filter(b => b.checked).length;

  const btn = $('#btnAddSelected');
  if (btn) {
    btn.disabled = checked === 0;
    btn.textContent = checked ? `添加选中摄像头（${checked}）` : '添加选中摄像头';
  }

  const count = $('#pickCount');
  if (count) count.textContent = `已选 ${checked} / ${rows.length}`;

  // 全选只作用于当前可见（搜索过滤后）的行，文字跟着状态变，省一次点击
  const allBtn = $('#btnPickAll');
  if (allBtn) {
    const vis = pickVisible().map(pickBoxOf).filter(Boolean);
    const allOn = vis.length > 0 && vis.every(b => b.checked);
    allBtn.textContent = allOn ? '全不选' : '全选';
    allBtn.disabled = vis.length === 0;
  }

  const noneBtn = $('#btnPickNone');
  if (noneBtn) noneBtn.disabled = checked === 0;
}

async function addSelected() {
  const rows = $$('#deviceList input:checked').map(i => i.closest('.device'));
  if (!rows.length) return;

  const btn = $('#btnAddSelected');
  btn.disabled = true;
  $('#devicesStatus').textContent = '正在写入配置…';

  try {
    for (const row of rows) {
      const source = JSON.parse(row.dataset.source);
      const name = source.streamName;
      const u = new URL(source.url);
      const did = source.did || u.searchParams.get('did') || '';
      const model = u.searchParams.get('model') || '';
      // 安卓：导入时就把流地址落到子码流，避免一上来解 H.265 主码流
      const src = PREFER_SD ? withSubtype(source.url, 'sd', model) : source.url;

      await api(`/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, {
        method: 'PUT',
      });

      // 如果已存在旧 card，先移除，稍后按新配置重建
      restorePtzPad();
      state.cards.get(name)?.destroy();
      state.cards.delete(name);

      state.meta[name] = {
        name: source.name || name,
        model,
        ip: source.ip,
        mac: source.mac,
        did,
        src,
        user: state.user,
        region: state.region,
        addedAt: Date.now(),
        ...(PREFER_SD ? { quality: 'sd' } : {}),
      };
    }

    saveMeta();
    localStorage.setItem('imi.user', state.user);
    localStorage.setItem('imi.region', state.region);

    $('#devicesStatus').textContent = '已添加，正在连接…';
    $('#devicesStatus').classList.add('ok');

    await refreshStreams();
    closeAdd();
    toast('已添加摄像头');
  } catch (e) {
    $('#devicesStatus').textContent = '添加失败：' + e.message;
    $('#devicesStatus').classList.remove('ok');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* quality                                                             */
/* ------------------------------------------------------------------ */

function updateCardQuality(name) {
  const card = state.cards.get(name);
  if (!card) return;
  const label = state.meta[name]?.quality === 'sd' ? '流畅' : '高清';
  $$('[data-quality-label]', card.el).forEach(el => { el.textContent = label; });
}

// 单画面右上角那颗按钮直接显示当前画质（高清/流畅），点一下切到另一档。
// 原来是一个写着「画质」的弹层入口：弱网时看不出自己在哪一档，还要多点一次。
function renderQualityButton(name = state.viewer?.name) {
  const btn = $('#btnViewerQuality');
  if (!btn) return;
  const sd = !!name && state.meta[name]?.quality === 'sd';
  btn.textContent = sd ? '流畅' : '高清';
  btn.classList.toggle('on', sd);
  btn.title = sd ? '当前「流畅」，点击切到高清' : '当前「高清」，点击切到流畅';
}

async function applyQuality(name, q, silent = false) {
  const info = streamInfo(name);
  const meta = state.meta[name] || (state.meta[name] = {
    name: info.meta.name || name,
    model: info.model,
    ip: info.ip,
  });
  const src0 = meta.src || streamUrl(name);
  if (!src0) {
    toast('找不到原始流地址，无法切换画质', true);
    return false;
  }

  // 不同型号的「高清/流畅」对应不同的 subtype 编号，写死接口值会拿到错误分辨率。
  const map = qualityMap(meta.model || info.model);
  const subtype = map[q] ?? map.hd;

  try {
    const u = new URL(src0);
    u.searchParams.set('subtype', String(subtype));
    const src = u.toString();

    await api(`/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, {
      method: 'PUT',
    });

    meta.src = src;
    meta.quality = q;
    if (!meta.model) meta.model = info.model;
    saveMeta();

    const viewer = state.viewer?.name === name ? state.viewer : null;
    if (viewer?.recorder && viewer.recorder.state !== 'inactive') {
      try { viewer.recorder.stop(); } catch {}
    }

    state.cards.get(name)?.reload();
    if (viewer) recreateViewerPlayer();
    updateCardQuality(name);
    renderQualityButton(name);
    if (!silent) toast(q === 'sd' ? '已切换到流畅画质，正在重连' : '已切换到高清画质，正在重连');
    return true;
  } catch (e) {
    if (!silent) toast('切换失败：' + e.message, true);
    return false;
  }
}

// 把流地址里的 subtype 换成指定画质对应的编号（各型号映射不同）
function withSubtype(src, q, model) {
  const map = qualityMap(model);
  const subtype = map[q] ?? map.hd;
  try {
    const u = new URL(src);
    u.searchParams.set('subtype', String(subtype));
    return u.toString();
  } catch {
    return src;
  }
}

function cycleQuality(name) {
  const q = state.meta[name]?.quality === 'sd' ? 'hd' : 'sd';
  applyQuality(name, q);
}

async function changeQuality(q) {
  const viewer = state.viewer;
  if (!viewer) return;
  const ok = await applyQuality(viewer.name, q);
  if (ok) $('#qualityMenu').classList.remove('open');
}

const QUALITY_BY_MODEL = {
  'chuangmi.camera.039c01': { hd: 3, sd: 1 },
  'chuangmi.camera.029a02': { hd: 2, sd: 0 },
  'chuangmi.camera.061a01': { hd: 3, sd: 1 },
  _default: { hd: 2, sd: 1 },
};

// 型号来自云端 URL 参数，直接下标会命中原型链（constructor/__proto__）
function qualityMap(model) {
  return Object.prototype.hasOwnProperty.call(QUALITY_BY_MODEL, model)
    ? QUALITY_BY_MODEL[model]
    : QUALITY_BY_MODEL._default;
}

// 安卓首次运行（含从桌面版拷来的旧配置）：把没记录画质的摄像头切到子码流
async function ensureSdDefault() {
  for (const name of Array.from(state.cards.keys())) {
    if (!state.meta[name]?.quality) await applyQuality(name, 'sd', true);
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings() {
  updateSettings();
  updateLayoutUI();
  applyTheme(themeMode(), false);
  $('#setLayout').value = LAYOUTS[state.settings.layout] ? state.settings.layout : '2x2';
  $('#setHideBattery').checked = state.settings.hideBattery !== false;
  $('#setKeepAlive').checked = state.settings.keepAlive !== false;
  $('#setBgSleep').checked = state.settings.bgSleep !== false;
  applySettingsTab(state.settings.setTab);
  syncPtzSettingsUI();
  $('#modalSettings').classList.add('open');
  $('#modalSettings').setAttribute('aria-hidden', 'false');
  // 打开设置就重算一次外观判定，顺带把读数刷新出来
  resyncAutoTheme();
  document.body.style.overflow = 'hidden';
}

function closeSettings() {
  $('#modalSettings').classList.remove('open');
  $('#modalSettings').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function clearCameras() {
  if (!confirm('确定清空所有摄像头吗？只删除本机配置，不会影响米家 App 里的设备。')) return;

  try {
    for (const name of Object.keys(state.streams)) {
      await api(`/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' });
    }
    state.meta = {};
    saveMeta();
    state.paused.clear();
    savePaused();
    restorePtzPad();
    for (const [, card] of state.cards) card.destroy();
    state.cards.clear();
    await refreshStreams();
    closeSettings();
    toast('已清空');
  } catch (e) {
    toast('清空失败：' + e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#btnAdd').addEventListener('click', openAdd);
  $('#btnAddEmpty').addEventListener('click', openAdd);
  $('#btnWall').addEventListener('click', enterWall);
  $('#btnWallExit').addEventListener('click', exitWall);
  $('#btnRefresh').addEventListener('click', async () => {
    await checkEngine();
    await refreshStreams();
    for (const card of state.cards.values()) card.reload();
    syncRooms(true);
    toast('画面已刷新，正在从米家同步最新名称/房间…');
  });

  $('#btnMuteAll').addEventListener('click', () => {
    applyMute(!state.muted);
  });

  $('#btnSettings').addEventListener('click', openSettings);
  $('#accountBtn').addEventListener('click', openSettings);
  $('#btnTheme').addEventListener('click', cycleTheme);

  $('#btnLayout').addEventListener('click', () => {
    const menu = $('#layoutMenu');
    const on = !menu.classList.contains('on');
    menu.classList.toggle('on', on);
    $('#btnLayout').setAttribute('aria-expanded', String(on));
  });
  $('#layoutMenu').addEventListener('click', ev => {
    const btn = ev.target.closest('[data-layout]');
    if (btn) selectLayout(btn.dataset.layout);
  });
  $$('#layoutTiles [data-layout-grid]').forEach(btn => {
    btn.addEventListener('click', () => selectLayout(btn.dataset.layoutGrid));
  });
  $$('#themeSeg [data-theme]').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
  $$('#boxSeg [data-box]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.box = btn.dataset.box;
      // 自适应不需要黑边，切过去时把填充一起归位，省得用户再点一次
      if (state.settings.box !== 'auto') state.settings.fit = 'cover';
      saveSettings();
      updateLayoutUI();
      applyFitLive();
      refreshStreams();
    });
  });
  $$('#fitSeg [data-fit]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.fit = btn.dataset.fit;
      saveSettings();
      updateLayoutUI();
      applyFitLive();
      refreshStreams();
    });
  });
  $$('#setTabs [data-set-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      applySettingsTab(btn.dataset.setTab);
      saveSettings();
    });
  });
  $$('#ptzFlipSeg [data-flip]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.ptzFlip = btn.dataset.flip;
      saveSettings();
      syncPtzSettingsUI();
      haptic(8);
    });
  });
  $$('#ptzStepSeg [data-step]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.ptzStep = Number(btn.dataset.step) || 1;
      saveSettings();
      syncPtzSettingsUI();
      haptic(8);
    });
  });
  [['#setVersion', '引擎版本'], ['#setUser', '账号'], ['#setRegion', '区域']].forEach(([sel, label]) => {
    $(sel)?.addEventListener('click', () => copyText($(sel).textContent, label));
  });

  $('#roomList').addEventListener('click', ev => {
    const all = ev.target.closest('[data-all]');
    if (all) { selectAllRooms(); return; }
    const room = ev.target.closest('[data-room]');
    if (room) selectRoom(room.dataset.room);
  });
  $('#grid').addEventListener('click', ev => {
    if (ev.target.closest('.grid-slot')) openAdd();
  });

  $('#viewerChips').addEventListener('click', ev => {
    const btn = ev.target.closest('[data-viewer-cam]');
    if (btn) openViewer(btn.dataset.viewerCam);
  });

  $$('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.close;
      if (id === 'modalSettings') closeSettings();
      else closeAdd();
    });
  });

  $$('.modal').forEach(modal => {
    modal.addEventListener('click', ev => {
      if (ev.target !== modal) return;
      if (modal.id === 'modalViewer') closeViewer();
      else if (modal.id === 'modalSettings') closeSettings();
      else closeAdd();
    });
  });

  $$('.login-tab').forEach(btn => {
    btn.addEventListener('click', () => setLoginTab(btn.dataset.loginTab));
  });
  $('#btnQrRefresh').addEventListener('click', () => startQrLogin());

  $('#formLogin').addEventListener('submit', async ev => {
    ev.preventDefault();
    stopQrLogin(true);
    const status = $('#loginStatus');
    const btn = ev.target.querySelector('button[type="submit"]');
    status.textContent = '';
    status.classList.remove('ok');
    btn.disabled = true;

    state.region = $('#loginRegion').value || 'cn';
    localStorage.setItem('imi.region', state.region);
    state.usersBefore = await api('/api/xiaomi').catch(() => []);

    try {
      const result = await postLogin({
        username: ev.target.elements['username'].value.trim(),
        password: ev.target.elements['password'].value,
      });
      if (result.challenge) {
        status.textContent = '需要额外验证';
        handleChallenge(result.challenge);
      } else {
        status.textContent = '登录成功';
        status.classList.add('ok');
        await afterLogin();
      }
    } catch (e) {
      status.textContent = '登录失败：' + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#formCaptcha').addEventListener('submit', async ev => {
    ev.preventDefault();
    const status = $('#captchaStatus');
    status.textContent = '';
    try {
      const result = await postLogin({ captcha: ev.target.elements['captcha'].value.trim() });
      if (result.challenge) {
        handleChallenge(result.challenge);
      } else {
        await afterLogin();
      }
    } catch (e) {
      status.textContent = '验证失败：' + e.message;
    }
  });

  $('#formVerify').addEventListener('submit', async ev => {
    ev.preventDefault();
    const status = $('#verifyStatus');
    status.textContent = '';
    try {
      const result = await postLogin({ verify: ev.target.elements['verify'].value.trim() });
      if (result.challenge) {
        handleChallenge(result.challenge);
      } else {
        await afterLogin();
      }
    } catch (e) {
      status.textContent = '验证失败：' + e.message;
    }
  });

  $('#btnAddSelected').addEventListener('click', addSelected);
  $('#btnPickAll').addEventListener('click', () => {
    const vis = pickVisible().map(pickBoxOf).filter(Boolean);
    const allOn = vis.length > 0 && vis.every(b => b.checked);
    vis.forEach(b => { b.checked = !allOn; });
    pickRows().forEach(syncPickRow);
    updateAddButton();
  });
  $('#btnPickNone').addEventListener('click', () => {
    pickRows().forEach(row => {
      const b = pickBoxOf(row);
      if (b) b.checked = false;
    });
    pickRows().forEach(syncPickRow);
    updateAddButton();
  });
  $('#pickSearch').addEventListener('input', applyPickFilter);
  $('#btnRelogin').addEventListener('click', () => {
    state.user = '';
    localStorage.removeItem('imi.user');
    closeSettings();
    openRelogin();
  });

  $('#btnReimport').addEventListener('click', () => {
    closeSettings();
    openAdd();
  });
  $('#btnClear').addEventListener('click', clearCameras);

  $('#setLayout').addEventListener('change', () => {
    selectLayout($('#setLayout').value);
  });
  $('#btnSinglePrev').addEventListener('click', () => stepSingle(-1));
  $('#btnSingleNext').addEventListener('click', () => stepSingle(1));
  bindSwipeSwitch();
  $('#singleSelect').addEventListener('change', () => {
    state.settings.single = $('#singleSelect').value;
    saveSettings();
    refreshStreams();
  });
  $('#setHideBattery').addEventListener('change', () => {
    state.settings.hideBattery = $('#setHideBattery').checked;
    saveSettings();
    refreshStreams();
  });
  $('#setBgSleep').addEventListener('change', () => {
    state.settings.bgSleep = $('#setBgSleep').checked;
    saveSettings();
  });
  $('#setKeepAlive').addEventListener('change', () => {
    state.settings.keepAlive = $('#setKeepAlive').checked;
    saveSettings();
    // visibilityCheck 只在播放器初始化时读取，改完需要重建；错峰避免四路同时拨号
    let i = 0;
    for (const card of state.cards.values()) {
      setTimeout(() => card.reload(), (i++) * 400);
    }
  });

  // viewer
  $('#btnViewerClose').addEventListener('click', closeViewer);
  $('#btnViewerMute').addEventListener('click', toggleViewerMute);
  $('#btnViewerZoom').addEventListener('click', () => state.viewer?.zoom?.toggle());

  $('#btnViewerShot').addEventListener('click', () => {
    const viewer = state.viewer;
    if (!viewer?.player) return;
    snapshot(viewer.player.video, (state.meta[viewer.name] || {}).name || viewer.name);
  });

  $('#btnViewerRec').addEventListener('click', toggleRecord);
  $('#btnViewerPip').addEventListener('click', async () => {
    const v = state.viewer?.player?.video;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) {
      toast('画中画不可用：' + e.message, true);
    }
  });

  // 单画面：单击画面切换控件显示，双击退出（打开放大镜时双击只复位画面）
  const viewerStage = $('#viewerStage');
  const stagePointers = new Map();
  let stageTap = null;
  let stageTapTimer = 0;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const isViewerControl = target => !!target?.closest?.(
    'button, .zoom-hud, [data-act], .viewer-top, .viewer-bottom, .quality-menu'
  );

  viewerStage.addEventListener('pointerdown', ev => {
    if (stageTapTimer) {
      clearTimeout(stageTapTimer);
      stageTapTimer = 0;
    }
    stagePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (stagePointers.size !== 1 || isViewerControl(ev.target)) {
      stageTap = null;
      return;
    }
    stageTap = { x: ev.clientX, y: ev.clientY, at: performance.now() };
  });

  viewerStage.addEventListener('pointermove', ev => {
    if (!stageTap || !stagePointers.has(ev.pointerId)) return;
    if (Math.hypot(ev.clientX - stageTap.x, ev.clientY - stageTap.y) > 10) stageTap = null;
  });

  viewerStage.addEventListener('pointercancel', ev => {
    stagePointers.delete(ev.pointerId);
    stageTap = null;
  });

  viewerStage.addEventListener('pointerup', ev => {
    stagePointers.delete(ev.pointerId);
    if (!stageTap || stagePointers.size) return;
    if (performance.now() - stageTap.at > 700) {
      stageTap = null;
      return;
    }
    stageTap = null;
    if (isViewerControl(ev.target)) return;

    const now = performance.now();
    // 刚用单击打开时，手指第二下会落在这里；不忽略的话画面刚进来就收起工具栏
    if (now - viewerOpenedAt < 400) return;
    const isDouble = now - lastTapAt < 300
      && Math.hypot(ev.clientX - lastTapX, ev.clientY - lastTapY) < 44;
    if (isDouble) {
      lastTapAt = 0;
      clearTimeout(stageTapTimer);
      stageTapTimer = 0;
      const viewer = state.viewer;
      if (!viewer) return;
      if (viewer.zoom?.enabled) {
        viewer.zoom.reset();
      } else {
        viewerDblUntil = performance.now() + 400;
        closeViewer();
      }
      return;
    }

    lastTapAt = now;
    lastTapX = ev.clientX;
    lastTapY = ev.clientY;
    clearTimeout(stageTapTimer);
    // 与双击判定窗口（300ms）保持一致，避免第二下刚好落在 250~300ms 时先收起再退出
    stageTapTimer = setTimeout(() => {
      stageTapTimer = 0;
      toggleViewerChrome();
    }, 300);
  });

  $('#btnViewerQuality').addEventListener('click', ev => {
    ev.stopPropagation();
    const name = state.viewer?.name;
    if (!name) return;
    const cur = state.meta[name]?.quality === 'sd' ? 'sd' : 'hd';
    changeQuality(cur === 'sd' ? 'hd' : 'sd');
  });
  $$('#qualityMenu button').forEach(btn => {
    btn.addEventListener('click', () => changeQuality(btn.dataset.q));
  });
  $('#viewerSlow')?.addEventListener('click', ev => {
    const act = ev.target.closest('[data-slow]')?.dataset.slow;
    const name = state.viewer?.name;
    if (!act || !name) return;
    clearViewerWatch();
    if (act === 'hd') {
      changeQuality('hd');
    } else if (act === 'retry') {
      recreateViewerPlayer();
      showViewerStill(name);
      startViewerWatch(name);
    }
  });

  document.addEventListener('click', ev => {
    if (!ev.target.closest('.layout-wrap')) closeLayoutMenu();
    if (!ev.target.closest('.card-menu-btn') && !ev.target.closest('.card-tools')) {
      $$('.card.menu-open').forEach(el => el.classList.remove('menu-open'));
    }
    if (!ev.target.closest('#qualityMenu') && !ev.target.closest('#btnViewerQuality')) {
      $('#qualityMenu').classList.remove('open');
    }
  });

  // 双击退出单画面时，随后补发的 dblclick 会落到手指下方的卡片上；这里一次性拦掉
  document.addEventListener('dblclick', ev => {
    if (!viewerDblUntil || performance.now() >= viewerDblUntil) return;
    viewerDblUntil = 0;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);

  document.addEventListener('keydown', ev => {
    if (document.body.classList.contains('wall')) {
      if (ev.key === 'Escape') { ev.preventDefault(); exitWall(); return; }
    }
    if (state.viewer) {
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepViewer(-1); return; }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); stepViewer(1); return; }
      if (ev.key === ' ') { ev.preventDefault(); toggleViewerMute(); return; }
      if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); toggleViewerFullscreen(); return; }
      if (/^[1-9]$/.test(ev.key)) {
        const name = cameraList()[Number(ev.key) - 1];
        if (name) { ev.preventDefault(); openViewer(name); return; }
      }
      if (ev.key === 'Escape') {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else closeViewer();
        return;
      }
    }
    const tag = document.activeElement?.tagName;
    const typing = tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
    if (!state.viewer && !typing && /^[1-9]$/.test(ev.key)) {
      const name = cameraList()[Number(ev.key) - 1];
      if (name) { ev.preventDefault(); selectRoom(name); return; }
    }
    if (!state.viewer && !typing && ev.key.toLowerCase() === 'g') {
      ev.preventDefault();
      selectAllRooms();
      return;
    }
    if (!state.viewer && state.settings.layout === '1x1'
      && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      if (typing) return;
      ev.preventDefault();
      stepSingle(ev.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (ev.key === 'Escape') {
      if ($('#layoutMenu').classList.contains('on')) closeLayoutMenu();
      else if ($('#modalSettings').classList.contains('open')) closeSettings();
      else if ($('#modalLogin').classList.contains('open')) closeAdd();
    }
  });

  document.addEventListener('visibilitychange', () => {
    clearTimeout(bgTimer);
    bgTimer = 0;
    resumeToken += 1;

    if (document.hidden) {
      // 立刻停止后台轮询；断流按设置延迟，避免快速 Alt-Tab 触发重连风暴
      state.pageHidden = true;
      stopPolling();

      if (state.settings.keepAlive === false) {
        bgTimer = setTimeout(() => {
          bgTimer = 0;
          pauseAllForBackground();
        }, HIDDEN_GRACE_MS);
        return;
      }
      if (state.settings.bgSleep === false) return;

      bgTimer = setTimeout(() => {
        bgTimer = 0;
        if (state.settings.keepAlive === false || state.settings.bgSleep === false) return;
        pauseAllForBackground();
      }, BACKGROUND_IDLE_MS);
      return;
    }

    state.pageHidden = false;
    startPolling();
    const token = resumeToken;

    if (state.viewer?.bgSuspended) resumeViewerFromBackground();
    if (!state.viewer) releaseCardsForViewer();

    let i = 0;
    for (const card of state.cards.values()) {
      const delay = i * RESUME_STAGGER_MS;
      const resume = () => {
        if (token !== resumeToken || document.hidden || state.pageHidden) return;
        card.backgroundResume();
        card.onVisible();
      };
      if (delay) setTimeout(resume, delay);
      else resume();
      i += 1;
    }
  });

  document.addEventListener('dblclick', () => {
    if (document.body.classList.contains('wall')) exitWall();
  });

  document.addEventListener('fullscreenchange', () => {
    if (state.viewer) state.viewer.nativeFull = !!document.fullscreenElement;
    if (document.fullscreenElement) {
      setNativeFullscreen(true);
      return;
    }
    if (document.body.classList.contains('wall')) exitWall();
    else setNativeFullscreen(false);
  });

  window.addEventListener('beforeunload', () => {
    if (state.viewer?.recorder && state.viewer.recorder.state !== 'inactive') {
      try { state.viewer.recorder.stop(); } catch {}
    }
  });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

function startPolling() {
  stopPolling();
  pollTimers = [
    setInterval(checkEngine, 10000),
    setInterval(refreshStreams, 5000),
    setInterval(pollSignals, 2000),
  ];
}

function stopPolling() {
  for (const id of pollTimers) clearInterval(id);
  pollTimers = [];
}

// 安卓返回键：先退出全屏/大屏/弹窗，返回 false 时由原生处理（返回上一页或退到后台）。
window.__imiBack = () => {
  if (document.body.classList.contains('wall')) { exitWall(); return true; }
  // 单画面查看默认就是全屏，返回键直接关掉它（closeViewer 会恢复系统栏）
  if (state.viewer) { closeViewer(); return true; }
  if ($('#qualityMenu')?.classList.contains('open')) { $('#qualityMenu').classList.remove('open'); return true; }
  if ($('#layoutMenu')?.classList.contains('on')) { closeLayoutMenu(); return true; }
  if ($('#modalSettings')?.classList.contains('open')) { closeSettings(); return true; }
  if ($('#modalLogin')?.classList.contains('open')) { closeAdd(); return true; }
  return false;
};

async function init() {
  bindEvents();
  // 页面重新加载时恢复系统栏（避免壳里残留全屏状态）
  setNativeFullscreen(false);

  // 老版本默认是 2×2 + 16:9；升级到左右分栏后只迁移一次到单路铺满
  const savedSettings = loadJSON('imi.settings', {});
  if (savedSettings.uiVersion !== 2) {
    state.settings.layout = '1x1';
    state.settings.gridLayout = '2x2';
    state.settings.scope = 'room';
    state.settings.display = 'fill';
    state.settings.uiVersion = 2;
    saveSettings();
  }

  // uiVersion 3：把「画面比例」拆成两个独立概念。老语义里 16:9 一直连着「不裁切」、
  // 铺满连着「自适应」，按原样迁移过来，用户升级后看到的画面不变。
  if (savedSettings.uiVersion !== 3) {
    const wasRatio = state.settings.display === 'ratio';
    state.settings.box = wasRatio ? '16:9' : 'auto';
    state.settings.fit = wasRatio ? 'contain' : 'cover';
    state.settings.uiVersion = 3;
    saveSettings();
  }

  if (state.settings.layout === 'all') state.settings.layout = '3x3';
  if (!['1x1', '2x2', '3x2', '3x3'].includes(state.settings.layout)) state.settings.layout = '1x1';
  if (state.settings.layout !== '1x1') state.settings.gridLayout = state.settings.layout;
  if (!['room', 'all'].includes(state.settings.scope)) state.settings.scope = 'room';

  // 仅用于本地截图/预览，不写回设置
  const preview = new URLSearchParams(location.search);
  if (['auto', 'light', 'dark'].includes(preview.get('theme'))) state.settings.theme = preview.get('theme');
  if (['1x1', '2x2', '3x2', '3x3'].includes(preview.get('layout'))) {
    state.settings.layout = preview.get('layout');
    if (state.settings.layout !== '1x1') state.settings.gridLayout = state.settings.layout;
  }
  if (preview.get('scope') === 'all') state.settings.scope = 'all';
  if (preview.get('scope') === 'room') state.settings.scope = 'room';

  applyTheme(themeMode(), false);
  applyMute(state.muted);
  updateLayoutUI();
  renderRooms();
  tickClock();
  setInterval(tickClock, 1000);

  await checkEngine();
  await restoreUser();
  // 房间信息：有缓存时先渲染，再后台静默同步一次米家最新昵称/房间；
  // 没有缓存时先等同步完。助手侧有 10 分钟缓存，不会每次都登录云端，
  // 所以即使是普通刷新页面，米家里改过的名字也会在后台同步过来。
  if (!state.roomData) {
    toast('正在读取房间信息…');
    try { await syncRooms(); } catch {}
  } else {
    syncRooms().catch(() => {});
  }
  await refreshStreams();

  // 安卓首次运行（含从桌面版拷来的旧配置）：把没记录画质的摄像头切到子码流
  if (PREFER_SD && localStorage.getItem('imi.sdDefault') !== '1') {
    try { await ensureSdDefault(); } catch (e) { console.warn('sd default failed', e); }
    localStorage.setItem('imi.sdDefault', '1');
  }

  setTimeout(syncDeviceMeta, 6000);

  startPolling();
  pollSignals();
  window.addEventListener('resize', () => fitGrid(state.cards.size));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode() === 'auto') applyTheme('auto', false);
  });
  // WebView 不派发 change 时的兜底
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resyncAutoTheme(); });
  window.addEventListener('pageshow', resyncAutoTheme);
  window.addEventListener('focus', resyncAutoTheme);
  ptzBind();
}

/* ------------------------------------------------------------------ */
/* 云台（PTZ）                                                          */
/* ------------------------------------------------------------------ */

// /ptz 由网关注册：APK 用 -qr、fnOS / 代理模式传 -config 后都可用。
// 桌面版不启动网关，由打了 xiaomi-control 补丁的 go2rtc 直接提供同名接口；
// 两个实现都按云台能力 fail-closed，不支持时方向盘不会出现。
const ptz = {
  name: '',        // go2rtc 的流名，命令靠它定位到哪台摄像机
  did: '',
  dirs: [],
  model: '',
  channel: '',     // miss = 视频连接里的命令通道；cloud = MIoT 云端
  note: '',
  open: false,     // 方向盘是否已打开；每次进画面都从关闭开始
  surface: '',     // viewer = 全屏查看器；card = 1×1 单窗口；'' = 都没有
  home: null,      // 方向盘在查看器里的原始父节点，挪进卡片后要能移回来
  halt: null,      // ptzBind 注册的「立即停」，卡片工具栏收起时调用
  moving: false,     // 是否还有未停下来的移动（和按钮 .on 类无关）
  movePromise: null, // 最近一条 move 请求；stop 必须排在它后面
  probing: 0,
  pressTimer: 0,
  repeatTimer: 0,
  holdTimer: 0,
  lastErrorAt: 0,
  stopTimer: 0,    // 松手后延迟发停止的句柄（步长余量）
};

// 长按上限：手指滑出屏幕没收到 pointerup 时，靠它保证电机不会一直转。
const PTZ_HOLD_MAX = 15000;
// 按住时的补发间隔。命令本身是「持续朝该方向转」，补发不会加速；
// 万一某个固件把它当步进，700ms 一步也不至于堆积（约 1.4s 是
// 「命令发出 → 画面真的动」的延迟，不是步进间隔）。
const PTZ_REPEAT_MS = 700;

// 步长 = 松手后「再多走一小段」的时长。0x112 的 operation 是「持续朝
// 该方向转」，一步走多远取决于停止命令发得多晚 —— 所以档位调的是延迟，
// 不是连发几条（连发会被松手刹车直接掐掉，档位等于没有）。
const PTZ_STEP_DELAY = { 1: 0, 2: 170, 3: 380 };

// 吊装 / 倒装时画面是正的，方向键却是反的。按语义做镜像即可，
// 网关和摄像机都不用改 —— 它们只认 operation 1..4。
function ptzFlipDir(dir) {
  const flip = state.settings.ptzFlip || 'none';
  if (flip === 'none' || !dir) return dir;
  let h = '';
  let v = '';
  String(dir).split('_').forEach((part) => {
    if (part === 'up' || part === 'down') v = part;
    else if (part === 'left' || part === 'right') h = part;
  });
  if (flip.includes('h')) h = h === 'left' ? 'right' : h === 'right' ? 'left' : h;
  if (flip.includes('v')) v = v === 'up' ? 'down' : v === 'down' ? 'up' : v;
  if (v && h) return h + '_' + v;
  return v || h || dir;
}

function ptzStepMs() {
  const n = Math.round(Number(state.settings.ptzStep) || 1);
  return PTZ_STEP_DELAY[n] ?? 0;
}

// 让电机停下来。切画面、收起方向盘、松手都要走这里。
function ptzSendStop(name) {
  const target = name || ptz.name;
  if (!target || ptz.channel !== 'miss') return Promise.resolve();
  const send = () => {
    const q = new URLSearchParams({ name: target, move: 'stop', region: state.region || 'cn' });
    if (ptz.did) q.set('did', ptz.did);
    if (state.user) q.set('id', state.user);
    return fetch('/ptz?' + q.toString(), { cache: 'no-store', keepalive: true }).catch(() => {});
  };
  // 慢响应时 stop 不能跑到 move 前面，否则网关先停后转，电机还是不停。
  const prev = ptz.movePromise || Promise.resolve();
  ptz.movePromise = null;
  return prev.then(send, send);
}

// 立刻兑现「欠着的停止」并清掉按键定时器。关画面、收方向盘、切摄像头都要走这里。
function ptzStopNow() {
  const pad = $('#ptzPad');
  // 松手时 stop() 已经移除了 .on、并可能把真正的停止命令放在定时器里。
  // 关画面 / 切摄像头时必须把这笔「欠着的停止」立刻兑现，否则电机会一直转。
  if (ptz.stopTimer) {
    clearTimeout(ptz.stopTimer);
    ptz.stopTimer = 0;
    ptzSendStop();
  } else if (ptz.moving) {
    ptzSendStop();
  }
  ptz.moving = false;
  ptz.movePromise = null;
  clearTimeout(ptz.stopTimer);
  ptz.stopTimer = 0;
  clearTimeout(ptz.pressTimer);
  clearInterval(ptz.repeatTimer);
  clearTimeout(ptz.holdTimer);
  ptz.pressTimer = ptz.repeatTimer = ptz.holdTimer = 0;
  if (pad) $$('.ptz-btn.on', pad).forEach(b => b.classList.remove('on'));
}

// 方向盘平时属于查看器；1×1 单窗口时临时挪进卡片，切回去要还原。
function restorePtzPad() {
  const pad = $('#ptzPad');
  if (pad && ptz.home && pad.parentNode !== ptz.home) ptz.home.appendChild(pad);
}

// 方向盘该挂在哪儿：查看器里就放回原位，单窗口卡片里就跟进卡片。
function ptzMountPad(open) {
  if (!open) { restorePtzPad(); return; }
  let host = null;
  if (ptz.surface === 'card') {
    const card = state.cards.get(ptz.name)?.el;
    host = card ? $('.card-media', card) : null;
  }
  if (!host) host = ptz.home;
  const pad = $('#ptzPad');
  if (pad && host && pad.parentNode !== host) host.appendChild(pad);
}

// 卡片上的云台按钮：只有当前 1×1 的那台、且后端报告支持云台时才出现
function ptzCardButton() {
  if (ptz.surface !== 'card') return null;
  const card = state.cards.get(ptz.name)?.el;
  return card ? $('[data-act="ptz"]', card) : null;
}

// 收起方向盘（工具栏开关或方向盘中心点）。收起前先把没落地的转动停掉。
function ptzToggle(force) {
  const next = typeof force === 'boolean' ? force : !ptz.open;
  if (next === ptz.open) return;
  ptz.open = next;
  if (!next) ptz.halt?.(true);
  ptzRender();
}

function ptzReset() {
  ptz.probing++;
  ptzStopNow();
  ptz.name = '';
  ptz.did = '';
  ptz.dirs = [];
  ptz.model = '';
  ptz.channel = '';
  ptz.note = '';
  ptz.open = false;
  ptz.surface = '';
  restorePtzPad();
  ptzRender();
}

function ptzRender() {
  const pad = $('#ptzPad');
  const button = $('#btnViewerPtz');
  if (!pad || !button) return;
  const supported = ptz.dirs.length >= 4;
  const open = supported && ptz.open;
  // 查看器工具栏开关：只有云台机才出现；默认关闭，方向盘要用户点了才显示
  button.hidden = !supported || ptz.surface !== 'viewer';
  button.classList.toggle('on', open);
  button.setAttribute('aria-pressed', String(open));
  if (supported) {
    const label = open ? '收起云台方向键' : '打开云台方向键';
    button.title = ptz.note ? `${label}（${ptz.note}）` : label;
    button.setAttribute('aria-label', label);
  }
  // 1×1 单窗口：开关长在卡片工具栏里，逻辑完全一致
  const cardBtn = ptzCardButton();
  if (cardBtn) {
    cardBtn.hidden = !supported;
    cardBtn.classList.toggle('on', open);
    cardBtn.setAttribute('aria-pressed', String(open));
    cardBtn.title = ptz.note ? `云台控制（${ptz.note}）` : '云台控制';
  } else {
    // 离开 1×1（进查看器、换多窗口布局）时把卡片上的开关状态清掉，
    // 否则那张卡会留着一个高亮但已经没有方向盘的按钮
    $$('.tool.ptz-tool').forEach(el => {
      el.hidden = true;
      el.classList.remove('on');
      el.removeAttribute('aria-pressed');
    });
  }
  pad.hidden = !open;
  ptzMountPad(open);
  // 方向盘压着底部提示条：挂个标记让 toast 抬到它上方（见 body.ptz-on）
  document.body.classList.toggle('ptz-on', open);
  pad.title = ptz.note || '';
  if (!supported) return;
  // 斜向不是所有型号都有对应取值，规格里没有的直接不显示
  $$('.ptz-btn', pad).forEach(dir => {
    dir.hidden = !ptz.dirs.includes(dir.dataset.move);
  });
}

// 规格要联网问 miot-spec.org，同一台反复进出单画面没必要重查
const ptzSpecCache = new Map();      // key -> { at, data }
const PTZ_SPEC_TTL = 10 * 60 * 1000;

function ptzApplySpec(data) {
  const spec = data.spec || {};
  ptz.model = data.model || '';
  ptz.note = spec.note || '';
  ptz.channel = spec.channel || '';
  // 后端已经按通道算过 supported：规格里有云台动作走云端，
  // 没有则走视频连接里的命令通道（这批摄像机的真实路径）。
  ptz.dirs = spec.supported && Array.isArray(spec.dirs) ? spec.dirs : [];
}

async function ptzProbe(name, surface = 'viewer') {
  ptz.probing++;
  // 换摄像头 / 换界面时，上一台可能还在转，先停住再换
  ptzStopNow();
  ptz.name = name || '';
  ptz.did = name ? streamDid(name) : '';
  ptz.dirs = [];
  ptz.model = '';
  ptz.channel = '';
  ptz.note = '';
  ptz.open = false;   // 每台摄像头进来都先收起方向盘，要用再从工具栏打开
  ptz.surface = name ? surface : '';
  ptzRender();
  if (!ptz.name) return;

  const seq = ptz.probing;
  const key = ptz.did || ptz.name;
  const hit = ptzSpecCache.get(key);
  if (hit && Date.now() - hit.at < PTZ_SPEC_TTL) {
    ptzApplySpec(hit.data);
    ptzRender();
    return;
  }

  const q = new URLSearchParams({ name: ptz.name, region: state.region || 'cn' });
  if (ptz.did) q.set('did', ptz.did);
  if (state.user) q.set('id', state.user);
  try {
    const res = await fetch('/ptz/spec?' + q.toString(), { cache: 'no-store' });
    if (seq !== ptz.probing) return;            // 已经切到别的摄像头了
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return;
    ptzSpecCache.set(key, { at: Date.now(), data });
    ptzApplySpec(data);
  } catch {
  }
  if (seq === ptz.probing) ptzRender();
}

// 1×1 单窗口里，当前这张卡片是不是云台机也要探一次，
// 否则云台开关只在全屏查看器里才有，单窗口模式下完全看不到。
let ptzCardName = '';

function syncCardPtz(name) {
  if (state.viewer) return;             // 全屏查看器有自己的 ptzProbe
  if (!name) {
    if (ptzCardName) { ptzCardName = ''; ptzReset(); }
    return;
  }
  if (ptzCardName === name && ptz.surface === 'card') { ptzRender(); return; }
  ptzCardName = name;
  ptzProbe(name, 'card');
}

// 云台失败原因五花八门，直接把后端原文弹出来会是一条带着
// 127.0.0.1:xxxxx 和 Go 运行时措辞的长串 —— 用户看不懂，还挡住画面。
// 归成几句人话，兜底也截断。
function ptzErrText(msg) {
  const m = String(msg || '').trim();
  if (/timeout|deadline|没有响应|request canceled|EOF/i.test(m)) {
    return '云台指令没送出去，重连一下画面再试';
  }
  if (/还没连上|409/.test(m)) return '画面还没连上摄像机，等画面出来再按';
  if (/没有云台命令接口|405/.test(m)) return '这个播放引擎不带云台命令，需要新版';
  if (/这个画面|404/.test(m)) return '画面名对不上，刷新一下再试';
  if (!m) return '云台指令失败';
  const one = m.split('\n')[0];
  return one.length > 48 ? one.slice(0, 48) + '…' : one;
}

async function ptzMove(dir) {
  if (!ptz.name) return;
  const real = ptzFlipDir(dir);        // 吊装/倒装时把方向镜像回去
  const pad = $('#ptzPad');
  const q = new URLSearchParams({ name: ptz.name, move: real, region: state.region || 'cn' });
  if (ptz.did) q.set('did', ptz.did);
  if (state.user) q.set('id', state.user);
  pad?.classList.add('busy');
  const task = (async () => {
    try {
      const res = await fetch('/ptz?' + q.toString(), { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      haptic(8);
    } catch (e) {
      // 长按会连续发指令，失败只提示一次，避免刷屏
      if (Date.now() - ptz.lastErrorAt > 4000) {
        ptz.lastErrorAt = Date.now();
        toast(ptzErrText(e.message), true);
      }
    } finally {
      pad?.classList.remove('busy');
    }
  })();
  ptz.movePromise = task;
  return task;
}

function ptzBind() {
  const pad = $('#ptzPad');
  const button = $('#btnViewerPtz');
  const collapse = $('#ptzCollapse');
  if (!pad) return;

  // 松手要补一条停止：0x112 的 operation 1..4 在多数固件上是
  // 「持续朝该方向转」，不补停止会一路转到限位。
  // immediate：15 秒兜底、切后台这种必须马上停；松手则留出步长余量
  const stop = (immediate) => {
    const had = ptz.moving;
    clearTimeout(ptz.pressTimer);
    clearInterval(ptz.repeatTimer);
    clearTimeout(ptz.holdTimer);
    ptz.pressTimer = ptz.repeatTimer = ptz.holdTimer = 0;
    $$('.ptz-btn.on', pad).forEach(b => b.classList.remove('on'));
    ptz.moving = false;
    if (!had) return;
    clearTimeout(ptz.stopTimer);
    ptz.stopTimer = 0;
    const delay = immediate ? 0 : ptzStepMs();
    if (delay <= 0) {
      ptzSendStop();
    } else {
      // 松手到真正停之间就是「一步」的长度，档位越大这一段越长
      ptz.stopTimer = setTimeout(() => { ptz.stopTimer = 0; ptzSendStop(); }, delay);
    }
  };

  pad.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button > 0) return;
    const btn = e.target.closest('.ptz-btn');
    if (!btn || btn.hidden) return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch {}
    const dir = btn.dataset.move;

    // 手指从一个方向滑到另一个：先把上一个停掉，否则两个方向会叠在一起
    $$('.ptz-btn.on', pad).forEach(b => { if (b !== btn) b.classList.remove('on'); });
    clearTimeout(ptz.stopTimer);      // 上一次松手还没落地的停止命令作废
    ptz.stopTimer = 0;
    clearTimeout(ptz.pressTimer);
    clearInterval(ptz.repeatTimer);
    clearTimeout(ptz.holdTimer);

    btn.classList.add('on');
    ptz.moving = true;
    haptic(10);
    ptzMove(dir);

    // 按住继续转：先等 700ms（轻点只走一下），到点先补一次再起定时器，
    // 否则第一次要等到 2×700ms 才发，手感像卡住了
    ptz.pressTimer = setTimeout(() => {
      ptzMove(dir);
      ptz.repeatTimer = setInterval(() => ptzMove(dir), PTZ_REPEAT_MS);
    }, PTZ_REPEAT_MS);

    // 兜底：手指滑出屏幕时可能收不到 pointerup，别让电机一直转
    ptz.holdTimer = setTimeout(() => stop(true), PTZ_HOLD_MAX);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']
    .forEach(ev => pad.addEventListener(ev, () => stop(false)));
  pad.addEventListener('contextmenu', e => e.preventDefault());
  // 切后台 / 锁屏时收不到 pointerup：不补这一条，电机会一直转到限位
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(true); });

  // 方向盘会被临时挪进 1×1 的卡片里，记住原始父节点以便归位；
  // 收起开关在卡片工具栏上，那里也要能立刻停住电机。
  ptz.home = pad.parentNode;
  ptz.halt = stop;

  button?.addEventListener('click', () => ptzToggle());
  collapse?.addEventListener('click', () => ptzToggle(false));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

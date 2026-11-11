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
  settings: { layout: '1x1', gridLayout: '2x2', scope: 'room', display: 'fill', hideBattery: true, keepAlive: true, bgSleep: true, theme: 'auto', roomLayouts: {}, ...loadJSON('imi.settings', {}) },
  streamUrls: {},        // name -> 配置里的流地址（/api/streams 激活后不含 url）
  roomData: cachedRooms(), // 本地助手 /rooms 返回的米家房间与设备映射（启动时先用上次缓存）
};

// NAS 版由内置网关把二维码助手代理到同源；桌面版仍直连本机 19841
const QR_ORIGIN = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname)
  ? `${location.protocol}//127.0.0.1:19841`
  : '';

// 桌面版加载页面时带 ?app=1，用来区分提示语（托盘重启 vs 运行 bat）
const IS_APP = new URLSearchParams(location.search).has('app');

// 后台保持连接最多维持 2 分钟，之后释放视频解码与引擎缓冲，回到前台自动重连
const BACKGROUND_IDLE_MS = 2 * 60 * 1000;
const HIDDEN_GRACE_MS = 4 * 1000;
const RESUME_STAGGER_MS = 450;
let bgTimer = 0;
let resumeToken = 0;
let pollTimers = [];
let authToastAt = 0;
let roomSyncFailed = false;

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

function saveMeta() {
  localStorage.setItem('imi.meta', JSON.stringify(state.meta));
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
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

function applyTheme(mode, persist = true) {
  state.settings.theme = mode;
  if (persist) saveSettings();
  const dark = mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('#btnTheme');
  if (btn) {
    btn.innerHTML = icon(mode === 'auto' ? 'i-auto' : mode === 'light' ? 'i-sun' : 'i-moon');
    btn.title = `主题：${mode === 'auto' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色'}（点击切换）`;
  }
  $$('#themeSeg [data-theme]').forEach(b => b.classList.toggle('on', b.dataset.theme === mode));
}

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
  const dsel = $('#setDisplay');
  if (dsel) dsel.value = state.settings.display === 'fill' ? 'fill' : 'ratio';
  $$('#displaySeg [data-display]').forEach(b => b.classList.toggle('on', b.dataset.display === (state.settings.display === 'fill' ? 'fill' : 'ratio')));
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
  state.settings.layout = savedLayoutFor(roomLabel(name));
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

// 首页布局要同时满足：媒体区 16:9、不裁剪、尽量铺满窗口。
// 宽度受限时按宽度算；高度受限时按高度反推卡片宽度，再整体居中。
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
  const byWidth = (availW - gap * (cols - 1)) / cols;
  const byHeight = (availH - gap * (rows - 1)) / rows * 16 / 9;
  const width = Math.max(200, Math.floor(Math.min(byWidth, byHeight)));
  const rowH = Math.ceil((width - 2) * 9 / 16);
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

function renderRooms() {
  const box = $('#roomList');
  if (!box) return;
  const names = cameraList();
  if (!names.length) {
    box.innerHTML = '<div class="room-empty">还没有<br>摄像头</div>';
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

async function pollSignals() {
  if (state.pageHidden || state.viewer || signalBusy || !state.cards.size) return;
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

function stepSingle(dir) {
  const names = cameraList();
  if (names.length < 2) return;
  let i = names.indexOf(state.settings.single);
  if (i < 0) i = 0;
  state.settings.single = names[(i + dir + names.length) % names.length];
  saveSettings();
  refreshStreams();
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

  $('#grid').querySelectorAll('.grid-slot').forEach(el => el.remove());

  visible.forEach((name, i) => {
    if (!state.cards.has(name)) createCard(name, i * 600);
  });
  for (const [name, card] of state.cards) {
    if (!visible.includes(name)) {
      if (state.viewer?.name === name) closeViewer();
      card.destroy();
      state.cards.delete(name);
    }
  }

  const grid = $('#grid');
  const single = state.settings.layout === '1x1';
  const cols = single ? 1 : spec.cols;
  const rows = single ? 1 : (spec.limit ? Math.ceil(spec.limit / spec.cols) : Math.max(1, Math.ceil(visible.length / spec.cols)));
  grid.style.setProperty('--grid-cols', String(cols));
  grid.style.setProperty('--grid-rows', String(rows));
  grid.dataset.layout = state.settings.layout;
  grid.classList.toggle('single', single);
  grid.classList.toggle('fit', !single && state.settings.layout !== 'all');
  grid.classList.toggle('fill', state.settings.display === 'fill');

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

function tickClock() {
  const d = new Date();
  const text = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const foot = $('#footClock');
  if (foot) foot.textContent = text;
  const viewer = $('#viewerClock');
  if (viewer) viewer.textContent = text;
}

async function syncRooms() {
  if (state.pageHidden || !state.user) return;
  try {
    const params = new URLSearchParams({ region: state.region });
    params.set('id', state.user);
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
    for (const [name, card] of state.cards) {
      const room = $('.card-title b', card.el);
      if (room) room.textContent = roomLabel(name);
      const hero = $('[data-role="heroName"]', card.el);
      if (hero) hero.textContent = displayCameraName(name);
    }
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

// 画面缩放/平移：滚轮或 HUD 缩放，拖动平移，双击复位
function createZoom(surface, { onChange } = {}) {
  if (surface._zoom) return surface._zoom;

  const st = { enabled: false, scale: 1, tx: 0, ty: 0, dragging: false, pointerId: null, sx: 0, sy: 0, stx: 0, sty: 0 };
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

  function setEnabled(on) {
    on = !!on;
    if (st.enabled === on) {
      if (!on) reset();
      return;
    }
    st.enabled = on;
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
    if (!st.enabled || ev.button !== 0) return;
    if (ev.target.closest('button, .zoom-hud, .card-tools, .card-menu-btn, [data-act], .mask-btn')) return;
    st.dragging = true;
    st.pointerId = ev.pointerId;
    st.sx = ev.clientX;
    st.sy = ev.clientY;
    st.stx = st.tx;
    st.sty = st.ty;
    surface.classList.add('zoom-drag');
    try { surface.setPointerCapture(ev.pointerId); } catch {}
    ev.preventDefault();
  };
  const onMove = ev => {
    if (!st.dragging || ev.pointerId !== st.pointerId) return;
    st.tx = st.stx + ev.clientX - st.sx;
    st.ty = st.sty + ev.clientY - st.sy;
    clamp();
    apply();
  };
  const onUp = ev => {
    if (!st.dragging || ev.pointerId !== st.pointerId) return;
    st.dragging = false;
    surface.classList.remove('zoom-drag');
    try { surface.releasePointerCapture(ev.pointerId); } catch {}
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
    mask.innerHTML = '<div><div class="spinner"></div>正在建立局域网连接…</div>';
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
    setBadge('connecting');
    mask.classList.remove('hide');
    spinnerMask();
    setSignal(0, '正在连接…');

    player = makePlayer(name, {
      contain: false,
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
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        lastLiveAt = Date.now();
        setBadge('live');
        mask.classList.add('hide');
      } else if (phase !== 'timeout' && Date.now() - (lastLiveAt || startedAt) > 30000) {
        setBadge('timeout');
        mask.classList.remove('hide');
        lastError = lastError || '摄像头可能休眠或离线';
        scheduleRetry('连接超时');
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

  const cardVideo = state.cards.get(name)?.player?.video;
  const initialMuted = cardVideo ? cardVideo.muted : state.muted;

  // 先建 viewer 播放器；失败时不影响卡片和 state.viewer
  let player;
  try {
    player = makePlayer(name, {
      contain: state.settings.display === 'ratio',
      muted: initialMuted,
      microphone: false,
      onReady: () => setViewerState(true),
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

  renderViewerChips();
  tickClock();

  $('#modalViewer').classList.add('open');
  $('#modalViewer').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeViewer() {
  const viewer = state.viewer;
  if (!viewer) return;

  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

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
  $('#modalViewer').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  releaseCardsForViewer();
  setRecUI(false);
}

function recreateViewerPlayer({ microphone } = {}) {
  const viewer = state.viewer;
  if (!viewer || !viewer.player || viewer.bgSuspended) return;
  const v = viewer.player.video;
  const wasMuted = v ? v.muted : state.muted;

  viewer.player.destroy();
  viewer.zoom?.destroy();
  viewer.zoom = null;
  const player = makePlayer(viewer.name, {
    contain: state.settings.display === 'ratio',
    muted: wasMuted,
    microphone: microphone ?? viewer.microphone,
  });
  viewer.player = player;
  viewer.microphone = microphone ?? viewer.microphone;
  viewer.muted = wasMuted;
  $('#viewerStage').innerHTML = '';
  $('#viewerStage').appendChild(player.el);
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
    contain: state.settings.display === 'ratio',
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
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function exitWall() {
  if (!document.body.classList.contains('wall')) return;
  document.body.classList.remove('wall');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    $('#modalViewer').requestFullscreen?.().catch(() => {});
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

function renderDevices(sources) {
  const box = $('#deviceList');
  box.innerHTML = '';

  if (!sources.length) {
    box.innerHTML = '<div class="muted" style="padding:18px;text-align:center">没有摄像头</div>';
    return;
  }

  for (const source of sources) {
    const { ip, mac } = parseInfo(source.info);
    const u = new URL(source.url);
    const did = u.searchParams.get('did') || '';
    const model = u.searchParams.get('model') || '';
    const name = 'cam_' + (did || Math.random().toString(36).slice(2, 8));
    const added = !!state.meta[name] || !!state.streams[name];

    const row = document.createElement('label');
    row.className = 'device';
    row.innerHTML = `
      <input type="checkbox" ${added ? '' : 'checked'} value="${escapeHTML(name)}">
      <div class="device-text">
        <b>${escapeHTML(source.name || '未命名摄像头')}</b>
        <span>${escapeHTML([ip, shortModel(model)].filter(Boolean).join(' · '))}</span>
      </div>
      <span class="tag ${added ? 'added' : ''}">${added ? '已添加' : escapeHTML(shortModel(model))}</span>
    `;
    row.dataset.source = JSON.stringify({ ...source, did, ip, mac, streamName: name });
    row.querySelector('input').addEventListener('change', updateAddButton);
    box.appendChild(row);
  }

  updateAddButton();
}

function updateAddButton() {
  const checked = $$('#deviceList input:checked').length;
  $('#btnAddSelected').disabled = checked === 0;
  $('#btnAddSelected').textContent = checked ? `添加选中摄像头（${checked}）` : '添加选中摄像头';
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

      await api(`/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(source.url)}`, {
        method: 'PUT',
      });

      // 如果已存在旧 card，先移除，稍后按新配置重建
      state.cards.get(name)?.destroy();
      state.cards.delete(name);

      state.meta[name] = {
        name: source.name || name,
        model,
        ip: source.ip,
        mac: source.mac,
        did,
        src: source.url,
        user: state.user,
        region: state.region,
        addedAt: Date.now(),
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

async function applyQuality(name, q) {
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
  const map = QUALITY_BY_MODEL[meta.model || info.model] || QUALITY_BY_MODEL._default;
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
    toast(q === 'sd' ? '已切换到流畅画质，正在重连' : '已切换到高清画质，正在重连');
    return true;
  } catch (e) {
    toast('切换失败：' + e.message, true);
    return false;
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

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings() {
  updateSettings();
  updateLayoutUI();
  applyTheme(themeMode(), false);
  $('#setLayout').value = LAYOUTS[state.settings.layout] ? state.settings.layout : '2x2';
  $('#setDisplay').value = state.settings.display === 'fill' ? 'fill' : 'ratio';
  $('#setHideBattery').checked = state.settings.hideBattery !== false;
  $('#setKeepAlive').checked = state.settings.keepAlive !== false;
  $('#setBgSleep').checked = state.settings.bgSleep !== false;
  $('#modalSettings').classList.add('open');
  $('#modalSettings').setAttribute('aria-hidden', 'false');
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
  $('#btnRefresh').addEventListener('click', async () => {
    await checkEngine();
    await refreshStreams();
    for (const card of state.cards.values()) card.reload();
    syncRooms();
    toast('画面已刷新，房间信息更新中…');
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
  $$('#displaySeg [data-display]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.display = btn.dataset.display === 'fill' ? 'fill' : 'ratio';
      saveSettings();
      updateLayoutUI();
      refreshStreams();
    });
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
  $('#singleSelect').addEventListener('change', () => {
    state.settings.single = $('#singleSelect').value;
    saveSettings();
    refreshStreams();
  });
  $('#setDisplay').addEventListener('change', () => {
    state.settings.display = $('#setDisplay').value === 'fill' ? 'fill' : 'ratio';
    saveSettings();
    updateLayoutUI();
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

  $('#btnViewerQuality').addEventListener('click', ev => {
    ev.stopPropagation();
    $('#qualityMenu').classList.toggle('open');
  });
  $$('#qualityMenu button').forEach(btn => {
    btn.addEventListener('click', () => changeQuality(btn.dataset.q));
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
    if (!document.fullscreenElement) exitWall();
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

async function init() {
  bindEvents();

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
  // 房间信息按需刷新：没有缓存时先在引擎登录前拉一次，之后只在手动刷新时更新，
  // 避免助手反复登录把引擎正在用的 token 挤掉。
  if (!state.roomData) {
    toast('正在读取房间信息…');
    try { await syncRooms(); } catch {}
  }
  await refreshStreams();
  setTimeout(syncDeviceMeta, 6000);

  startPolling();
  pollSignals();
  window.addEventListener('resize', () => fitGrid(state.cards.size));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode() === 'auto') applyTheme('auto', false);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

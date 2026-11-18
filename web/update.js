/* IMI-LAN · 版本更新检查（检查到新版 → 提示 → 跳转 Release 页）
 *
 * 只做「检查 + 跳转」，不下载、不安装：三端共用这一份 web 代码。
 * 设计参照 LoveqPodcast 的 UpdateCenter，但砍掉下载/校验/镜像资产那套重机制。
 *
 * 静默检查的纪律（与 LoveqPodcast 一致）：
 * - 启动时后台查一次，失败不打扰、不写持久状态 —— 网络抖一下不能变成「以后都不查了」
 * - 当前版本拿不到（fnOS / 普通浏览器）时跳过自动提示，不拿引擎版本乱比
 * - 比较策略单向保守：宁可漏报一次，也不按猜测把人引到不该升的版本
 */

const $u = (sel, root = document) => root.querySelector(sel);

// 与 GitHub Release 的 tag（v1.0.2）对应；releases/latest 永远指向最新正式版。
const REPO = 'pigstrong9/IMI-LAN';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_TIMEOUT_MS = 8000;
const MIRROR_TIMEOUT_MS = 12000;

/**
 * 元数据（api.github.com）的源列表。空前缀 = 直连；镜像前缀直接拼在完整 URL 前。
 * 直连优先（最快最稳），失败换镜像 —— 国内网络直连 GitHub 经常不通。
 *
 * 名单会腐坏，这里只放 2026-11-18 实测支持 CORS 且能返回真实 tag 的源：
 *   ""                      → 200 + CORS ✓
 *   "https://gh-proxy.com/" → 200 + CORS ✓（实测返回 "tag_name":"v1.0.2"）
 * 不放 ghfast.top（对 API 返回 403）、cdn.gh-proxy.com（302 到失效域名）、
 * gh.monlor.com（只代理资产、API 404）。全部失败时的兜底是打开 Release 页，
 * 让用户自己下 —— 所以内置列表只是「当前最优快照」，不是长期保证。
 */
const API_SOURCES = ['', 'https://gh-proxy.com/'];
const LAST_OK_KEY = 'imi.update.lastApiSource';

/**
 * 解析 "v1.0.2" / "1.0" / " V1.0.3 " → [1,0,2]。
 * 任一段不是纯数字返回 null（"latest"、"1.0-beta"）。
 * 不做「把 beta 当 0」这类猜测 —— 猜错方向会把人引到更旧或不存在的版本。
 */
function parseVer(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const body = (trimmed[0] === 'v' || trimmed[0] === 'V') ? trimmed.slice(1) : trimmed;
  if (!body) return null;
  const parts = body.split('.');
  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return nums.length ? nums : null;
}

/** 远程是否比本地新；短的一侧补 0（1.5 与 1.5.0 视为相同）。任一侧不可比 → false。 */
function isNewer(remote, local) {
  const r = parseVer(remote);
  const l = parseVer(local);
  if (!r || !l) return false;
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] ?? 0;
    const b = l[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/**
 * 当前应用版本。来源优先级：
 * 1. ?appVer=x.y.z —— 桌面壳从 package.json 注入
 * 2. UA 里的 IMI-LAN-Android/x.y.z —— 安卓壳已注入（无需改原生）
 * 3. 空 —— fnOS / 普通浏览器：跳过自动提示（它们没有独立的应用版本号）
 */
function appVersion() {
  const q = new URLSearchParams(location.search);
  const fromUrl = (q.get('appVer') || '').trim();
  if (fromUrl) return fromUrl;
  const m = navigator.userAgent.match(/IMI-LAN-Android\/([0-9][0-9.]*)/i);
  return m ? m[1] : '';
}

/** 上次成功的源提到最前，其余保持原顺序。记下的源已不在列表里就忽略。 */
function promotedSources() {
  let last = '';
  try { last = localStorage.getItem(LAST_OK_KEY) || ''; } catch (_) {}
  if (!last || !API_SOURCES.includes(last)) return API_SOURCES;
  return [last, ...API_SOURCES.filter(s => s !== last)];
}

/** 单个源取 tag_name。带超时（UA 是 forbidden header 设不了，浏览器默认 UA 即可满足 GitHub API）。 */
async function fetchFromSource(prefix) {
  const isMirror = !!prefix;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), isMirror ? MIRROR_TIMEOUT_MS : CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(prefix + API_LATEST, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const tag = String(data.tag_name || '').trim();
    if (!tag) throw new Error('空 tag');
    return tag;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取最新 release 的 tag_name：按「上次成功源优先」的顺序逐个试，
 * 某个源成功就记住它并立即返回；全部失败才抛错（静默检查会吞掉）。
 * 只记成功源 —— 失败也记的话，下次会先把一个坏源排在第一个白等超时。
 */
async function fetchLatestTag() {
  let lastErr;
  for (const prefix of promotedSources()) {
    try {
      const tag = await fetchFromSource(prefix);
      try { localStorage.setItem(LAST_OK_KEY, prefix); } catch (_) {}
      return tag;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无可用更新源');
}

function openReleases() {
  const win = window.open(RELEASES_PAGE, '_blank');
  if (win) {
    win.opener = null; // 手动断开 opener，等效 noopener（noopener feature 会让 window.open 恒返回 null，不能用）
  } else {
    // Electron / 部分浏览器拦截 popup 时，退回本页跳转，保证一定有出口
    location.href = RELEASES_PAGE;
  }
}

/** 在设置按钮上挂红点；remove=true 时摘掉。 */
function setBadge(on) {
  const btn = document.getElementById('btnSettings');
  if (!btn) return;
  let dot = document.getElementById('updateDot');
  if (on) {
    if (!dot) {
      dot = document.createElement('i');
      dot.id = 'updateDot';
      dot.className = 'update-dot';
      dot.title = '有新版本';
      btn.appendChild(dot);
    }
    dot.hidden = false;
  } else if (dot) {
    dot.hidden = true;
  }
}

/** 更新设置「其他」页里的检查更新行。openable=true 表示点行会跳 Release 页。 */
function setRow(text, openable = false) {
  const row = document.getElementById('updateRow');
  const label = document.getElementById('updateStatus');
  if (!row || !label) return;
  label.textContent = text;
  label.title = openable ? '打开 Release 页' : '点击检查';
  // copyable 要加在 <b> 上：CSS 选择器是 .settings-row b.copyable
  label.classList.toggle('copyable', openable);
  row.dataset.openable = openable ? '1' : '';
}

let latestTagCache = '';
let checking = false;

/** 执行一次检查。manual=true 时把结果/失败显示出来；静默时只在发现新版时提示。 */
async function checkUpdate(manual) {
  // 静默检查与连点可能重叠：只放行一次，避免并发结果乱序覆盖
  if (checking) return;
  checking = true;
  const current = appVersion();
  setRow('正在检查…');
  try {
    const tag = await fetchLatestTag();
    if (!tag) throw new Error('空版本号');
    latestTagCache = tag.replace(/^v/i, '');
    if (!current) {
      // 拿不到本地版本（fnOS / 浏览器）：不猜，给一个「去 Release 页」的出口
      setRow(`查看最新版 v${latestTagCache}`, true);
      if (manual) openReleases();
      return;
    }
    if (isNewer(latestTagCache, current)) {
      setRow(`发现新版 v${latestTagCache} · 点击查看`, true);
      setBadge(true);
    } else {
      setRow(`已是最新（v${current}）`);
      setBadge(false);
    }
  } catch (e) {
    // 静默失败：恢复常态文字，不提示、不写状态，下次启动照常再查
    if (manual) {
      setRow('检查失败，点击查看 Release 页', true);
    } else {
      setRow(current ? `当前 v${current} · 点击检查` : '检查更新');
    }
  } finally {
    checking = false;
  }
}

function init() {
  const row = document.getElementById('updateRow');
  if (row) {
    row.addEventListener('click', () => {
      // 已确认可跳转（有新版 / 无本地版本 / 检查失败兜底）→ 直接跳 Release 页；否则手动查一次
      if (row.dataset.openable) openReleases();
      else checkUpdate(true);
    });
  }
  // 启动静默检查：延后 3 秒，避开开屏的加载高峰；失败完全不打扰
  setTimeout(() => checkUpdate(false), 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

// electron/video/configEngine.cjs
// TVBox / CatVod 配置的读取、解码、多仓解析与站点归一化。
//
// 对齐手机端 BaseLoader 的口径：
//  - 配置载体可能是 <pre> HTML、整体 Base64、8位标记 + "**" + Base64，或带注释的宽松 JSON
//  - 数组 [{name,url}] 是多仓清单，可递归（最多 8 层，防循环）
//  - sites / spider / lives / parses 四块结构保持原样
//  - 站点相对地址（api / ext / jar）按配置文件地址还原成绝对地址
//
// 站点执行路由：
//  - type 0 / 1  → CMS 直连（Node 侧发 ac=videolist / ac=detail）
//  - type 4      → CMS JSON 直连（ext 里再取参数）
//  - 其余        → 走引擎（jar / js / py / php / catnode 由引擎的工厂链决定）

const fs = require('fs/promises');
const path = require('path');

const MAX_DEPOT_DEPTH = 8;

const stripCommentsAndTrailingCommas = (text) => text
  .replace(/^\uFEFF/, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1')
  .replace(/,(\s*[}\]])/g, '$1');

const tryJson = (text) => {
  try {
    return JSON.parse(text);
  } catch { /* 继续尝试宽松写法 */ }
  try {
    return JSON.parse(stripCommentsAndTrailingCommas(text));
  } catch { return null; }
};

const base64DecodeToText = (value) => {
  try {
    return Buffer.from(String(value).replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch { return null; }
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 解码配置原文，返回 JSON 树（对象或数组），失败返回 null。 */
const decodeConfig = (raw) => {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;

  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(text);
  if (pre?.[1]?.trim()) text = pre[1].trim();

  const direct = tryJson(text);
  if (direct && (isObject(direct) || Array.isArray(direct))) return direct;

  // 8 位字母数字 + ** 之后是 Base64（手机端 Decoder.base64）
  const marker = /[A-Za-z0-9]{8}\*\*/.exec(text);
  if (marker) {
    const decoded = base64DecodeToText(text.slice(marker.index + marker[0].length));
    if (decoded) {
      const inner = tryJson(decoded);
      if (inner && (isObject(inner) || Array.isArray(inner))) return inner;
    }
  }

  const whole = base64DecodeToText(text);
  if (whole) {
    const inner = tryJson(whole);
    if (inner && (isObject(inner) || Array.isArray(inner))) return inner;
  }
  return null;
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value ?? '').trim());
/** Windows 盘符路径（C:\ / C:/）与 UNC 路径：不能交给 new URL，否则 "C:" 会被当成 scheme 编码成 c:/. */
const isLocalPath = (value) => /^[a-zA-Z]:[\\/]/.test(String(value ?? '').trim()) || String(value ?? '').trim().startsWith('\\\\');

const normalizeEntryUrl = (value, baseUrl) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (isLocalPath(raw)) return raw;
  if (isHttpUrl(raw) || raw.startsWith('file:')) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch { return raw; }
};

/**
 * 用 Node 的 http/https 取文本。
 * 为什么不用 main 里的全局 fetch：Electron 主进程的 fetch 走 Chromium 网络栈，
 * 中文域名（配置地址常见）和系统代理在它那里不一定解析得动，官方构建上会直接报
 * "Failed to fetch"。Node 这条走 OS 解析，稳。
 */
const httpGetText = (url, redirects = 5) =>
  new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = parsed.protocol === 'https:' ? require('https') : require('http');
    const request = transport.get(
      parsed,
      { headers: { 'User-Agent': 'okhttp/5.5.0', Accept: '*/*' }, timeout: 25_000 },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
          response.resume();
          const next = new URL(response.headers.location, parsed).toString();
          httpGetText(next, redirects - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(Object.assign(new Error(`配置请求失败 HTTP ${status}`), { code: 'config-http', status }));
          return;
        }
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve(text));
      },
    );
    request.on('timeout', () => request.destroy(new Error('配置请求超时')));
    request.on('error', reject);
  });

const fetchText = async (url) => {
  if (url.startsWith('file:')) {
    const filePath = decodeURIComponent(url.replace(/^file:\/\/\/?/i, ''));
    return fs.readFile(path.normalize(filePath), 'utf8');
  }
  if (!isHttpUrl(url)) {
    // 允许直接传本地路径
    return fs.readFile(path.normalize(url), 'utf8');
  }
  try {
    return await httpGetText(url);
  } catch (nodeError) {
    if (typeof fetch !== 'function') throw nodeError;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'okhttp/5.5.0', Accept: '*/*' },
        signal: AbortSignal.timeout(25_000),
        redirect: 'follow',
      });
      if (!response.ok) throw Object.assign(new Error(`配置请求失败 HTTP ${response.status}`), { code: 'config-http', status: response.status });
      return response.text();
    } catch (fetchError) {
      // 两条路都失败时，报出第一条（Node）的原因，它在官方构建上更能说明问题
      throw nodeError;
    }
  }
};

/** 把 depot / 最终配置都装上来源地址，站点相对地址按它还原。 */
const loadConfigFrom = async (url, { depth = 0, visited = new Set() } = {}) => {
  if (depth > MAX_DEPOT_DEPTH) throw Object.assign(new Error('多仓层级过深，疑似循环引用'), { code: 'config-depot-loop' });
  const normalizedUrl = normalizeEntryUrl(url, undefined);
  if (visited.has(normalizedUrl)) throw Object.assign(new Error('多仓地址重复引用'), { code: 'config-depot-loop' });
  visited.add(normalizedUrl);

  const text = await fetchText(normalizedUrl);
  const decoded = decodeConfig(text);
  if (!decoded) throw Object.assign(new Error('配置内容无法解析（不是合法的 TVBox JSON）'), { code: 'config-invalid' });

  // 多仓清单：[{name,url}]，没有 sites / sites 以外的键
  if (Array.isArray(decoded)) {
    const entries = decoded
      .map((item) => (isObject(item) ? { name: String(item.name ?? item.title ?? ''), url: normalizeEntryUrl(item.url ?? item.api ?? item.ext, normalizedUrl) } : null))
      .filter((item) => item?.url && isHttpUrl(item.url));
    if (!entries.length) throw Object.assign(new Error('多仓清单里没有可用的地址'), { code: 'config-depot-empty' });
    return {
      kind: 'depot',
      sourceUrl: normalizedUrl,
      entries,
    };
  }

  return { kind: 'config', sourceUrl: normalizedUrl, config: decoded };
};

const splitJar = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const [urlPart, md5Part] = raw.split(';md5;');
  return md5Part ? `${urlPart};md5;${md5Part}` : urlPart;
};

/**
 * 把一份 TVBox 配置归一化成 Folia 侧使用的站点列表。
 * 只做地址还原与字段搬运，不改语义（执行方式由 api / type 决定）。
 */
const normalizeConfig = ({ config, sourceUrl }) => {
  const sitesRaw = Array.isArray(config?.sites) ? config.sites : [];
  const defaultSpider = typeof config?.spider === 'string' ? config.spider : '';

  const sites = [];
  const seenKeys = new Set();
  for (const raw of sitesRaw) {
    if (!isObject(raw)) continue;
    const name = String(raw.name ?? '').trim();
    const type = Number.isFinite(raw.type) ? Number(raw.type) : 0;
    const api = normalizeEntryUrl(raw.api, sourceUrl);
    const jar = splitJar(normalizeEntryUrl(raw.jar ?? defaultSpider, sourceUrl));
    let ext = raw.ext ?? '';
    if (typeof ext === 'string') ext = normalizeEntryUrl(ext, sourceUrl);
    const key = String(raw.key ?? raw.id ?? name ?? '').trim() || `site-${sites.length}`;
    const siteKey = seenKeys.has(key) ? `${key}-${sites.length}` : key;
    seenKeys.add(siteKey);
    sites.push({
      siteKey,
      name: name || key,
      type,
      api,
      ext: typeof ext === 'string' ? ext : JSON.stringify(ext),
      extRaw: ext,
      jar,
      searchable: raw.searchable !== 0,
      quickSearch: raw.quickSearch === 1,
      filter: raw.filter === 1,
      playerUrl: normalizeEntryUrl(raw.playUrl ?? config?.playUrl, sourceUrl),
      // type 4 与 0/1 都是 HTTP 直连；其余交给引擎
      route: (type === 0 || type === 1 || type === 4) ? 'cms' : 'engine',
    });
  }

  return {
    sourceUrl,
    spider: normalizeEntryUrl(defaultSpider, sourceUrl),
    sites,
    lives: Array.isArray(config?.lives) ? config.lives : [],
    parses: Array.isArray(config?.parses) ? config.parses : [],
    flags: Array.isArray(config?.flags) ? config.flags : [],
    wallpaper: config?.wallpaper ?? null,
  };
};

/** CMS 直连（type 0/1/4）：拼参数，返回原始 JSON。 */
const buildCmsUrl = (site, { ac, t, pg, wd, ids, flag, play } = {}) => {
  const base = String(site.api ?? '').trim();
  const sep = base.includes('?') ? '&' : '?';
  const params = new URLSearchParams();
  if (ac) params.set('ac', ac);
  if (t) params.set('t', t);
  if (pg) params.set('pg', String(pg));
  if (wd) params.set('wd', wd);
  if (ids) params.set('ids', ids);
  if (flag) params.set('flag', flag);
  if (play) params.set('play', play);
  const query = params.toString();
  return query ? `${base}${sep}${query}` : base;
};

const fetchCmsJson = async (url, referer) => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'okhttp/5.5.0',
      Accept: 'application/json, text/plain, */*',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error(`上游 HTTP ${response.status}`), { code: 'cms-http', status: response.status });
  const text = (await response.text()).trim();
  if (!text) return null;
  const json = tryJson(text);
  if (!json) throw Object.assign(new Error('上游返回的不是 JSON'), { code: 'cms-invalid' });
  return json;
};

module.exports = {
  decodeConfig,
  loadConfigFrom,
  normalizeConfig,
  buildCmsUrl,
  fetchCmsJson,
  tryJson,
  normalizeEntryUrl,
};

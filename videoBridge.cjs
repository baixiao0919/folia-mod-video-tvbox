// electron/video/videoBridge.cjs
// 影视模块的主进程桥：把「配置 → 站点 → 首页/分类/详情/搜索/播放」串起来，
// 并根据站点类型选择执行路径（CMS 直连 or 引擎 RPC）。
//
// 渲染进程只发操作，配置地址 / 已选多仓 / 引擎端口都留在主进程。
// 配置地址可能带 token，所以用 electron-store 保存时可选 safeStorage 加密。

const { loadConfigFrom, normalizeConfig, buildCmsUrl, fetchCmsJson } = require('./configEngine.cjs');
const { createEngineClient } = require('./engineClient.cjs');
const { createEngineHost } = require('./engineHost.cjs');

const CONFIG_KEY = 'video-config';
const DEPOT_KEY = 'video-depot-path';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 海报字段各家叫法不一样：常见 vod_pic，有的只给竖图 vod_pic_thumb、横图 vod_pic_slide，
 * 还有的干脆叫 pic / vod_img。挨个兜一遍，别让「有封面但字段名不同」的站显示成空白。
 */
const pickPic = (item) => {
  if (!isObject(item)) return '';
  const keys = ['vod_pic', 'vod_pic_thumb', 'vod_pic_slide', 'pic', 'vod_img', 'img', 'cover'];
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const mapVod = (item) => (isObject(item) ? {
  id: String(item.vod_id ?? item.id ?? ''),
  name: String(item.vod_name ?? item.name ?? ''),
  pic: pickPic(item),
  remarks: String(item.vod_remarks ?? item.remarks ?? ''),
  year: String(item.vod_year ?? item.year ?? ''),
  area: String(item.vod_area ?? item.area ?? ''),
  typeName: String(item.type_name ?? ''),
  director: String(item.vod_director ?? item.director ?? ''),
  actor: String(item.vod_actor ?? item.actor ?? ''),
} : null);

const mapClass = (item) => (isObject(item) ? {
  id: String(item.type_id ?? item.id ?? ''),
  name: String(item.type_name ?? item.name ?? ''),
} : null);

/** 把 vod_play_from / vod_play_url 拆成按线路分组的剧集列表（CMS 与 spider 两种格式相同）。 */
const parsePlayFlags = (vod) => {
  const fromList = String(vod?.vod_play_from ?? '').split('$$$').filter((item) => item.trim());
  const urlList = String(vod?.vod_play_url ?? '').split('$$$');
  return fromList.map((flag, index) => {
    const episodes = String(urlList[index] ?? '')
      .split('#')
      .filter((item) => item.trim())
      .map((item) => {
        const [name, url] = item.split('$');
        return { name: (name ?? '').trim() || url, url: (url ?? item).trim() };
      })
      .filter((episode) => episode.url);
    return { flag: flag.trim(), episodes };
  });
};

/** 解析 spider / CMS 的 homeContent 结构（两者格式一致：{class, list}；spider 还会带 filters）。 */
const normalizeHome = (payload) => {
  const data = typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
  if (!isObject(data)) return { classes: [], list: [], filters: {} };
  const classes = Array.isArray(data.class) ? data.class.map(mapClass).filter(Boolean) : [];
  const list = Array.isArray(data.list) ? data.list.map(mapVod).filter(Boolean) : [];
  const filters = isObject(data.filters) ? data.filters : {};
  return { classes, list, filters };
};

/**
 * @param {object} deps
 * @param {import('electron').ElectronStore} deps.store
 * @param {import('electron').ElectronStore} deps.settingsStore
 * @param {import('electron').safeStorage} deps.safeStorage
 * @param {string} deps.engineDir
 * @param {string} deps.dataDir
 * @param {() => boolean} [deps.isAppQuitting]
 */
const createVideoBridge = ({ store, safeStorage, engineDir, dataDir, isAppQuitting }) => {
  const host = createEngineHost({ engineDir, dataDir, isAppQuitting });
  const client = createEngineClient({ getBaseUrl: async () => host.baseUrl() ?? (await host.ensureStarted().then(() => host.baseUrl())) });

  /** 内存态：当前归一化配置 + 站点索引 */
  let current = { sourceUrl: null, sites: [], byKey: new Map(), parses: [], lives: [] };
  let loading = null;

  const canEncrypt = () => Boolean(safeStorage?.isEncryptionAvailable?.()) && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';

  const readStored = (key) => {
    const value = store.get(key);
    if (!value) return null;
    if (!isObject(value) || value.__plain !== true) {
      try {
        if (!canEncrypt()) return null;
        return JSON.parse(safeStorage.decryptString(Buffer.from(String(value), 'base64')));
      } catch { return null; }
    }
    return value.data ?? null;
  };

  const writeStored = (key, value) => {
    if (value == null) {
      store.delete(key);
      return;
    }
    if (canEncrypt()) {
      store.set(key, safeStorage.encryptString(JSON.stringify(value)).toString('base64'));
    } else {
      // 系统级加密不可用：只记录非敏感部分（配置地址本身可能含 token，退化为本次运行有效）
      store.set(key, { __plain: true, data: value });
    }
  };

  const applyConfig = (loaded) => {
    const normalized = normalizeConfig({ config: loaded.config, sourceUrl: loaded.sourceUrl });
    current = {
      sourceUrl: loaded.sourceUrl,
      sites: normalized.sites,
      byKey: new Map(normalized.sites.map((site) => [site.siteKey, site])),
      parses: normalized.parses,
      lives: normalized.lives,
      flags: normalized.flags,
    };
    return normalized;
  };

  const siteOf = (siteKey) => current.byKey.get(String(siteKey ?? '')) ?? null;

  /** 渲染层传上来的站点描述 → 引擎调用需要的形状（ext 可能是对象，jar 可能没有）。 */
  const siteOfParams = (raw) => {
    const ext = raw?.ext;
    return {
      siteKey: String(raw?.siteKey ?? raw?.key ?? ''),
      api: String(raw?.api ?? ''),
      ext: typeof ext === 'string' ? ext : (ext == null ? '' : JSON.stringify(ext)),
      jar: typeof raw?.jar === 'string' ? raw.jar : '',
    };
  };

  const ensureEngineSite = async (site) => {
    const result = await client.load({ siteKey: site.siteKey, api: site.api, ext: site.ext, jar: site.jar });
    if (!result.ok) return result;
    return { ok: true };
  };

  const engineCall = async (site, method, params, timeoutMs) => {
    await host.ensureStarted();
    const loaded = await ensureEngineSite(site);
    if (!loaded.ok) return loaded;
    return client.call({ site: { siteKey: site.siteKey, api: site.api, ext: site.ext, jar: site.jar }, method, params, timeoutMs });
  };

  const cmsCall = async (site, params) => {
    const url = buildCmsUrl(site, params);
    try {
      const json = await fetchCmsJson(url, site.api);
      return { ok: true, data: json, url };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'cms-error', message: `CMS 请求失败：${error?.message ?? error}` },
        url,
      };
    }
  };

  const loadByUrl = async (url) => {
    const stored = readStored(CONFIG_KEY);
    const depotPath = readStored(DEPOT_KEY) ?? [];
    let loaded = await loadConfigFrom(url);
    // 多仓：按上次保存的选择链重放，找不到就用第 0 项
    let depth = 0;
    while (loaded.kind === 'depot' && depth < 8) {
      const savedIndex = Number.isInteger(depotPath[depth]) ? depotPath[depth] : 0;
      const index = savedIndex >= 0 && savedIndex < loaded.entries.length ? savedIndex : 0;
      const entry = loaded.entries[index];
      const next = await loadConfigFrom(entry.url, { depth: depth + 1 });
      depth += 1;
      if (next.kind === 'config') {
        loaded = next;
        break;
      }
      loaded = next;
    }
    if (loaded.kind !== 'config') throw Object.assign(new Error('多仓没有解析到最终配置'), { code: 'config-depot-empty' });
    const normalized = applyConfig(loaded);
    writeStored(CONFIG_KEY, { url: loaded.sourceUrl, depotPath });
    void stored;
    return { normalized, sourceUrl: loaded.sourceUrl };
  };

  const ensureLoaded = async () => {
    if (current.sites.length) return current;
    if (loading) return loading;
    const stored = readStored(CONFIG_KEY);
    if (!stored?.url) throw Object.assign(new Error('尚未导入影视配置'), { code: 'config-missing' });
    loading = (async () => {
      const { normalized } = await loadByUrl(stored.url);
      return normalized;
    })().finally(() => { loading = null; });
    return loading;
  };

  const ops = {
    status: async () => {
      const engine = host.getStatus();
      return {
        ok: true,
        data: {
          engine,
          configured: Boolean(readStored(CONFIG_KEY)?.url),
          siteCount: current.sites.length,
          sourceUrl: current.sourceUrl ?? readStored(CONFIG_KEY)?.url ?? null,
        },
      };
    },

    /** 导入（或刷新）配置；多仓时返回待选清单。 */
    importConfig: async ({ url, pick = 0 } = {}) => {
      if (!url) return { ok: false, error: { code: 'invalid-params', message: '缺少配置地址' } };
      let loaded;
      try {
        loaded = await loadConfigFrom(url);
      } catch (error) {
        return { ok: false, error: { code: error.code ?? 'config-error', message: error.message } };
      }
      if (loaded.kind === 'depot') {
        return {
          ok: true,
          data: {
            kind: 'depot',
            sourceUrl: loaded.sourceUrl,
            entries: loaded.entries,
            hint: '这是一份多仓清单，请选择其中一个仓库',
          },
        };
      }
      const normalized = applyConfig(loaded);
      writeStored(CONFIG_KEY, { url: loaded.sourceUrl, depotPath: [] });
      writeStored(DEPOT_KEY, []);
      await client.reset().catch(() => undefined);
      return { ok: true, data: { kind: 'config', siteCount: normalized.sites.length, sourceUrl: loaded.sourceUrl } };
    },

    /** 多仓选择：按索引进入某个仓库 */
    selectDepot: async ({ entries = [], index = 0, sourceUrl } = {}) => {
      const entry = entries[index];
      if (!entry?.url) return { ok: false, error: { code: 'invalid-params', message: '仓库选择无效' } };
      try {
        const loaded = await loadConfigFrom(entry.url);
        if (loaded.kind !== 'config') {
          return { ok: true, data: { kind: 'depot', entries: loaded.entries, sourceUrl: loaded.sourceUrl, hint: '下一层还是多仓，请继续选择' } };
        }
        const normalized = applyConfig(loaded);
        writeStored(CONFIG_KEY, { url: sourceUrl ?? entry.url, depotPath: [index] });
        writeStored(DEPOT_KEY, [index]);
        await client.reset().catch(() => undefined);
        return { ok: true, data: { kind: 'config', siteCount: normalized.sites.length, sourceUrl: loaded.sourceUrl } };
      } catch (error) {
        return { ok: false, error: { code: error.code ?? 'config-error', message: error.message } };
      }
    },

    sites: async () => {
      const state = await ensureLoaded();
      return {
        ok: true,
        data: {
          sourceUrl: state.sourceUrl,
          sites: state.sites.map((site) => ({
            siteKey: site.siteKey,
            name: site.name,
            route: site.route,
            searchable: site.searchable,
          })),
        },
      };
    },

    home: async ({ siteKey } = {}) => {
      const site = siteOf(siteKey);
      if (!site) return { ok: false, error: { code: 'site-missing', message: '站点不存在' } };
      if (site.route === 'cms') {
        let result = await cmsCall(site, { ac: 'videolist' });
        let normalized = result.ok ? normalizeHome(result.data) : { classes: [], list: [] };
        if (!normalized.classes.length && !normalized.list.length) {
          result = await cmsCall(site, { ac: 'detail' });
          normalized = result.ok ? normalizeHome(result.data) : normalized;
        }
        if (!normalized.classes.length && !normalized.list.length) {
          result = await cmsCall(site, {});
          normalized = result.ok ? normalizeHome(result.data) : normalized;
        }
        return result.ok ? { ok: true, data: normalized } : result;
      }
      const result = await engineCall(site, 'homeContent', { filter: 'true' }, 60_000);
      return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
    },

    category: async ({ siteKey, tid, page = 1, extend } = {}) => {
      const site = siteOf(siteKey);
      if (!site) return { ok: false, error: { code: 'site-missing', message: '站点不存在' } };
      if (site.route === 'cms') {
        const result = await cmsCall(site, { ac: 'videolist', t: tid, pg: page });
        return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
      }
      const params = { tid: String(tid ?? ''), pg: String(page ?? 1), filter: 'true' };
      if (extend) params.extend = typeof extend === 'string' ? extend : JSON.stringify(extend);
      const result = await engineCall(site, 'categoryContent', params, 60_000);
      return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
    },

    search: async ({ siteKey, keyword, page = 1, quick = false } = {}) => {
      const site = siteOf(siteKey);
      if (!site) return { ok: false, error: { code: 'site-missing', message: '站点不存在' } };
      if (!keyword) return { ok: false, error: { code: 'invalid-params', message: '缺少搜索关键词' } };
      if (site.route === 'cms') {
        const result = await cmsCall(site, { ac: 'videolist', wd: keyword, pg: page });
        return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
      }
      const result = await engineCall(site, 'searchContent', {
        key: keyword,
        quick: quick ? 'true' : 'false',
        pg: String(page ?? 1),
      }, 60_000);
      return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
    },

    detail: async ({ siteKey, id } = {}) => {
      const site = siteOf(siteKey);
      if (!site) return { ok: false, error: { code: 'site-missing', message: '站点不存在' } };
      if (site.route === 'cms') {
        const result = await cmsCall(site, { ac: 'detail', ids: id });
        if (!result.ok) return result;
        const list = Array.isArray(result.data?.list) ? result.data.list : [];
        const vod = isObject(list[0]) ? list[0] : {};
        return {
          ok: true,
          data: {
            ...mapVod(vod),
            pic: pickPic(vod),
            content: String(vod.vod_content ?? '').replace(/<[^>]+>/g, ''),
            flags: parsePlayFlags(vod),
          },
        };
      }
      const result = await engineCall(site, 'detailContent', { ids: String(id) }, 60_000);
      if (!result.ok) return result;
      const parsed = typeof result.data === 'string' ? (() => { try { return JSON.parse(result.data); } catch { return null; } })() : result.data;
      const list = Array.isArray(parsed?.list) ? parsed.list : [];
      const vod = isObject(list[0]) ? list[0] : {};
      return {
        ok: true,
        data: {
          ...mapVod(vod),
          id: String(vod.vod_id ?? id),
          name: String(vod.vod_name ?? ''),
          pic: pickPic(vod),
          content: String(vod.vod_content ?? '').replace(/<[^>]+>/g, ''),
          flags: parsePlayFlags(vod),
        },
      };
    },

    /** 取播放地址：spider 站走 playerContent，CMS 站直接把选集 URL 交给播放器。 */
    play: async ({ siteKey, flag, id, url: directUrl } = {}) => {
      const site = siteOf(siteKey);
      if (!site) return { ok: false, error: { code: 'site-missing', message: '站点不存在' } };
      if (directUrl) return { ok: true, data: { url: directUrl, headers: {} } };
      if (site.route === 'cms') {
        return { ok: false, error: { code: 'invalid-params', message: 'CMS 站点请直接传选集地址' } };
      }
      const result = await engineCall(site, 'playerContent', {
        flag: String(flag ?? ''),
        id: String(id ?? ''),
        vipFlags: JSON.stringify([]),
      }, 90_000);
      if (!result.ok) return result;
      const parsed = typeof result.data === 'string' ? (() => { try { return JSON.parse(result.data); } catch { return null; } })() : result.data;
      const url = String(parsed?.url ?? '');
      const header = parsed?.header;
      const headers = isObject(header)
        ? header
        : (typeof header === 'string' && header.trim().startsWith('{') ? (() => { try { return JSON.parse(header); } catch { return {}; } })() : {});
      if (!url) return { ok: false, error: { code: 'empty', message: '站点没返回播放地址' } };
      return { ok: true, data: { url, headers, parse: parsed?.parse ?? 0, jx: parsed?.jx ?? null } };
    },

    /** 影视窗口前端自己解析配置，这里按「站点描述」直接调引擎，不依赖桥里的配置缓存。 */
    engineHome: async ({ site } = {}) => {
      const result = await engineCall(siteOfParams(site), 'homeContent', { filter: 'true' }, 60_000);
      return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
    },

    engineCategory: async ({ site, tid, page = 1, extend } = {}) => {
      const params = {
        tid: String(tid ?? ''),
        pg: String(page ?? 1),
        filter: 'true',
      };
      if (extend) params.extend = typeof extend === 'string' ? extend : JSON.stringify(extend);
      const result = await engineCall(siteOfParams(site), 'categoryContent', params, 60_000);
      return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
    },

    engineSearch: async ({ site, keyword, page = 1, quick = false } = {}) => {
      if (!keyword) return { ok: false, error: { code: 'invalid-params', message: '缺少搜索关键词' } };
      const result = await engineCall(siteOfParams(site), 'searchContent', {
        key: String(keyword),
        quick: quick ? 'true' : 'false',
        pg: String(page ?? 1),
      }, 60_000);
      return result.ok ? { ok: true, data: normalizeHome(result.data) } : result;
    },

    engineDetail: async ({ site, id } = {}) => {
      const result = await engineCall(siteOfParams(site), 'detailContent', { id: String(id ?? '') }, 90_000);
      if (!result.ok) return result;
      const parsed = typeof result.data === 'string' ? (() => { try { return JSON.parse(result.data); } catch { return null; } })() : result.data;
      const list = Array.isArray(parsed?.list) ? parsed.list : [];
      const vod = isObject(list[0]) ? list[0] : {};
      return {
        ok: true,
        data: {
          ...mapVod(vod),
          content: String(vod.vod_content ?? '').replace(/<[^>]+>/g, ''),
          playFrom: String(vod.vod_play_from ?? ''),
          playUrl: String(vod.vod_play_url ?? ''),
        },
      };
    },

    enginePlay: async ({ site, flag, id } = {}) => {
      const result = await engineCall(siteOfParams(site), 'playerContent', {
        flag: String(flag ?? ''),
        id: String(id ?? ''),
        vipFlags: JSON.stringify([]),
      }, 150_000);
      if (!result.ok) return result;
      const parsed = typeof result.data === 'string' ? (() => { try { return JSON.parse(result.data); } catch { return null; } })() : result.data;
      const url = String(parsed?.url ?? '');
      const header = parsed?.header;
      const headers = isObject(header)
        ? header
        : (typeof header === 'string' && header.trim().startsWith('{') ? (() => { try { return JSON.parse(header); } catch { return {}; } })() : {});
      if (!url) return { ok: false, error: { code: 'empty', message: '站点没返回播放地址' } };
      return { ok: true, data: { url, headers, parse: parsed?.parse ?? 0 } };
    },

    reset: async () => {
      await client.reset().catch(() => undefined);
      return { ok: true, data: { sites: current.sites.length } };
    },

    stopEngine: async () => {
      client.abortAll();
      await host.stop();
      return { ok: true, data: null };
    },

    engineLog: async () => ({ ok: true, data: { lines: host.getRecentLog() } }),

    /** 载荷界面：拉弹窗事件（长轮询），扫码二维码就在这里以 base64 PNG 返回。 */
    uiPoll: async ({ after = -1, waitMs = 20_000 } = {}) => client.uiPoll({ after, waitMs }),

    /** 载荷界面：回放用户操作（点按钮 / 选条目 / 回填输入框 / 取消）。 */
    uiInput: async (payload) => client.uiInput(payload),
  };

  const request = async (operation, params = {}) => {
    const handler = ops[operation];
    if (!handler) return { ok: false, error: { code: 'unsupported', message: `未知的影视操作：${operation}` } };
    try {
      return await handler(params ?? {});
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code ?? 'video-error',
          message: error?.message ?? String(error),
        },
      };
    }
  };

  return {
    request,
    ensureLoaded,
    stopEngine: () => host.stop(),
  };
};

module.exports = { createVideoBridge, normalizeHome, mapVod };

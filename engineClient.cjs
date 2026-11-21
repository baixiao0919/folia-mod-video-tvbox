// electron/video/engineClient.cjs
// 引擎 RPC 客户端：只负责 POST /spider/* 与错误归一化。
//
// 引擎协议（android-bridge 的 SpiderServer）：
//   POST /health                 → { status, version, javaVersion, port, activeCalls, maxCalls }
//   POST /spider/load  {siteKey,api,ext,jar}            → {code,msg}
//   POST /spider/call  {siteKey,api,ext,jar,method,rpcId,timeoutMs,...params} → {code,data} / {code,stage,error}
//   POST /spider/cancel {rpcId}                        → {code}
//   POST /spider/reset                                  → {code,released}
//
// 重点：取消要发两次。渲染层断开 fetch 只断 Folia↔引擎这条 HTTP，引擎里 worker
// 仍卡在 jar 的同步 OkHttp 上并占着 callPool（上限 64）；必须带同一个 rpcId 发
// /spider/cancel 才会真正中断。

const STAGE_MESSAGES = {
  browser: '该站点需要网页验证，稍后可在设置里完成验证再试',
  download: '站点资源下载失败（jar / 脚本拉不到）',
  resolve: '站点插件地址无效',
  md5: '站点插件校验失败（配置里的 md5 与实际不符）',
  decrypt: '站点插件解密失败（加固壳暂不支持）',
  dex2jar: '站点插件转换失败（dex 无法转成 JVM 类）',
  class: '站点插件里找不到爬虫类',
  init: '站点插件初始化失败',
  instantiate: '站点插件实例化失败',
  call: '站点插件执行报错',
  timeout: '站点响应超时',
  empty: '站点没有返回内容',
  upstream: '站点上游返回了错误页',
  interaction: '站点要求交互（网盘扫码/登录），授权窗口已弹出，完成后重试',
  browserchallenge: '站点需要完成人机验证',
};

const stageMessage = (stage, fallback) => {
  if (stage && STAGE_MESSAGES[stage]) return STAGE_MESSAGES[stage];
  return fallback || '站点请求失败';
};

const normalizeError = (payload, status) => {
  const stage = typeof payload?.stage === 'string' ? payload.stage : null;
  const message = stageMessage(stage, payload?.error || payload?.detail || payload?.msg);
  return {
    code: status >= 500 ? 'engine-busy' : 'site-error',
    stage,
    message,
    detail: payload?.detail ?? null,
    httpStatus: status || 0,
  };
};

/**
 * @param {object} options
 * @param {() => Promise<string>} options.getBaseUrl 取引擎地址（会按需启动）
 */
const createEngineClient = ({ getBaseUrl }) => {
  let sequence = 0;
  const controllers = new Set();

  const post = async (pathname, body, { timeoutMs = 60_000, signal } = {}) => {
    const base = await getBaseUrl();
    if (!base) throw Object.assign(new Error('影视引擎未就绪'), { code: 'engine-missing' });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    merged.addEventListener('abort', onAbort);
    controllers.add(controller);
    try {
      const response = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
      if (!response.ok || (payload && payload.code !== 0 && payload.code !== undefined)) {
        return { ok: false, error: normalizeError(payload, response.status), rpcId: body?.rpcId ?? null };
      }
      return { ok: true, data: payload?.data ?? payload ?? null };
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return { ok: false, error: { code: 'timeout', message: '站点响应超时', stage: 'timeout' }, rpcId: body?.rpcId ?? null };
      }
      return {
        ok: false,
        error: { code: 'transport', message: `无法连接影视引擎：${error?.message ?? error}` },
        rpcId: body?.rpcId ?? null,
      };
    } finally {
      merged.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  };

  const health = () => post('/health', null, { timeoutMs: 10_000 });

  // 载荷界面通道：spider 里的二维码 / 账号输入框都会走到这里（UiBridge → /ui/poll）。
  const get = async (pathname, { timeoutMs = 30_000 } = {}) => {
    const base = await getBaseUrl();
    if (!base) throw Object.assign(new Error('影视引擎未就绪'), { code: 'engine-missing' });
    try {
      const response = await fetch(`${base}${pathname}`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      try { return { ok: response.ok, data: text ? JSON.parse(text) : null }; } catch { return { ok: response.ok, data: { raw: text } }; }
    } catch (error) {
      return { ok: false, error: { code: 'transport', message: `无法连接影视引擎：${error?.message ?? error}` } };
    }
  };

  /** 长轮询弹窗事件。after 是上一次拿到的 seq（首次传 -1 取全量快照）。 */
  const uiPoll = ({ after = -1, waitMs = 20_000 } = {}) => get(
    `/ui/events?after=${Number(after)}&wait=${Math.max(0, Number(waitMs))}`,
    { timeoutMs: Math.max(0, Number(waitMs)) + 20_000 },
  );

  /** 回放用户操作：{ dialog, type: 'button'|'item'|'click'|'check'|'select'|'submit'|'cancel', which/index/view/checked/inputs } */
  const uiInput = (payload) => post('/ui/input', payload ?? {}, { timeoutMs: 30_000 });

  const load = ({ siteKey, api, ext, jar }) => post('/spider/load', {
    siteKey: siteKey ?? '',
    api: api ?? '',
    ext: ext ?? '',
    jar: jar ?? '',
  }, { timeoutMs: 120_000 });

  const cancel = (rpcId) => (rpcId ? post('/spider/cancel', { rpcId }, { timeoutMs: 10_000 }) : Promise.resolve({ ok: false }));

  const reset = () => post('/spider/reset', {}, { timeoutMs: 60_000 });

  /**
   * 调用一次 spider 方法。
   * @param {object} options
   * @param {{siteKey:string,api:string,ext:string,jar:string}} options.site
   * @param {string} options.method homeContent / categoryContent / detailContent / searchContent / playerContent / action / liveContent
   * @param {Record<string,string>} [options.params]
   */
  const call = async ({ site, method, params = {}, timeoutMs = 60_000 }) => {
    const rpcId = `${method}@${site.siteKey}#${++sequence}`;
    const controller = new AbortController();
    const body = {
      siteKey: site.siteKey ?? '',
      api: site.api ?? '',
      ext: site.ext ?? '',
      jar: site.jar ?? '',
      method,
      rpcId,
      timeoutMs: String(timeoutMs),
      ...params,
    };
    const result = await post('/spider/call', body, { timeoutMs, signal: controller.signal });
    if (!result.ok) {
      // 超时 / 主动取消时让引擎真正中断那次调用，避免 callPool 被占满。
      if (result.error?.code === 'timeout') await cancel(rpcId).catch(() => undefined);
      return { ...result, rpcId };
    }
    return { ...result, rpcId };
  };

  const abortAll = () => {
    for (const controller of controllers) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    controllers.clear();
  };

  return { health, load, call, cancel, reset, abortAll, stageMessage, uiPoll, uiInput };
};

module.exports = { createEngineClient, stageMessage, normalizeError };

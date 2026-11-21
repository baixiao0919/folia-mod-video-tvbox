// mods/video-tvbox/index.cjs
// main 入口（Node）：影视模组的主进程半边。
//
// 职责：
//   1. 客户端发来的 video.request（status / engineHome / enginePlay / uiPoll …）转给 lib/videoBridge.cjs；
//   2. 解析引擎的目录、安装（首次运行时按用户给的地址下载并解压）与生命周期；
//   3. 全屏：官方宿主没有「窗口全屏」的公开接口，模组在自己的 main 里直接操作 BrowserWindow；
//   4. 给客户端提供一个不回显在宿主里的配置存储（mods-data 下的 store.json）。
//
// 除 api 之外不依赖宿主内部实现，换官方版照样跑。

const fs = require('fs');
const path = require('path');

const createVideoBridge = require('./videoBridge.cjs').createVideoBridge;

/* ---------- 用 Node 取二进制（给 video.bytes 用） ---------- */

/** 取回文本/字节，跟随重定向，最大 12MB（配置图片本来都只有几十 KB）。 */
const httpGetBuffer = (url, headers = {}, redirects = 5) =>
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
      {
        headers: { 'User-Agent': 'okhttp/3.15', ...headers },
        timeout: 20_000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
          response.resume();
          httpGetBuffer(new URL(response.headers.location, parsed).toString(), headers, redirects - 1)
            .then(resolve, reject);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) {
            request.destroy(new Error('响应体超过 12MB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status,
            contentType: String(response.headers['content-type'] ?? 'application/octet-stream'),
            base64: buffer.toString('base64'),
          });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
  });

/* ---------- 一个 JSON 文件顶替 electron-store ---------- */

const createFileStore = (file) => {
  let cache = null;
  const read = () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      cache = {};
    }
    if (!cache || typeof cache !== 'object') cache = {};
    return cache;
  };
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
    } catch {
      /* 写不进去就维持内存态 */
    }
  };
  return {
    get: (key) => {
      const value = read()[key];
      return value === undefined ? undefined : value;
    },
    set: (key, value) => {
      read()[key] = value;
      write();
    },
    delete: (key) => {
      delete read()[key];
      write();
    },
  };
};

/* ---------- 引擎目录与安装 ---------- */

const ENGINE_FILES = ['companion-service.jar', path.join('runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')];

const engineReady = (dir) => Boolean(dir) && ENGINE_FILES.every((rel) => fs.existsSync(path.join(dir, rel)));

const downloadFile = async (url, target) => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return buffer.length;
};

const unzip = (zipFile, target) => new Promise((resolve, reject) => {
  fs.mkdirSync(target, { recursive: true });
  const { spawn } = require('child_process');
  const script = `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `Expand-Archive 退出码 ${code}`))));
});

/** 解压后引擎根可能在 zip 里多套了一层 folia-video-engine/，往下挖一层。 */
const flattenEngine = (root) => {
  if (engineReady(root)) return root;
  for (const name of ['folia-video-engine', '.engine', 'engine']) {
    const child = path.join(root, name);
    if (fs.existsSync(child) && engineReady(child)) {
      for (const entry of fs.readdirSync(child)) {
        fs.renameSync(path.join(child, entry), path.join(root, entry));
      }
      return root;
    }
  }
  return root;
};

/* ---------- activate ---------- */

module.exports = function activate(api) {
  const dataDir = api.storage.paths.data;           // <userData>/mods-data/video-tvbox/files
  const cacheDir = api.storage.paths.cache;         // <userData>/mods-cache/video-tvbox
  const store = createFileStore(path.join(dataDir, 'store.json'));

  const engineDirOf = () => {
    const custom = store.get('engine.dir');
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    return path.join(dataDir, 'engine');
  };

  const bridge = createVideoBridge({
    store,
    safeStorage: null,
    engineDir: engineDirOf(),
    dataDir: path.join(dataDir, 'engine-data'),
    isAppQuitting: () => false,
  });

  api.onDispose(() => { void bridge.stopEngine?.(); });

  /* ---------- 全屏（官方宿主没有公开接口，模组自己开） ---------- */

  const electron = require('electron');
  const appWindow = () => {
    const { BrowserWindow } = electron;
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    return windows.find((win) => win.isFocused()) ?? windows[0] ?? null;
  };
  const isFullscreen = () => Boolean(appWindow()?.isFullScreen());

  api.rpc.handle('window.toggleFullscreen', () => {
    const win = appWindow();
    if (!win) return false;
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });
  api.rpc.handle('window.isFullscreen', () => isFullscreen());

  /* ---------- folia-lx://stream：封面 / 字节流的带防盗链转发 ----------
   * 影视那套取图逻辑在桌面端一律拼 folia-lx://stream?url=…&h=<base64 headers>，
   * 官方宿主没注册这个协议，模组自己在 main 里注册一份，字节原样透传、带 CORS 头。
   */

  try {
    const { protocol, net } = electron;
    const handle = async (request) => {
      let target = '';
      let headers = {};
      try {
        const parsed = new URL(request.url);
        target = parsed.searchParams.get('url') ?? '';
        const encoded = parsed.searchParams.get('h');
        if (encoded) headers = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      } catch {
        return new Response('bad request', { status: 400 });
      }
      if (!/^https?:/i.test(target)) return new Response('bad target', { status: 400 });
      try {
        const upstream = await net.fetch(target, { headers, redirect: 'follow' });
        const body = Buffer.from(await upstream.arrayBuffer());
        const responseHeaders = {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
        };
        return new Response(body, { status: upstream.status, headers: responseHeaders });
      } catch (error) {
        return new Response(`upstream failed: ${error?.message ?? error}`, { status: 502 });
      }
    };
    protocol.handle('folia-lx', handle);
    api.onDispose(() => { try { protocol.unhandle('folia-lx'); } catch { /* 忽略 */ } });
  } catch (error) {
    api.log?.error?.(`[video-tvbox] folia-lx 协议注册失败：${error?.message ?? error}`);
  }

  /* ---------- 引擎安装 ---------- */

  api.rpc.handle('engine.ensure', async () => {
    const dir = engineDirOf();
    if (engineReady(dir)) return { ok: true, dir, installed: true };
    const url = String(store.get('engine.url') ?? '').trim();
    if (!url) {
      return {
        ok: false,
        code: 'engine-url-missing',
        message: '解析引擎还没安装：请在模组设置里填引擎压缩包的下载地址（或直接把已解压的引擎目录填进去）',
      };
    }
    try {
      api.log?.info?.(`[video-tvbox] 开始下载解析引擎：${url}`);
      const zip = path.join(cacheDir, 'engine-download.zip');
      const bytes = await downloadFile(url, zip);
      api.log?.info?.(`[video-tvbox] 下载完成 ${(bytes / 1048576).toFixed(1)} MB，解压中`);
      await unzip(zip, dir);
      flattenEngine(dir);
      if (!engineReady(dir)) throw new Error('解压后没找到 companion-service.jar 或 runtime/bin/java.exe');
      try { fs.unlinkSync(zip); } catch { /* 忽略 */ }
      api.log?.info?.(`[video-tvbox] 解析引擎就绪：${dir}`);
      return { ok: true, dir, installed: true };
    } catch (error) {
      return { ok: false, code: 'engine-install-failed', message: `引擎安装失败：${error?.message ?? error}` };
    }
  });

  api.rpc.handle('engine.dir', () => ({ dir: engineDirOf(), ready: engineReady(engineDirOf()) }));

  api.rpc.handle('engine.config', () => ({
    url: String(store.get('engine.url') ?? ''),
    dir: engineDirOf(),
    ready: engineReady(engineDirOf()),
  }));

  api.rpc.handle('engine.setUrl', ({ url, dir } = {}) => {
    if (typeof url === 'string') store.set('engine.url', url.trim());
    if (typeof dir === 'string') {
      if (dir.trim()) store.set('engine.dir', dir.trim());
      else store.delete('engine.dir');
    }
    return { ok: true, url: String(store.get('engine.url') ?? ''), dir: engineDirOf(), ready: engineReady(engineDirOf()) };
  });

  /* ---------- 影视请求 ---------- */

  /*
   * 原始字节通道：页面里的 `fetch('folia-lx://…')` 在官方构建上会被拦。
   * 原因不是协议没注册，而是自定义 scheme 想被 fetch() 用，必须在 app ready 之前
   * registerSchemesAsPrivileged 里声明 supportFetchAPI —— 那是宿主启动时的事，模组改不到。
   * 所以字节改走这条 rpc：main 用 Node 取回二进制，base64 带回页面自己拼 Blob。
   * （图片不需要这条：<img src="folia-lx://…"> 没这个限制。）
   */
  api.rpc.handle('video.bytes', async ({ url, headers } = {}) => {
    const target = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, message: '只支持 http(s) 地址' };
    try {
      const data = await httpGetBuffer(target, headers && typeof headers === 'object' ? headers : {});
      return { ok: true, status: data.status, contentType: data.contentType, base64: data.base64 };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  });

  api.rpc.handle('video.request', async (operation, params) => bridge.request(operation, params));
};



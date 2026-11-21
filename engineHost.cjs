// electron/video/engineHost.cjs
// 影视解析引擎（TVBox/CatVod 兼容层）进程宿主。
//
// 引擎本体来自修狗TV 的 android-bridge + companion（GPL-3.0），作为一个独立的
// java 子进程运行：它只提供 POST /spider/* 的 HTTP RPC，不提供任何 UI、不接触
// 渲染进程。Folia 只通过本文件把它拉起 / 探活 / 关掉。
//
// 关键约定（与引擎 Main.java 强绑定，改动会让桌面端连不上）：
//  - 启动后 stdout 打印一行 `[COMPANION_READY] PORT=<n>`，端口由系统分配（--port=0）
//  - `--stdin-watch=on` 时父进程消失 → stdin EOF → 引擎自杀；
//  - `--parent-pid=<pid>` 是第二道保险（PATH 上的 java 可能是包装器，EOF 不可靠）
//  - `-Duser.home=<dir>` 把引擎的持久目录（配置缓存 / 网盘授权 / jar 缓存）搬进
//    Folia 的 userData，避免污染 ~/.xiugou_tv_companion
//
// 进程生命周期：首次需要解析时启动；异常退出最多重启 3 次（指数退避）；
// 应用退出前统一 stop()。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const READY_PATTERN = /\[COMPANION_READY\] PORT=(\d+)/;
const START_TIMEOUT_MS = 45_000;
const MAX_RESTARTS = 3;
const HEALTH_INTERVAL_MS = 20_000;

const log = (...args) => console.log('[VideoEngine]', ...args);
const warn = (...args) => console.warn('[VideoEngine]', ...args);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 引擎宿主。
 *
 * @param {object} options
 * @param {string} options.engineDir     引擎目录（含 companion-service.jar 与 runtime/jre）
 * @param {string} options.dataDir       引擎持久目录（会作为 -Duser.home 传入）
 * @param {() => boolean} [options.isAppQuitting] 应用是否正在退出（退出时不再重启）
 */
const createEngineHost = ({ engineDir, dataDir, isAppQuitting = () => false }) => {
  /** @type {import('child_process').ChildProcess | null} */
  let child = null;
  let port = null;
  let starting = null;
  let restarts = 0;
  let intentionalStop = false;
  let healthTimer = null;
  let lastLogLines = [];

  const jarPath = () => path.join(engineDir, 'companion-service.jar');
  const javaPath = () => {
    // 分发包自带精简 JRE；开发机可以放一个 runtime/jre 或退回系统 java。
    const bundled = path.join(engineDir, 'runtime', 'bin', 'java.exe');
    if (fs.existsSync(bundled)) return bundled;
    return process.platform === 'win32' ? 'java.exe' : 'java';
  };

  const isAvailable = () => fs.existsSync(jarPath()) && fs.existsSync(path.dirname(javaPath()));

  /**
   * 网盘站（玩偶/夸父这类）真正能不能播，取决于引擎里的网盘授权（夸克/UC 的 cookie，
   * 存在 <home>/.xiugou_tv_companion/prefs/spUtils.json）。我们把引擎的 user.home 挪到了
   * Folia 自己的数据目录，就接不上原来那份授权 —— 换个目录玩偶就只能进详情、点播报空。
   * 所以启动前把旧目录里已知的授权项并进来（只做补齐，不覆盖已有值）。
   */
  const importLegacyNetdiskAuth = () => {
    try {
      const legacyFile = path.join(os.homedir(), '.xiugou_tv_companion', 'prefs', 'spUtils.json');
      const targetFile = path.join(dataDir, '.xiugou_tv_companion', 'prefs', 'spUtils.json');
      if (!fs.existsSync(legacyFile)) return;
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      const legacy = fs.readFileSync(legacyFile, 'utf8').split(/\r?\n/).filter(Boolean);
      const existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
      const keyOf = (line) => {
        const encoded = line.split('\t')[3] || '';
        try { return Buffer.from(encoded, 'base64').toString('utf8'); } catch { return ''; }
      };
      const keys = new Set(existing.map(keyOf).filter(Boolean));
      const merged = existing.slice();
      let added = 0;
      for (const line of legacy) {
        const plain = keyOf(line);
        if (!plain) continue;
        // 网盘授权：夸克/UC 的 cookie、登录态，以及站点当前用的域名（站群会轮换）。
        const wanted = /^(quark_ck|quarkSt|uc_ck|ucSt|wogg_site|lastQuark)/.test(plain);
        if (!wanted) continue;
        if (keys.has(plain)) continue;
        merged.push(line);
        keys.add(plain);
        added += 1;
      }
      // 一边是空的授权（只有站点域名、没有 cookie），另一边的 wogg_site 又是另一套站群时，
      // 沿用它自己的域名会让网盘接口全部对不上 —— 这种情况把域名一并换成能用的那个。
      if (!keys.has('quark_ck') && !existing.some((line) => keyOf(line) === 'quark_ck')) {
        const ownLine = merged.findIndex((line) => keyOf(line) === 'wogg_site');
        const legacySite = legacy.find((line) => keyOf(line) === 'wogg_site');
        if (legacySite) {
          if (ownLine >= 0) merged.splice(ownLine, 1);
          merged.push(legacySite);
          added += 1;
        }
      }
      if (added > 0) {
        fs.writeFileSync(targetFile, merged.join('\n'), 'utf8');
        log(`已并入 ${added} 项网盘授权（来自原有引擎目录）`);
      }
    } catch (error) {
      warn('网盘授权导入失败:', error instanceof Error ? error.message : String(error));
    }
  };

  const baseUrl = () => (port ? `http://127.0.0.1:${port}` : null);

  const pushLog = (line) => {
    lastLogLines.push(line);
    if (lastLogLines.length > 200) lastLogLines.shift();
  };

  const clearHealthTimer = () => {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  };

  const startHealthTimer = () => {
    clearHealthTimer();
    healthTimer = setInterval(async () => {
      try {
        const response = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`health ${response.status}`);
      } catch (error) {
        warn('健康检查失败，准备重启:', error instanceof Error ? error.message : String(error));
        clearHealthTimer();
        if (child && !child.killed) child.kill();
        else port = null;
      }
    }, HEALTH_INTERVAL_MS);
    healthTimer.unref?.();
  };

  const spawnOnce = () => new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(Object.assign(new Error('影视解析引擎未安装'), { code: 'engine-missing' }));
      return;
    }
    fs.mkdirSync(dataDir, { recursive: true });
    importLegacyNetdiskAuth();
    intentionalStop = false;
    const args = [
      `-Duser.home=${dataDir}`,
      `-Dfile.encoding=UTF-8`,
      // Java 18+ 的 System.out/err 编码独立于 file.encoding：不显式指定时 Windows 下会按 GBK 输出，
      // 我们按 UTF-8 解码就全是乱码。
      `-Dstdout.encoding=UTF-8`,
      `-Dstderr.encoding=UTF-8`,
      '-jar', jarPath(),
      '--port=0',
      `--stdin-watch=on`,
    ];
    if (process.pid) args.push(`--parent-pid=${process.pid}`);
    log('启动引擎:', javaPath(), args.join(' '));
    const proc = spawn(javaPath(), args, {
      cwd: engineDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    const failStart = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      reject(error);
    };
    const timer = setTimeout(() => {
      failStart(Object.assign(new Error('引擎启动超时（45s）'), { code: 'engine-timeout' }));
    }, START_TIMEOUT_MS);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      for (const rawLine of String(chunk).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        pushLog(line);
        const ready = READY_PATTERN.exec(line);
        if (ready) {
          port = Number(ready[1]);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            startHealthTimer();
            log('引擎就绪，端口', port);
            resolve(port);
          }
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const rawLine of String(chunk).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line) {
          pushLog(line);
          warn(line);
        }
      }
    });

    proc.on('exit', (code, signal) => {
      const wasCurrent = child === proc;
      if (wasCurrent) {
        child = null;
        port = null;
        clearHealthTimer();
      }
      if (settled === false) {
        failStart(Object.assign(new Error(`引擎启动即退出（code=${code} signal=${signal}）`), { code: 'engine-exit' }));
      }
      if (wasCurrent && !intentionalStop && !isAppQuitting()) {
        restarts += 1;
        if (restarts > MAX_RESTARTS) {
          warn(`引擎连续异常退出 ${restarts} 次，停止自动重启`);
          return;
        }
        const delay = 500 * restarts;
        warn(`引擎退出（code=${code}），${delay}ms 后重启第 ${restarts} 次`);
        setTimeout(() => { ensureStarted().catch((error) => warn('重启失败:', error.message)); }, delay).unref?.();
      }
    });

    proc.on('error', (error) => {
      failStart(Object.assign(new Error(`无法启动引擎：${error.message}`), { code: 'engine-spawn' }));
    });

    child = proc;
  });

  /** 确保引擎在跑，返回端口。并发调用共享同一次启动。 */
  const ensureStarted = async () => {
    if (port && child && !child.killed) return port;
    if (starting) return starting;
    starting = spawnOnce()
      .then((value) => {
        restarts = 0;
        return value;
      })
      .finally(() => { starting = null; });
    return starting;
  };

  /** 停掉引擎（不触发自动重启）。 */
  const stop = async ({ graceful = true } = {}) => {
    intentionalStop = true;
    clearHealthTimer();
    const proc = child;
    const stopPort = port;
    child = null;
    port = null;
    if (!proc) return;
    if (graceful && stopPort) {
      try {
        await fetch(`http://127.0.0.1:${stopPort}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2_000) });
      } catch { /* 引擎已自行退出 */ }
    }
    try { proc.stdin?.end(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(50);
  };

  const getStatus = () => ({
    available: isAvailable(),
    running: Boolean(port && child && !child.killed),
    port,
    restarts,
    engineDir,
    dataDir,
    recentLog: lastLogLines.slice(-40),
  });

  return {
    ensureStarted,
    stop,
    getStatus,
    baseUrl,
    getRecentLog: () => lastLogLines.slice(-80),
  };
};

module.exports = { createEngineHost, READY_PATTERN };

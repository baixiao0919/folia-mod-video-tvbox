// dev/mod-build/videoEntry.tsx
// 影视模组的界面入口：在模组容器里挂载原有的影视页（VideoWorkspace + 播放器），
// 只把宿主那几处私有能力换成 folium 的公开接口（window.electron 的 shim）。
//
// 这个文件由 dev/mod-build/vite.video.mjs 预打包成 mods/video-tvbox/app.mjs。

import React from 'react';
import { createRoot } from 'react-dom/client';
import styles from './generated/videoStyles.mjs';

import { VideoWorkspace } from '../../src/components/app/video/VideoWorkspace';
import { EngineUiOverlay } from '../../src/components/app/video/EngineUiOverlay';
import { useVideoWorkspaceStore } from '../../src/stores/useVideoWorkspaceStore';
import { useVideoSettingsStore } from '../../src/stores/useVideoSettingsStore';

type Folium = any;

const installShim = (folium: Folium) => {
    // 字节通道：页面里 fetch('folia-lx://stream?…') 在官方构建上会被拦（自定义 scheme 想被 fetch 用，
    // 必须在宿主启动前 registerSchemesAsPrivileged，模组改不到）。这里把它转成 rpc 取字节再拼 Blob；
    // 普通 http(s) 请求原样交给浏览器。
    const realFetch = window.fetch.bind(window);
    (window as any).fetch = async (input: any, init?: any) => {
        const url: string = typeof input === 'string' ? input : (input && input.url) || '';
        if (!url.startsWith('folia-lx://')) return realFetch(input, init);
        let target = '';
        let headers: Record<string, string> = {};
        try {
            const parsed = new URL(url);
            target = parsed.searchParams.get('url') ?? '';
            const encoded = parsed.searchParams.get('h');
            if (encoded) headers = JSON.parse(atob(decodeURIComponent(encoded)));
        } catch {
            /* 地址不合法：走下面的失败分支 */
        }
        const result = await folium.rpc.call('video.bytes', { url: target, headers });
        if (!result?.ok) throw new TypeError('Failed to fetch');
        const binary = atob(result.base64 ?? '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new Response(bytes, {
            status: result.status || 200,
            headers: { 'content-type': result.contentType ?? 'application/octet-stream' },
        });
    };

    // 宿主把 window.electron 用 contextBridge 定义成只读，改不了；所以打包时把 `window.electron`
    // 这个表达式整体替换成下面这个全局对象（见 vite.video.mjs 的 define）。
    (window as any).__TVBOX_BRIDGE__ = {
        // 影视服务层用的两条通道
        videoRequest: (operation: string, params: any) => folium.rpc.call('video.request', operation, params ?? {}),
        lxFetch: async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
            try {
                const response = await folium.net.fetch(url, {
                    method: (init?.method ?? 'GET') as any,
                    headers: init?.headers,
                    timeoutMs: 15000,
                });
                return { ok: response.ok, status: response.status, bodyText: response.text() };
            } catch (error: any) {
                return { ok: false, status: 0, bodyText: '', error: String(error?.message ?? error) };
            }
        },
        // 播放器全屏：官方宿主没有公开接口，模组 main 里自己开
        toggleFullscreenWindow: () => folium.rpc.call('window.toggleFullscreen'),
        isWindowFullscreen: () => folium.rpc.call('window.isFullscreen'),
        onWindowFullscreenChanged: () => () => { /* 页面里靠轮询同步 */ },
    };
};

/** 默认站点配置地址，与融合版一致（src/stores/useVideoSettingsStore.ts 的 DEFAULT_VIDEO_SOURCE）。 */
const DEFAULT_VIDEO_SOURCE = 'http://www.饭太硬.cc/tv';

/**
 * 融合版一打开就有站点，是因为配置存在宿主自己的 store 里；模组是独立数据目录，
 * 这里必须自己把默认配置导进来，否则页面只有一条搜索框。
 * 多仓配置（kind=depot）一路选第一个仓，直到拿到真正的站点表。
 */
const ensureVideoConfig = async (folium: Folium, url: string) => {
    const status = await folium.rpc.call('video.request', 'status', {});
    if (status?.data?.configured) return { ok: true, configured: true } as const;

    let response = await folium.rpc.call('video.request', 'importConfig', { url });
    let guard = 0;
    while (response?.ok && response.data?.kind === 'depot' && guard < 6) {
        guard += 1;
        response = await folium.rpc.call('video.request', 'selectDepot', {
            entries: response.data.entries,
            index: 0,
            sourceUrl: response.data.sourceUrl,
        });
    }
    return response;
};

/** 站点配置条：地址 + 应用。没配置时自动填默认值并导入。 */
const SourceBar: React.FC<{ folium: Folium; onReady: () => void; compact: boolean }> = ({ folium, onReady, compact }) => {
    const [draft, setDraft] = React.useState(DEFAULT_VIDEO_SOURCE);
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState('');
    const [panelOpen, setPanelOpen] = React.useState(false);

    React.useEffect(() => {
        void (async () => {
            setBusy(true);
            setMessage('正在载入默认站点源…');
            try {
                const result = await ensureVideoConfig(folium, DEFAULT_VIDEO_SOURCE);
                if (result?.ok) {
                    setMessage('');
                    onReady();
                } else {
                    setMessage(`载入失败：${result?.error?.message ?? '未知错误'}`);
                }
            } finally {
                setBusy(false);
            }
        })();
    }, [folium, onReady]);

    const apply = async () => {
        setBusy(true);
        setMessage('正在解析站点配置…');
        try {
            const result = await ensureVideoConfig(folium, draft.trim());
            if (result?.ok) {
                // 成功后不再在顶部留一条提示，直接回到右下角胶囊形态，避免重载瞬间闪一条全宽栏
                setMessage('');
                setPanelOpen(false);
                onReady();
            } else {
                setMessage(`导入失败：${result?.error?.message ?? '未知错误'}`);
            }
        } finally {
            setBusy(false);
        }
    };

    if (compact && !message) {
        // 站点源是低频操作，不常驻。入口放在页面右上角、紧挨影视自己的「筛选」按钮左侧，
        // 收起时只有一个淡色胶囊；点开才向下展开编辑面板。这样既不占顶部一条，
        // 也不会被宿主顶栏 hover 状态栏或底部播放胶囊压住。
        return (
            <div className="pointer-events-none absolute right-28 top-[42px] z-50 flex flex-col items-end gap-2">
                <button
                    type="button"
                    className="pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-black/45 px-3 text-[11.5px] text-white/55 backdrop-blur transition hover:border-white/25 hover:text-white/85"
                    onClick={() => setPanelOpen((value) => !value)}
                    title="站点源：点开可更换"
                >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <ellipse cx="12" cy="5" rx="8" ry="3" />
                        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
                        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
                    </svg>
                    <span>站点源</span>
                </button>
                {panelOpen ? (
                    <div className="pointer-events-auto w-[420px] rounded-lg border border-white/12 bg-[#15151d]/95 p-2.5 shadow-[0_12px_32px_rgba(0,0,0,.45)] backdrop-blur">
                        <div className="mb-1.5 flex items-center justify-between text-[11px] text-white/45">
                            <span>站点源 / 换源</span>
                            <button
                                type="button"
                                className="rounded px-1.5 py-0.5 hover:bg-white/10"
                                onClick={() => setPanelOpen(false)}
                            >收起</button>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                className="min-w-0 flex-1 rounded border border-white/12 bg-black/40 px-2 py-1 text-[12px] text-white/85 outline-none"
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                            />
                            <button
                                type="button"
                                className="shrink-0 rounded border border-white/12 bg-white/[0.08] px-2.5 py-1 text-[12px] text-white/85 hover:bg-white/[0.14] disabled:opacity-50"
                                onClick={() => void apply()}
                                disabled={busy}
                            >{busy ? '导入中…' : '应用'}</button>
                        </div>
                        {message ? <div className="mt-1.5 text-[11px] text-white/55">{message}</div> : null}
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white/70">
            <span className="shrink-0">{busy ? '站点源' : '站点源'}</span>
            <input
                className="min-w-[220px] flex-1 rounded border border-white/12 bg-black/40 px-2 py-1 text-white/85 outline-none"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy}
            />
            <button
                type="button"
                className="shrink-0 rounded border border-white/12 bg-white/[0.08] px-3 py-1 text-white/85 hover:bg-white/[0.14] disabled:opacity-50"
                onClick={() => void apply()}
                disabled={busy}
            >{busy ? '导入中…' : '应用'}</button>
            {message ? <span className="w-full text-white/55">{message}</span> : null}
        </div>
    );
};

const EngineBar: React.FC<{ folium: Folium }> = ({ folium }) => {
    const [state, setState] = React.useState<{ ready: boolean; url: string; dir: string } | null>(null);
    const [draft, setDraft] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState('');

    const refresh = React.useCallback(async () => {
        const config = await folium.rpc.call('engine.config');
        setState(config);
        setDraft((prev) => prev || config?.url || '');
    }, [folium]);

    React.useEffect(() => { void refresh(); }, [refresh]);
    if (!state || state.ready) return null;

    const install = async () => {
        setBusy(true);
        setMessage('正在下载并解压解析引擎（约 132MB，请稍等）…');
        try {
            await folium.rpc.call('engine.setUrl', { url: draft });
            const result = await folium.rpc.call('engine.ensure');
            if (result?.ok) {
                setMessage('解析引擎就绪，刷新页面即可加载全部站点');
                await refresh();
            } else {
                setMessage(result?.message ?? '安装失败');
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] text-white/70">
            <span className="shrink-0">解析引擎未安装</span>
            <input
                className="min-w-[220px] flex-1 rounded-md border border-white/12 bg-black/40 px-2 py-1 text-white/85 outline-none placeholder:text-white/35"
                placeholder="引擎压缩包直链（.zip），例如 https://…/folia-video-engine.zip"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy}
            />
            <button
                type="button"
                className="shrink-0 rounded-md border border-white/12 bg-white/[0.08] px-3 py-1 text-white/85 transition hover:bg-white/[0.14] disabled:opacity-50"
                onClick={() => void install()}
                disabled={busy || !draft.trim()}
            >
                {busy ? '安装中…' : '安装引擎'}
            </button>
            {message ? <span className="w-full text-white/55">{message}</span> : null}
        </div>
    );
};

const SKIN: Record<string, string> = {
    '--st-t1': '#f2f2f4',
    '--st-t2': 'rgba(242, 242, 244, 0.68)',
    '--st-t3': 'rgba(242, 242, 244, 0.45)',
    '--st-line': 'rgba(255, 255, 255, 0.08)',
    '--st-line2': 'rgba(255, 255, 255, 0.2)',
    '--st-fill': 'rgba(255, 255, 255, 0.07)',
    '--st-fill2': 'rgba(255, 255, 255, 0.14)',
    '--st-accent': '#6f5bf0',
    '--st-on-accent': '#ffffff',
    '--st-warn': '#e3a949',
    '--st-err': '#ef6f6f',
    '--st-ok': '#56c98d',
    '--st-bg': '#0a0a0c',
};

/**
 * 给工作台挑一个能出内容的起始站点。
 * 融合版会记住用户在宿主页面上选过的站点（localStorage 里的 folia.video.preferredSite），
 * 模组页是另一个数据域，读不到；默认落到 sites[0]（「点我切源」这种空壳）就一片空白。
 * 这里在首帧之前把首选站点写好：优先「玩偶」，其次第一个能搜的，最后才退回第一个。
 */
const primePreferredSite = async (folium: Folium) => {
    try {
        const response = await folium.rpc.call('video.request', 'sites', {});
        const sites = (response?.data?.sites ?? []) as Array<{ siteKey: string; name: string; searchable?: boolean }>;
        if (!sites.length) return;
        const saved = window.localStorage.getItem('folia.video.preferredSite') || '';
        if (saved && sites.some((site) => site.siteKey === saved)) return;
        const pick = sites.find((site) => /玩偶/.test(site.name))
            ?? sites.find((site) => site.searchable)
            ?? sites[0];
        if (pick?.siteKey) window.localStorage.setItem('folia.video.preferredSite', pick.siteKey);
    } catch {
        /* 挑不到就交给工作台自己的默认逻辑 */
    }
};

const WorkspaceApp: React.FC<{ folium: Folium }> = ({ folium }) => {
    const open = useVideoWorkspaceStore((state) => state.open);
    const setOpen = useVideoWorkspaceStore((state) => state.setOpen);
    const [ready, setReady] = React.useState(false);
    const [reloadKey, setReloadKey] = React.useState(0);

    React.useEffect(() => {
        setOpen(true);
        const unsubscribe = useVideoWorkspaceStore.subscribe((state) => {
            // 页面里的关闭按钮 → 让宿主退回首页
            if (!state.open) folium.ui.back?.();
        });
        return () => unsubscribe();
    }, [folium, setOpen]);

    const onConfigReady = React.useCallback(() => {
        void primePreferredSite(folium).then(() => {
            setReady(true);
            setReloadKey((value) => value + 1);
        });
    }, [folium]);

    return (
        <div
            className="absolute inset-0 flex min-h-0 select-none flex-col overflow-hidden text-[color:var(--st-t1)]"
            style={{ ...(SKIN as React.CSSProperties), backgroundColor: '#08080b' }}
        >
            <EngineBar folium={folium} />
            {/* 融合版一打开就有站点；模组的数据目录是独立的，这条负责把默认配置导进来 + 换源 */}
            <SourceBar folium={folium} onReady={onConfigReady} compact={ready} />
            <div className="min-h-0 flex-1 overflow-hidden" key={reloadKey}>
                {open && ready
                    ? <VideoWorkspace />
                    : <div className="flex h-full items-center justify-center text-[13px] text-white/45">正在载入站点…</div>}
            </div>
            <EngineUiOverlay />
        </div>
    );
};

/** 宿主调用：把影视页挂进模组容器，返回卸载函数。 */
export async function mount(container: HTMLElement, folium: Folium) {
    installShim(folium);

    // 宿主的底部播放胶囊是一层 z-60 的浮层，而本模组页被包在 z-10 的祖先里，
    // 层级怎么调都盖不过它，播放视频时胶囊会直接压在画面上（遮住进度条和时间）。
    // 这里在模组页打开期间把这个胶囊容器沉到 z-9：它仍在 DOM 里，只是排在本页之下，
    // 离开影视页时原样恢复。只改宿主那一个元素的内联样式，不动全局样式。
    let dockEl: HTMLElement | null = null;
    let dockPrevZIndex = '';
    const sinkDock = () => {
        if (!dockEl || !dockEl.isConnected) {
            const found = [...document.querySelectorAll('div')].find((node) => (
                String(node.className).includes('z-60')
                && String(node.className).includes('-translate-x-1/2')
                && getComputedStyle(node).position === 'absolute'
            )) as HTMLElement | undefined;
            if (found && found !== dockEl) {
                dockEl = found;
                dockPrevZIndex = found.style.zIndex;
            }
        }
        if (dockEl) dockEl.style.zIndex = '9';
    };
    sinkDock();
    const dockTimer = window.setInterval(sinkDock, 1000);

    // 样式优先走构造式样式表挂到 ShadowRoot 上，比往 <style> 里塞 30 万字符稳
    const shadow = container.getRootNode();
    let sheet: CSSStyleSheet | null = null;
    if (shadow instanceof ShadowRoot && 'adoptedStyleSheets' in shadow) {
        try {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(styles);
            shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
        } catch {
            sheet = null;
        }
    }

    const style = document.createElement('style');
    style.dataset.videoTvbox = '1';
    style.dataset.cssSize = String(styles.length);
    style.textContent = styles;
    container.appendChild(style);

    const root = document.createElement('div');
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    root.className = 'dark';
    container.appendChild(root);

    // 宿主给的 --folium-* 主题变量对齐到页面自己用的 --st-*
    const reactRoot = createRoot(root);
    reactRoot.render(<WorkspaceApp folium={folium} />);

    return () => {
        reactRoot.unmount();
        root.remove();
        style.remove();
        window.clearInterval(dockTimer);
        if (dockEl) dockEl.style.zIndex = dockPrevZIndex;
        if (sheet && shadow instanceof ShadowRoot) {
            shadow.adoptedStyleSheets = shadow.adoptedStyleSheets.filter((item) => item !== sheet);
        }
    };
}

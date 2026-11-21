// mods/video-tvbox/client.mjs
// client 入口（渲染端）：只做两件事 —— 把「影视」作为首页整页登记进宿主，把页面交给 app.mjs（预打包好的 React）。
//
// 一切宿主能力都从 folium 取；不读宿主的内部模块，换官方版照样装。

/** @typedef {import('../folium').FoliumClientApi} Folium */

/**
 * @param {Folium} folium
 */
export default function activate(folium) {
  const tabs = folium.registries.homeTabs;

  const handle = tabs.register({
    id: 'tvbox',
    label: { 'zh-CN': '影视', en: 'Video' },
    order: 240,
    async mount(container, ctx) {
      const app = await import('./app.mjs');           // 预打包：React + 影视页 + 全部样式
      return app.mount(container, folium, ctx);
    },
  });

  const command = folium.registries.commands.register({
    id: 'open-video',
    label: { 'zh-CN': '打开影视', en: 'Open video' },
    description: { 'zh-CN': '切到首页并打开影视页', en: 'Open the video page' },
    keywords: ['tvbox', '影视', 'video'],
    run() {
      folium.ui.openHomeTab('tvbox');
      return { message: '影视页已打开' };
    },
  });

  return () => {
    command.dispose?.();
    handle.dispose?.();
  };
}

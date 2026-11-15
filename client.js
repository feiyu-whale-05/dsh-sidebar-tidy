/**
 * dsh-sidebar-tidy — 左侧栏精简 + 内嵌式「更多」下拉。
 *
 * A. 侧栏只留白名单面板（KEEP），其余用框架自带的 pin 机制收起来；
 * B. 接管侧栏「更多」按钮，换成**贴着侧栏展开**的下拉：
 *    - 展开的列表是侧栏面板列表的一部分（插在「更多」那行下面），不是浮层，
 *      所以它下面的工作区/会话列表会被自然挤下去；
 *    - 样式完全跟随侧栏（透明背景、同字号、同 hover 底色），不另起配色；
 *    - 每行图标在左；按住行体上下拖动即可排序，松手把顺序写回
 *      sidebar.panellist 的 order（侧栏本身同步重排）并存 localStorage。
 *    - 侧栏收起成 rail 时空间不够，退回贴着侧栏右侧的浮层。
 * C. 兜底：若拦截失败，框架原生「更多」菜单里仍会列出收起的面板。
 *
 * 视觉：所有出场元素都用 ui-theme 的主题 token 上色（label / bg-layer / tooltip），
 * 深色模式下不再出现「白底白字」的拖拽气泡；而「更多」行与拖拽预览里的图标
 * 直接复用面板自己注册的图标组件（sidebar.panellist 的 occupant），
 * 不再靠 id 猜——第三方插件面板也不会显示成一个小圆点。
 *
 * 诊断：客户端把关键事件（激活、tidy、打开/关闭「更多」、拖拽、图标降级、
 * 日志传输失败）通过官方 Connection RPC 发给 Host 半侧，落盘到
 *   D:\DSH-plugins\log\dsh-sidebar-tidy\dsh-sidebar-tidy-YYYY-MM-DD.log
 * 日志永远不能影响主流程：队列、长度上限、失败降级都在 log() 内部兜住。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-tidy',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ── 日志：客户端 → Host（Connection RPC）────────────────────────────
    // 不走自定义 HTTP 路由，也不在页面里注入 token：DSH 的 connection.rpc
    // 已经带 Host/Origin 校验和浏览器 Cookie 鉴权。
    const PLUGIN_VERSION = '0.2.2-rc.3'
    // 共享 Connection 通道（`/api`）上的 exact route；Host 用
    // connection.fetch.register 注册，客户端用 connection.rpc.call 发信封。
    // 不用 rpc.handle：当前 DSH 版本里它会在注册 webServer 路由时抛
    // `cannot get property "webServer" without inject`。
    const LOG_CHANNEL = '/api'
    const LOG_ENDPOINT = 'dsh-sidebar-tidy/log'
    // 融合自 WSL web 侧 dsh-mobile-layout 的移动抽屉布局：
    //   always = 任何宽度都启用（默认，复刻 WSL 插件行为）
    //   auto   = 仅在窄屏（<=1023px）启用
    //   off    = 关闭
    const MOBILE_MODE_KEY = 'dsh-sidebar-tidy:mobile-layout'
    const MOBILE_MODES = ['always', 'auto', 'off']
    const MOBILE_BREAKPOINT = '(max-width: 1023px)'
    const LOG_MAX_QUEUE = 200
    const LOG_BATCH = 100
    const LOG_FLUSH_DELAY_MS = 350
    const PAGE_ID = Math.random().toString(36).slice(2, 10)
    const loggedOnce = new Set()
    let logCtx = null
    let logQueue = []
    let logTimer = null
    let logFlushing = false
    let logFailures = 0
    let logRemoteDisabled = false
    let logDropped = 0
    let logWarningShown = false

    /** 控制台镜像；任何异常都不能冒泡。 */
    function mirrorToConsole(level, event, message, data) {
      try {
        const args = [`[dsh-sidebar-tidy] ${event}`, message]
        if (data !== undefined) args.push(data)
        const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
        target.apply(console, args)
      } catch {
        // 控制台不可用时忽略
      }
    }

    /** 把页面事实压成可安全落盘的小对象（不含 query/token）。 */
    function pageFacts() {
      try {
        const active = String(logCtx?.locale?.getSnapshot?.().active ?? '')
        return {
          id: PAGE_ID,
          path: String(window.location?.pathname ?? ''),
          locale: active.toLowerCase().startsWith('zh') ? 'zh' : active === '' ? 'unknown' : 'en',
          dark: document.body?.hasAttribute('data-ds-dark-theme') === true,
        }
      } catch {
        return { id: PAGE_ID }
      }
    }

    /** 发一批日志；失败时把记录放回队首，连续失败 3 次就关闭远程日志。 */
    async function flushLogs(reason) {
      if (logFlushing || logRemoteDisabled || logQueue.length === 0) return
      const connection = logCtx?.get?.('connection')
      if (connection === undefined || connection === null || typeof connection.rpc?.call !== 'function') {
        // connection 是核心服务，正常一定存在；留几次重试避免页面刚启动时的竞争。
        logFailures += 1
        if (logFailures >= 3) {
          if (!logWarningShown) {
            logWarningShown = true
            mirrorToConsole('warn', 'log.unavailable', 'connection.rpc 不可用，文件日志已关闭')
          }
          logRemoteDisabled = true
        } else if (logTimer === null) {
          logTimer = window.setTimeout(() => {
            logTimer = null
            void flushLogs('connection-wait')
          }, 800)
        }
        return
      }
      logFlushing = true
      const batch = logQueue.splice(0, LOG_BATCH)
      if (logDropped > 0) {
        batch.unshift({
          time: Date.now(),
          level: 'warn',
          event: 'log.dropped',
          message: '客户端日志队列溢出，丢弃了较早的记录',
          data: { dropped: logDropped },
        })
        logDropped = 0
      }
      try {
        const result = await connection.rpc.call(LOG_CHANNEL, LOG_ENDPOINT, { records: batch, page: pageFacts(), reason })
        if (result?.ok !== true) throw new Error(result?.error?.message ?? 'log rpc rejected')
        logFailures = 0
      } catch (error) {
        logFailures += 1
        const message = error instanceof Error ? error.message : String(error)
        if (logFailures >= 3) {
          if (!logWarningShown) {
            logWarningShown = true
            mirrorToConsole('warn', 'log.disabled', '文件日志连续失败，已关闭本页面远程日志', { error: message })
          }
          logRemoteDisabled = true
        } else {
          logQueue = batch.concat(logQueue).slice(-LOG_MAX_QUEUE)
        }
      } finally {
        logFlushing = false
        if (!logRemoteDisabled && logQueue.length > 0) scheduleLogFlush()
      }
    }

    function scheduleLogFlush() {
      if (logTimer !== null || logRemoteDisabled || logQueue.length === 0) return
      logTimer = window.setTimeout(() => {
        logTimer = null
        void flushLogs('timer')
      }, LOG_FLUSH_DELAY_MS)
    }

    /**
     * 记录一条客户端日志。
     * @param {'debug'|'info'|'warn'|'error'} level
     * @param {string} event - 稳定的事件名，例如 more.open
     * @param {string} message - 人类可读的一句话
     * @param {object} [data] - 结构化细节（会被 JSON 序列化）
     */
    function log(level, event, message, data) {
      try {
        mirrorToConsole(level, event, message, data)
        if (logRemoteDisabled) return
        if (logQueue.length >= LOG_MAX_QUEUE) {
          logQueue.shift()
          logDropped += 1
        }
        logQueue.push({ time: Date.now(), level, event, message, data })
        scheduleLogFlush()
      } catch {
        // 日志失败绝不能影响插件主流程
      }
    }

    /** 同一 key 只记录一次（用于降级/不可用这类会重复出现的告警）。 */
    function logOnce(level, key, event, message, data) {
      if (loggedOnce.has(key)) return
      loggedOnce.add(key)
      log(level, event, message, data)
    }

    /** 可选 Cordis 服务：拿不到就返回 null，不拖垮整个插件。 */
    function optionalService(name) {
      try {
        return logCtx?.get?.(name) ?? null
      } catch {
        return null
      }
    }

    /** 当前语言（失败按中文处理，与插件原有行为一致）。 */
    function isChinese(ctx) {
      try {
        return String(ctx.locale.getSnapshot().active).toLowerCase().startsWith('zh')
      } catch {
        return true
      }
    }
    /** 双语文本选择。 */
    function textFor(ctx, zh, en) {
      return isChinese(ctx) ? zh : en
    }

    // 侧栏保留的面板 id（其余收进「更多」）。默认值只用于首次运行；
    // 用户在界面上拖动后的自定义白名单/顺序会写入 localStorage，重载后恢复。
    const DEFAULT_KEEP = ['plugins', 'dsh-market', 'skill-explorer', 'schedules', 'dsh-security']
    const ORDER_KEY = 'dsh-sidebar-tidy:order'
    const KEEP_KEY = 'dsh-sidebar-tidy:keep'
    const PINNED_KEY = 'dsh-sidebar-tidy:pinned'

    /** 读 JSON 字符串数组；没有记录或损坏时返回 null。 */
    function readStringArray(key) {
      try {
        const raw = window.localStorage.getItem(key)
        const parsed = raw === null ? null : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : null
      } catch (error) {
        return null
      }
    }
    function writeStringArray(key, ids) {
      try {
        window.localStorage.setItem(key, JSON.stringify(ids))
      } catch (error) {
        // 隐私模式等场景下忽略
      }
    }
    /** 当前自定义白名单（可变）；首次运行用默认值。 */
    const KEEP = readStringArray(KEEP_KEY) ?? [...DEFAULT_KEEP]

    // ── 图标（16px 线性图标，跟随 currentColor）────────────────────────
    const ICONS = {
      plugins: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
      'dsh-market': '<path d="M4 9h16l-1.2 9.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 9Z"/><path d="M9 9V6.5a3 3 0 0 1 6 0V9"/>',
      schedules: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
      'dsh-security': '<path d="M12 3.5 19 6v6c0 4.2-3 7-7 8.5C8 19 5 16.2 5 12V6l7-2.5Z"/><path d="m9 12 2 2 4-4"/>',
      'skill-explorer': '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z"/>',
      pin: '<path d="M12 3.5v6"/><path d="M8.5 9.5h7l-1 4h-5l-1-4Z"/><path d="M12 13.5V20"/>',
      browse: '<path d="M4 9h16l-1.2 9.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 9Z"/><path d="M9 9V6.5a3 3 0 0 1 6 0V9"/>',
      create: '<path d="M12 5v14M5 12h14"/>',
      mobile: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
      menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
      fallback: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    }
    const icon = (name) => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.fallback) + '</svg>'

    // ── 面板自带图标 ───────────────────────────────────────────────────
    // sidebar.panellist 的每个 occupant 就是该面板的图标组件；直接把它渲染成
    // SVG 标记，「更多」行和拖拽预览就与侧栏里看到的图标完全一致。
    // react-dom 是平台的基线共享模块；万一取不到就退回上面手绘的图标。
    let reactDomModules
    function reactDom() {
      if (reactDomModules === undefined) {
        try {
          reactDomModules = { dom: require('react-dom'), client: require('react-dom/client') }
        } catch (error) {
          reactDomModules = null
        }
      }
      return reactDomModules
    }
    const iconMarkupByEntry = new WeakMap()
    let lastIconFailure = null
    /** 把某个面板注册的图标组件渲染成 SVG/HTML 标记并缓存；失败返回 null。 */
    function panelIconMarkup(row, size, ctx) {
      const entry = row?.entry
      const component = entry?.component
      const modules = reactDom()
      lastIconFailure = null
      if (typeof component !== 'function' || modules === null) return null
      let bySize = iconMarkupByEntry.get(entry)
      if (bySize === undefined) {
        bySize = new Map()
        iconMarkupByEntry.set(entry, bySize)
      }
      if (bySize.has(size)) return bySize.get(size)
      const props = { size, active: false }
      const namespace = entry?.options?.locale
      if (typeof namespace === 'string') {
        try {
          props.t = ctx.locale.bind(namespace)
        } catch (error) {
          // 没有 locale 服务时按无 t 渲染
        }
      }
      let markup = null
      const holder = document.createElement('div')
      let root = null
      try {
        root = modules.client.createRoot(holder)
        modules.dom.flushSync(() => {
          root.render(h(component, props))
        })
        markup = holder.innerHTML === '' ? null : holder.innerHTML
      } catch (error) {
        lastIconFailure = error instanceof Error ? error.message : String(error)
        markup = null
      } finally {
        try {
          root?.unmount()
        } catch (error) {
          // 组件抛错时卸载也可能抛，忽略
        }
      }
      bySize.set(size, markup)
      return markup
    }
    /** 行图标：优先面板注册的组件，退回 id → 内置图标 → 通用面板图标。 */
    function rowIconMarkup(row, ctx, size = 16) {
      const markup = panelIconMarkup(row, size, ctx)
      if (markup !== null) return markup
      if (lastIconFailure !== null) {
        logOnce('warn', `icon:${row?.id}`, 'icon.fallback', '面板图标组件渲染失败，改用内置图标', {
          id: row?.id,
          error: lastIconFailure,
        })
        lastIconFailure = null
      } else if (ICONS[row?.id] === undefined) {
        logOnce('debug', `icon-generic:${row?.id}`, 'icon.generic', '面板没有图标组件，使用通用面板图标', { id: row?.id })
      }
      return icon(row?.id)
    }

    // ── 纯逻辑（自测用）────────────────────────────────────────────────
    /** 按持久化顺序重排行；没记录的按 order/label 排在后面。 */
    function sortRows(rows, order) {
      const rank = new Map(order.map((id, index) => [id, index]))
      return [...rows].sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER
        const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER
        if (ra !== rb) return ra - rb
        if (a.order !== b.order) return a.order - b.order
        return String(a.label).localeCompare(String(b.label))
      })
    }
    /** 把 from 位置的行挪到 to 位置，返回新 id 顺序。 */
    function reorder(ids, from, to) {
      const next = [...ids]
      if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    }
    /** 把 id 插到 index 位置（已存在则先摘出来），返回新数组。 */
    function moveInto(ids, id, index) {
      const next = ids.filter((item) => item !== id)
      const at = Math.max(0, Math.min(index, next.length))
      next.splice(at, 0, id)
      return next
    }
    /** 读/写持久化顺序。 */
    function readOrder() {
      try {
        const raw = window.localStorage.getItem(ORDER_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
      } catch (error) {
        return []
      }
    }
    function writeOrder(ids) {
      try {
        window.localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
      } catch (error) {
        // 隐私模式等场景下忽略
      }
    }

    /** 侧栏固定面板的持久化顺序（与白名单一起恢复自定义状态）。 */
    function readPinnedOrder() {
      return readStringArray(PINNED_KEY)
    }
    function writePinnedOrder(ids) {
      writeStringArray(PINNED_KEY, ids)
    }
    /** 把当前自定义白名单写回 localStorage。 */
    function persistKeep() {
      writeStringArray(KEEP_KEY, [...KEEP])
    }

    /** 把不在白名单的面板取消 pin/钉回；返回下发的 setPinned 次数（便于自测）。 */
    function tidy(ctx) {
      const sidebar = ctx.slots.entriesOfSlot('sidebar').find((entry) => typeof entry?.inject === 'function')
      if (sidebar === undefined) return -1
      let props
      try {
        props = sidebar.inject()
      } catch (error) {
        return -1
      }
      const setPinned = props?.setPinned
      if (typeof setPinned !== 'function') return -1
      let calls = 0
      for (const entry of ctx.slots.entriesOfSlot('sidebar.panellist')) {
        const id = entry?.options?.id
        if (typeof id !== 'string' || id === 'plugins') continue
        try {
          setPinned(id, KEEP.includes(id))
          calls += 1
        } catch (error) {
          // 单个面板失败不影响其它
        }
      }
      return calls
    }

    /** 侧栏当前实际显示的固定面板 id（按 order 升序）。 */
    function pinnedSorted(ctx) {
      return [...panelRows(ctx)]
        .sort((a, b) => a.order - b.order)
        .filter((row) => row.id === 'plugins' || KEEP.includes(row.id))
        .map((row) => row.id)
    }

    /** 读 sidebar.panellist 的当前行（id / label / order / entry）。 */
    function panelRows(ctx) {
      const rows = []
      for (const entry of ctx.slots.entriesOfSlot('sidebar.panellist')) {
        const id = entry?.options?.id
        if (typeof id !== 'string') continue
        const rawLabel = entry.options.label
        let label = rawLabel
        try {
          if (typeof rawLabel === 'function') label = rawLabel()
        } catch (error) {
          label = id
        }
        rows.push({ id, label: typeof label === 'string' && label !== '' ? label : id, order: entry.options.order ?? 0, entry })
      }
      return rows
    }

    /** 把顺序写回各行的 order，并触发 sidebar 的 syncPanels（locale revision 抖动）。 */
    function applyOrder(ctx, ids) {
      const rows = panelRows(ctx)
      const byId = new Map(rows.map((row) => [row.id, row]))
      // 只重排「更多」里的这些面板，序号放到最后，避免影响侧栏里其它面板的顺序
      ids.forEach((id, index) => {
        const row = byId.get(id)
        if (row !== undefined) row.entry.options.order = 1000 + index
      })
      bumpSync(ctx)
    }

    /** 侧栏里的固定面板按给定顺序排号（隐藏面板保持 1000+ 不动）。
     *  persist=false 用于启动恢复阶段：只下发内存顺序，不回写存储，避免面板尚未注册时把持久化列表截短。 */
    function applyPinnedOrder(ctx, ids, persist = true) {
      const rows = panelRows(ctx)
      const byId = new Map(rows.map((row) => [row.id, row]))
      ids.forEach((id, index) => {
        const row = byId.get(id)
        if (row !== undefined) row.entry.options.order = index
      })
      if (persist === true) writePinnedOrder(ids)
      bumpSync(ctx)
    }

    /** 抖动一次 locale revision，让 sidebar 重算 panels（含顺序）。 */
    function bumpSync(ctx) {
      try {
        const off = ctx.locale.register('sidebar-tidy-bump', { zh: {}, en: {} })
        off()
      } catch (error) {
        // 触发失败最多是侧栏顺序晚一拍
      }
    }

    // ── 样式：跟随侧栏与主题 token，不写死明暗配色 ─────────────────────
    const CSS = `
      .st-list{display:flex;flex-direction:column;gap:2px;margin:0 0 2px;flex:none;
        color:var(--dsw-alias-label-primary,inherit)}
      .st-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:32px;
        margin:0 2px;padding:5px 8px;border-radius:var(--dsw-radius-md,8px);
        color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:20px;
        cursor:grab;user-select:none;-webkit-user-select:none;background:transparent;border:none;text-align:left}
      .st-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
      .st-row.st-dragging{cursor:grabbing;opacity:.75;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
      .st-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;color:inherit;opacity:.8}
      .st-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      nav.st-promoting{outline:1px dashed var(--dsw-alias-brand-primary,#7c6cff);outline-offset:-2px;border-radius:8px}
      /* 拖到侧栏上方的浮动提示：tooltip 是唯一在明暗两套主题下都是深底的语义色，
         不会像 brand-primary 那样在深色模式变成近白色（白底白字）。 */
      .st-hint{position:fixed;z-index:2147483001;pointer-events:none;padding:3px 9px;border-radius:999px;
        background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-alias-tooltip-label,#fff);
        border:1px solid rgba(255,255,255,.16);box-shadow:0 6px 18px rgba(0,0,0,.24);
        font-size:12px;line-height:18px;transform:translate(12px,-28px);white-space:nowrap}
      .st-ghost{position:fixed;z-index:2147483002;pointer-events:none;display:flex;align-items:center;gap:8px;
        max-width:220px;padding:5px 10px;border-radius:8px;font-size:13px;line-height:20px;
        color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-2,#2c2c2e);
        border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));box-shadow:0 8px 22px rgba(0,0,0,.28);
        opacity:.92;transform:translate(14px,12px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .st-list.st-drop-target{outline:1px dashed var(--dsw-alias-brand-primary,#7c6cff);outline-offset:-2px;border-radius:8px}
      .st-drop-line{height:2px;margin:0 2px;border-radius:1px;flex:none;
        background:var(--dsw-alias-brand-primary,#7c6cff)}
      .st-row.st-promote{opacity:.6;outline:1px dashed var(--dsw-alias-brand-primary,#7c6cff);outline-offset:-1px}
      .st-flyout{padding:4px;background:var(--dsw-alias-bg-layer-2,#2c2c2e);
        border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;
        box-shadow:0 12px 32px rgba(0,0,0,.28)}
      /* 「更多」按钮右侧的小箭头：收起时朝下，展开时朝上（2026-10-25） */
      nav button[aria-haspopup="menu"]{position:relative;padding-right:24px!important}
      nav button[aria-haspopup="menu"]::after{content:"";position:absolute;right:9px;top:50%;
        width:6px;height:6px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;
        opacity:.55;transform:translateY(-70%) rotate(45deg);transition:transform .16s ease;pointer-events:none}
      nav button[aria-haspopup="menu"].st-more-open::after{transform:translateY(-30%) rotate(225deg)}
    `

    function ensureStyle() {
      const existing = document.querySelector('style[data-plugin-css="dsh-sidebar-tidy"]')
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-sidebar-tidy'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function svgNode(markup) {
      const holder = document.createElement('span')
      holder.innerHTML = markup
      return holder.firstElementChild
    }

    /** 拖动时跟随指针的按钮预览（ghost）。 */
    function createGhost(ctx) {
      let node = null
      return {
        show(x, y, row) {
          if (node === null) {
            node = document.createElement('div')
            node.className = 'st-ghost'
            document.body.appendChild(node)
          }
          node.textContent = ''
          const glyph = document.createElement('span')
          glyph.className = 'st-ico'
          glyph.appendChild(svgNode(rowIconMarkup(row, ctx, 16)))
          node.appendChild(glyph)
          const text = document.createElement('span')
          text.className = 'st-label'
          text.textContent = row?.label ?? row?.id ?? ''
          node.appendChild(text)
          node.style.left = Math.round(x) + 'px'
          node.style.top = Math.round(y) + 'px'
        },
        hide() {
          if (node !== null) {
            node.remove()
            node = null
          }
        },
      }
    }

    // ── 移动抽屉布局（融合 WSL web 侧 dsh-mobile-layout）──────────────
    // 原插件是「任何宽度都强制移动布局」的 Web 侧 overlay，基于 DSH 0.1.2 的
    // 锚点与文案；这里把它适配到 0.2.2-rc.3 并改成三档：
    //   auto（默认）= 只在 <=1023px 时启用，桌面完全不变
    //   always      = 任意宽度都启用（原插件行为）
    //   off         = 关闭
    // 锚点全部改用 0.2.2-rc.3 的稳定属性（data-shell-overlay / data-sidebar-
    // toggle / data-sidebar-opener / data-sidebar-right-* / data-composer-card），
    // 不再依赖 CSS Module 哈希类名和 0.1.2 的中文文案。
    const MOBILE_CSS = `
      html.st-ml-on, html.st-ml-on body { height: 100dvh; }
      html.st-ml-on body {
        box-sizing: border-box; overscroll-behavior-y: none;
        padding-top: env(safe-area-inset-top, 0px);
        padding-right: env(safe-area-inset-right, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
        padding-left: env(safe-area-inset-left, 0px);
      }
      .st-ml-frame { grid-template-columns: 0px minmax(0, 1fr) var(--st-ml-rightbar, 0px) !important; }
      .st-ml-frame [data-sidebar-mask] { display: none !important; }
      .st-ml-frame [data-side='sidebar'], .st-ml-frame [data-side='details'] { display: none !important; }
      .st-ml-frame > .st-ml-col-1, .st-ml-frame > [class*='sidebarCol'] { grid-column: 1 !important; }
      .st-ml-frame > .st-ml-col-2, .st-ml-frame > [class*='centerCol'] { grid-column: 2 !important; }
      .st-ml-frame > .st-ml-col-3, .st-ml-frame > [class*='rightbarCol'] { grid-column: 3 !important; }
      .st-ml-frame:not(.st-ml-open) > .st-ml-col-1,
      .st-ml-frame:not(.st-ml-open) > [class*='sidebarCol'] {
        margin: 0 !important; padding: 0 !important; border: 0 !important;
        background: none !important; box-shadow: none !important; border-radius: 0 !important;
        min-width: 0 !important; width: 0 !important;
      }
      .st-ml-frame > .st-ml-sidebar { visibility: hidden !important; }
      .st-ml-frame.st-ml-open > .st-ml-sidebar {
        visibility: visible !important; display: block !important;
        position: fixed; top: var(--dsh-frame-top-clearance, env(safe-area-inset-top, 0px));
        bottom: env(safe-area-inset-bottom, 0px);
        left: env(safe-area-inset-left, 0px); z-index: 26; width: 280px !important;
        overflow: visible !important; border-right: none;
        box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.28));
        animation: st-ml-drawer-in 240ms var(--ds-ease-in-out, ease);
      }
      @keyframes st-ml-drawer-in {
        from { transform: translateX(-100%); opacity: .6 }
        to { transform: none; opacity: 1 }
      }
      /* 收起动画：保留 st-ml-open 布局，再补一个 closing 类做滑出；
         180ms 后 JS 才真正移除 open，避免「瞬间消失」。 */
      .st-ml-frame.st-ml-closing > .st-ml-sidebar {
        animation: st-ml-drawer-out 180ms var(--ds-ease-in-out, ease) forwards;
      }
      @keyframes st-ml-drawer-out {
        from { transform: none; opacity: 1 }
        to { transform: translateX(-100%); opacity: 0 }
      }
      .st-ml-fab {
        position: fixed; left: calc(12px + env(safe-area-inset-left, 0px));
        bottom: calc(env(safe-area-inset-bottom, 0px) + 188px); z-index: 30;
        display: grid; place-items: center; width: 44px; height: 44px; padding: 0;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
        border-radius: 50% !important; corner-shape: round !important; overflow: hidden;
        color: var(--dsw-alias-label-primary, #0f1115);
        background: var(--dsw-alias-button-floating-fill, #fff);
        box-shadow: var(--dsw-shadow-lv2, 0 6px 18px rgba(0,0,0,.18)); cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .st-ml-fab:active { background: var(--dsw-alias-button-floating-hover, var(--dsw-alias-interactive-bg-hover)); }
      .st-ml-fab[hidden] { display: none; }
      .st-ml-scrim {
        position: fixed; inset: 0; z-index: 25; background: rgba(0, 0, 0, .36);
        touch-action: none; animation: st-ml-scrim-in 160ms ease-out;
      }
      .st-ml-scrim[hidden] { display: none; }
      @keyframes st-ml-scrim-in { from { opacity: 0 } to { opacity: 1 } }
      .st-ml-scrim.st-ml-closing { animation: st-ml-scrim-out 180ms ease-in forwards; }
      @keyframes st-ml-scrim-out { from { opacity: 1 } to { opacity: 0 } }
      .st-ml-on [data-composer-card] { border-radius: 18px; gap: 8px !important; padding-top: 8px !important; }
      .st-ml-on [data-composer-card] > .st-ml-composer-row { gap: 8px !important; padding: 2px 6px 5px !important; }
      .st-ml-on [data-composer-card] > .st-ml-composer-row > div { gap: 8px !important; }
      @media (prefers-reduced-motion: reduce) {
        .st-ml-frame.st-ml-open > .st-ml-sidebar,
        .st-ml-frame.st-ml-closing > .st-ml-sidebar,
        .st-ml-scrim, .st-ml-scrim.st-ml-closing { animation: none; }
      }
    `

    function readMobileMode() {
      try {
        const stored = window.localStorage.getItem(MOBILE_MODE_KEY)
        return MOBILE_MODES.includes(stored) ? stored : 'always'
      } catch {
        return 'always'
      }
    }
    function writeMobileMode(mode) {
      try {
        window.localStorage.setItem(MOBILE_MODE_KEY, mode)
      } catch {
        // 隐私模式：只在本次会话生效
      }
    }

    function createMobileLayout(ctx) {
      let mode = readMobileMode()
      let active = false
      let disposed = false
      let drawerOpen = false
      let closing = false
      let closeTimer = null
      let frame = null
      let markedFrame = null
      let fab = null
      let scrim = null
      let styleTag = null
      let syncTimer = null
      let missingTimer = null
      let missingRetries = 0
      let officialExpandedByUs = false
      let observations = null
      const startedAt = Date.now()
      const media = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_BREAKPOINT) : null

      const shouldRun = () => mode === 'always' || (mode === 'auto' && media?.matches === true)

      function ensureStyle() {
        if (styleTag !== null && styleTag.isConnected) return
        const existing = document.querySelector('style[data-plugin-css="dsh-sidebar-tidy-mobile"]')
        if (existing !== null) {
          styleTag = existing
          return
        }
        styleTag = document.createElement('style')
        styleTag.dataset.pluginCss = 'dsh-sidebar-tidy-mobile'
        styleTag.textContent = MOBILE_CSS
        document.head.appendChild(styleTag)
      }

      function directChildOf(parent, node) {
        let current = node
        while (current !== null && current.parentElement !== parent) current = current.parentElement
        return current === parent ? null : current
      }

      function flowColumns(target) {
        const flow = []
        for (const child of target.children) {
          if (child.hasAttribute('data-shell-overlay')) continue
          if (child.hasAttribute('data-side')) continue
          if (child.hasAttribute('data-shell-bottom')) continue
          if (child.hasAttribute('data-shell-leading')) continue
          if (child.hasAttribute('data-sidebar-mask')) continue
          flow.push(child)
        }
        return flow
      }

      function findFrame() {
        const overlay = document.querySelector('[data-shell-overlay]')
        return overlay === null ? null : overlay.parentElement
      }

      function findSidebarColumn(target) {
        const byClass = target.querySelector('[class*="sidebarCol"]')
        if (byClass !== null) {
          const column = directChildOf(target, byClass)
          if (column !== null) return column
        }
        const flow = flowColumns(target)
        return flow.length > 0 ? flow[0] : null
      }

      function markColumns(target) {
        const flow = flowColumns(target)
        const sidebar = findSidebarColumn(target)
        const centerClass = target.querySelector('[class*="centerCol"]')
        const center = centerClass === null ? (flow.find((child) => child !== sidebar) ?? null) : directChildOf(target, centerClass)
        const rightClass = target.querySelector('[class*="rightbarCol"]')
        const afterCenter = center === null ? [] : flow.slice(flow.indexOf(center) + 1)
        const rightbar = rightClass === null ? (afterCenter[0] ?? null) : directChildOf(target, rightClass)
        if (sidebar !== null) sidebar.classList.add('st-ml-col-1', 'st-ml-sidebar')
        if (center !== null) center.classList.add('st-ml-col-2')
        if (rightbar !== null) rightbar.classList.add('st-ml-col-3')
        markComposerRow()
        syncRightbar(target)
      }

      function markComposerRow() {
        const card = document.querySelector('[data-composer-card]')
        if (card === null) return
        let row = null
        for (let index = card.children.length - 1; index >= 0; index -= 1) {
          if (card.children[index].querySelector('button') !== null) {
            row = card.children[index]
            break
          }
        }
        if (row !== null) row.classList.add('st-ml-composer-row')
      }

      function syncRightbar(target) {
        const panel = target.querySelector('[data-sidebar-right-panel]')
        const fullscreen = panel !== null && panel.getAttribute('data-sidebar-right-panel') === 'fullscreen'
        const width = panel === null || fullscreen ? '' : (panel.style.getPropertyValue('--dsh-sidebar-width') || '').trim()
        const open = panel !== null && !fullscreen && panel.hasAttribute('data-sidebar-right-open')
        target.style.setProperty('--st-ml-rightbar', open && width !== '' ? width : '0px')
      }

      function clearMarks(target) {
        if (target === null) return
        target.classList.remove('st-ml-frame', 'st-ml-open', 'st-ml-closing')
        target.style.removeProperty('--st-ml-rightbar')
        for (const element of target.querySelectorAll('.st-ml-col-1, .st-ml-col-2, .st-ml-col-3, .st-ml-sidebar')) {
          element.classList.remove('st-ml-col-1', 'st-ml-col-2', 'st-ml-col-3', 'st-ml-sidebar')
        }
        for (const element of document.querySelectorAll('.st-ml-composer-row')) {
          element.classList.remove('st-ml-composer-row')
        }
      }

      /** 卸载/关闭时清理全页面标记，避免 React 已换 frame 后旧节点残留样式。 */
      function clearAllMarks() {
        for (const element of document.querySelectorAll('.st-ml-frame')) {
          element.classList.remove('st-ml-frame', 'st-ml-open', 'st-ml-closing')
          element.style.removeProperty('--st-ml-rightbar')
        }
        for (const element of document.querySelectorAll('.st-ml-col-1, .st-ml-col-2, .st-ml-col-3, .st-ml-sidebar')) {
          element.classList.remove('st-ml-col-1', 'st-ml-col-2', 'st-ml-col-3', 'st-ml-sidebar')
        }
        for (const element of document.querySelectorAll('.st-ml-composer-row')) {
          element.classList.remove('st-ml-composer-row')
        }
      }

      function removeChrome() {
        if (fab !== null) { fab.remove(); fab = null }
        if (scrim !== null) { scrim.remove(); scrim = null }
      }

      function createChrome() {
        if (fab === null) {
          fab = document.createElement('button')
          fab.type = 'button'
          fab.className = 'st-ml-fab'
          fab.dataset.role = 'sidebar-tidy-mobile-fab'
          fab.innerHTML = icon('menu')
          // DSH 主题给所有元素设了 corner-shape: superellipse(...)，50% 圆角
          // 会被压成圆角矩形；用 inline !important 明确回到正圆。
          fab.style.setProperty('border-radius', '50%', 'important')
          fab.style.setProperty('corner-shape', 'round', 'important')
          fab.addEventListener('click', openDrawer)
        }
        if (scrim === null) {
          scrim = document.createElement('div')
          scrim.className = 'st-ml-scrim'
          scrim.dataset.role = 'sidebar-tidy-mobile-scrim'
          scrim.hidden = true
          scrim.addEventListener('click', closeDrawer)
        }
        if (fab.parentElement === null) document.body.appendChild(fab)
        if (scrim.parentElement === null) document.body.appendChild(scrim)
      }

      function requestOfficialExpand() {
        const target = frame ?? findFrame()
        if (target === null || !target.hasAttribute('data-sidebar-collapsed')) return
        officialExpandedByUs = true
        const layout = optionalService('layout')
        try {
          if (typeof layout?.toggleSidebar === 'function') {
            layout.toggleSidebar()
            return
          }
        } catch {
          // 回退到按钮点击
        }
        const toggle = target.querySelector('button[data-sidebar-toggle], button[data-sidebar-opener]')
        if (toggle !== null) toggle.click()
      }

      function restoreOfficial() {
        if (!officialExpandedByUs) return
        officialExpandedByUs = false
        const target = frame ?? findFrame()
        if (target === null || target.hasAttribute('data-sidebar-collapsed')) return
        const layout = optionalService('layout')
        try {
          if (typeof layout?.toggleSidebar === 'function') {
            layout.toggleSidebar()
            return
          }
        } catch {
          // 忽略
        }
        const toggle = target.querySelector('button[data-sidebar-toggle], button[data-sidebar-opener]')
        if (toggle !== null) toggle.click()
      }

      function sync() {
        if (disposed || !active) return
        frame = findFrame()
        if (frame === null) {
          scheduleMissing()
          return
        }
        missingRetries = 0
        if (markedFrame !== null && markedFrame !== frame) clearMarks(markedFrame)
        markedFrame = frame
        frame.classList.add('st-ml-frame')
        frame.classList.toggle('st-ml-open', drawerOpen)
        document.documentElement.classList.add('st-ml-on')
        createChrome()
        scrim.hidden = !drawerOpen
        fab.hidden = drawerOpen
        const label = textFor(ctx, '打开侧边栏', 'Open sidebar')
        if (fab.getAttribute('aria-label') !== label) fab.setAttribute('aria-label', label)
        if (fab.getAttribute('title') !== label) fab.setAttribute('title', label)
        markColumns(frame)
      }

      function scheduleMissing() {
        if (missingTimer !== null || disposed || !active) return
        if (missingRetries >= 12) {
          logOnce('warn', 'mobile:no-frame', 'mobile.anchor.missing', '未找到 DSH 主框架，移动布局暂不可用', {})
          return
        }
        missingRetries += 1
        missingTimer = window.setTimeout(() => {
          missingTimer = null
          if (!active || disposed) return
          if (findFrame() === null) {
            if (Date.now() - startedAt > 4000) {
              logOnce('warn', 'mobile:no-frame', 'mobile.anchor.missing', '未找到 DSH 主框架，移动布局暂不可用', {})
            }
            scheduleMissing()
            return
          }
          scheduleSync()
        }, 500)
      }

      function scheduleSync() {
        if (disposed || !active || syncTimer !== null) return
        // 观察整个 body 会被流式输出频繁唤醒；120ms 合帧足够快，也不会每帧重排。
        syncTimer = window.setTimeout(() => {
          syncTimer = null
          sync()
        }, 120)
      }

      function openDrawer() {
        if (!active) return
        if (closeTimer !== null) {
          window.clearTimeout(closeTimer)
          closeTimer = null
        }
        closing = false
        if (frame !== null) frame.classList.remove('st-ml-closing')
        if (scrim !== null) scrim.classList.remove('st-ml-closing')
        drawerOpen = true
        sync()
        requestOfficialExpand()
        log('info', 'mobile.open', '打开移动侧栏抽屉', { mode })
      }

      function closeDrawer() {
        if (!drawerOpen || closing) return
        closing = true
        if (frame !== null) frame.classList.add('st-ml-closing')
        if (scrim !== null) scrim.classList.add('st-ml-closing')
        log('info', 'mobile.close', '关闭移动侧栏抽屉', { mode, animated: true })
        // 等 CSS 的 180ms 滑出动画跑完再撤掉 open，避免收起时闪一下。
        closeTimer = window.setTimeout(() => {
          closeTimer = null
          closing = false
          drawerOpen = false
          if (frame !== null) frame.classList.remove('st-ml-closing')
          if (scrim !== null) {
            scrim.classList.remove('st-ml-closing')
            scrim.hidden = true
          }
          sync()
        }, 180)
      }

      function onKeyDown(event) {
        if (event.key === 'Escape' && drawerOpen) closeDrawer()
      }

      function activate() {
        if (active) return
        active = true
        missingRetries = 0
        ensureStyle()
        document.documentElement.classList.add('st-ml-on')
        log('info', 'mobile.activate', '启用移动抽屉布局', { mode, media: media?.matches === true })
        scheduleSync()
      }

      function deactivate(restore = false) {
        if (!active) return
        active = false
        drawerOpen = false
        closing = false
        if (closeTimer !== null) {
          window.clearTimeout(closeTimer)
          closeTimer = null
        }
        clearMarks(markedFrame)
        clearAllMarks()
        markedFrame = null
        frame = null
        removeChrome()
        document.documentElement.classList.remove('st-ml-on')
        if (restore) restoreOfficial()
        else officialExpandedByUs = false
        if (missingTimer !== null) {
          window.clearTimeout(missingTimer)
          missingTimer = null
        }
        if (syncTimer !== null) {
          window.clearTimeout(syncTimer)
          syncTimer = null
        }
        log('info', 'mobile.deactivate', '关闭移动抽屉布局', { mode, restore })
      }

      function reconcile() {
        if (disposed) return
        if (!shouldRun()) {
          if (active) deactivate()
          return
        }
        activate()
        scheduleSync()
      }

      function onEnvironmentChange() {
        reconcile()
      }

      function start() {
        ensureStyle()
        const observer = new window.MutationObserver(() => { if (active) scheduleSync() })
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', onEnvironmentChange)
        document.addEventListener('keydown', onKeyDown, true)
        if (media !== null) {
          if (typeof media.addEventListener === 'function') media.addEventListener('change', onEnvironmentChange)
          else if (typeof media.addListener === 'function') media.addListener(onEnvironmentChange)
        }
        reconcile()
        observations = {
          stop() {
            observer.disconnect()
            window.removeEventListener('resize', onEnvironmentChange)
            document.removeEventListener('keydown', onKeyDown, true)
            if (media !== null) {
              if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onEnvironmentChange)
              else if (typeof media.removeListener === 'function') media.removeListener(onEnvironmentChange)
            }
          },
        }
        return () => {
          disposed = true
          observations?.stop()
          observations = null
          deactivate(true)
          styleTag?.remove()
          styleTag = null
        }
      }

      function cycleMode() {
        const index = MOBILE_MODES.indexOf(mode)
        mode = MOBILE_MODES[(index + 1) % MOBILE_MODES.length]
        writeMobileMode(mode)
        log('info', 'mobile.mode', '切换移动布局模式', { mode })
        reconcile()
        return mode
      }

      function modeText() {
        if (mode === 'always') return textFor(ctx, '移动布局：始终', 'Mobile layout: always')
        if (mode === 'off') return textFor(ctx, '移动布局：关闭', 'Mobile layout: off')
        return textFor(ctx, '移动布局：自动（窄屏）', 'Mobile layout: auto')
      }

      return {
        start,
        cycleMode,
        modeText,
        getMode: () => mode,
        isActive: () => active,
      }
    }

    // ── 「更多」内嵌下拉 ───────────────────────────────────────────────
    function createDropdown(ctx, mobileLayout) {
      let list = null          // 列表根节点（内嵌 div 或 rail 浮层）
      let anchorButton = null
      let suppressClickUntil = 0
      let dropLine = null      // 拖到侧栏时的插入线
      let dropIndex = null     // 插入位置（侧栏固定行之间）
      let hint = null          // 拖到侧栏时的浮动提示
      let navObserver = null   // 框架重排侧栏时把我们摘掉 → 立刻挂回去

      /** 盯住侧栏 nav：React 提交后如果我们的列表被摘掉，就在同一批 mutation 后挂回去。 */
      function watchNav(nav) {
        if (typeof window.MutationObserver !== 'function') return
        if (navObserver !== null) navObserver.disconnect()
        if (nav === null) {
          navObserver = null
          return
        }
        navObserver = new window.MutationObserver(() => {
          if (list === null || list.isConnected) return
          try {
            render()
          } catch (error) {
            // 侧栏正在重建，下一次 mutation 再试
          }
        })
        navObserver.observe(nav, { childList: true })
      }

      const isZh = () => {
        try {
          return String(ctx.locale.getSnapshot().active).toLowerCase().startsWith('zh')
        } catch (error) {
          return true
        }
      }
      const labelFor = (zh, en) => (isZh() ? zh : en)

      /** 只列收起的面板：侧栏里已有的（KEEP）不重复出现在更多里；
       *  「插件」(plugins) 面板始终常驻侧栏，它的入口只保留外面那一个，不再进「更多」。 */
      function currentRows() {
        return sortRows(panelRows(ctx), readOrder())
          .filter((row) => !KEEP.includes(row.id) && row.id !== 'plugins')
      }

      function close() {
        const wasOpen = list !== null
        if (list !== null) {
          list.remove()
          list = null
        }
        const openButtons = new Set(document.querySelectorAll('nav button[aria-haspopup="menu"].st-more-open'))
        if (anchorButton !== null) openButtons.add(anchorButton)
        for (const button of openButtons) {
          button.style.background = ''
          button.classList.remove('st-more-open')
        }
        anchorButton = null
        clearDropLine()
        if (navObserver !== null) {
          navObserver.disconnect()
          navObserver = null
        }
        // 2026-10-25 按要求：点击空白不再收起「更多」——不注册 document 级 outside 关闭；
        // 只有 Esc、再次点「更多」、点菜单项/面板行才会收起。
        document.removeEventListener('keydown', onKeyDown, true)
        if (wasOpen) log('info', 'more.close', '收起「更多」', {})
      }

      function onOutsidePointerDown(event) {
        if (list === null) return
        const target = event.target
        if (list.contains(target) || (anchorButton !== null && anchorButton.contains(target))) return
        // 在侧栏面板按钮上按下时不关：允许把它拖进「更多」
        const button = target?.closest?.('button')
        if (button !== null && button !== undefined && [...button.classList].some((name) => name.endsWith('_panelRow'))) return
        close()
      }
      function onOutsideClick(event) {
        if (list === null) return
        if (list.contains(event.target)) return
        close()
      }
      function onKeyDown(event) {
        if (event.key === 'Escape') close()
      }

      function selectPanel(id) {
        close()
        log('info', 'more.select', '从「更多」打开面板', { id })
        try {
          ctx.layout.selectPanel(id)
        } catch (error) {
          log('warn', 'more.select.failed', '切换面板失败', { id, error: error instanceof Error ? error.message : String(error) })
          // 目标面板可能已经卸载
        }
      }

      function commitOrder() {
        if (list === null) return
        const ids = []
        for (const row of list.querySelectorAll('[data-panel-id]')) ids.push(row.dataset.panelId)
        writeOrder(ids)
        applyOrder(ctx, ids)
        renderSoon()
        log('info', 'more.reorder', '「更多」内排序已保存', { ids })
      }

      /** 按 y 坐标把被拖的行插到合适位置。 */
      function moveRowTo(rowEl, clientY) {
        if (list === null) return
        const rows = [...list.querySelectorAll('[data-panel-id]')]
        const index = rows.indexOf(rowEl)
        if (index === -1) return
        for (const other of rows) {
          if (other === rowEl) continue
          const box = other.getBoundingClientRect()
          const middle = box.top + box.height / 2
          const before = rows.indexOf(other) < index
          if (before && clientY < middle) {
            list.insertBefore(rowEl, other)
            return
          }
          if (!before && clientY > middle) {
            list.insertBefore(rowEl, other.nextSibling)
            return
          }
        }
      }

      /** 侧栏里已经固定的面板行（nav 的直接子节点，排除「更多」）。 */
      function sidebarRowElements() {
        if (anchorButton === null) return []
        const nav = anchorButton.closest('nav')
        if (nav === null) return []
        return [...nav.children].filter((child) => {
          const button = typeof child.matches === 'function' && child.matches('button') ? child : child.querySelector?.('button')
          if (!button) return false
          if (button.getAttribute?.('aria-haspopup') === 'menu') return false
          return [...button.classList].some((name) => name.endsWith('_panelRow'))
        })
      }

      /** 指针是否已经拖到侧栏区域（列表外、且在侧栏 nav 内，或越过了列表顶边）。 */
      function isOverSidebar(event) {
        if (list === null || anchorButton === null) return false
        const box = list.getBoundingClientRect()
        // 越过列表顶边 = 已经拖进侧栏面板区
        if (event.clientY < box.top - 6) return true
        // 指针压在某个侧栏面板按钮（或「更多」）上才算，避免落在 nav 空隙里误判
        const element = document.elementFromPoint(event.clientX, event.clientY)
        if (element === null || list.contains(element)) return false
        const button = element.closest?.('button')
        if (button === null || button === undefined) return false
        return [...button.classList].some((name) => name.endsWith('_panelRow'))
      }

      /** 跟随指针的小提示。 */
      function showHint(clientX, clientY) {
        if (hint === null) {
          hint = document.createElement('div')
          hint.className = 'st-hint'
          hint.textContent = labelFor('松手放回侧栏', 'Release to pin')
          document.body.appendChild(hint)
        }
        hint.style.left = Math.round(clientX) + 'px'
        hint.style.top = Math.round(clientY) + 'px'
      }
      function hideHint() {
        if (hint !== null) {
          hint.remove()
          hint = null
        }
      }

      /** 拖到侧栏区域时，在目标位置画一条插入线，并高亮侧栏。 */
      function showDropLine(clientY) {
        if (anchorButton === null) return
        const nav = anchorButton.closest('nav')
        if (nav === null) return
        const rows = sidebarRowElements()
        let index = 0
        for (const rowEl of rows) {
          const box = rowEl.getBoundingClientRect()
          if (clientY > box.top + box.height / 2) index += 1
        }
        dropIndex = index
        if (dropLine === null) {
          dropLine = document.createElement('div')
          dropLine.className = 'st-drop-line'
        }
        const reference = index < rows.length ? rows[index] : rows.length > 0 ? rows[rows.length - 1].nextSibling : null
        nav.insertBefore(dropLine, reference)
        nav.classList.add('st-promoting')
      }

      function clearDropLine() {
        if (dropLine !== null) {
          dropLine.remove()
          dropLine = null
        }
        dropIndex = null
        if (anchorButton !== null) anchorButton.closest('nav')?.classList.remove('st-promoting')
        hideHint()
      }

      /** 把「更多」里的面板拖回侧栏：写白名单 + 排到目标位置 + 取消 pin。 */
      function promote(id, index) {
        const rows = panelRows(ctx)
        const sorted = [...rows].sort((a, b) => a.order - b.order)
        const pinned = sorted.filter((row) => row.id === 'plugins' || KEEP.includes(row.id)).map((row) => row.id)
        const next = moveInto(pinned, id, index)
        const keep = next.filter((rowId) => rowId !== 'plugins')
        KEEP.length = 0
        KEEP.push(...keep)
        persistKeep()
        applyPinnedOrder(ctx, next)
        try {
          const sidebar = ctx.slots.entriesOfSlot('sidebar').find((entry) => typeof entry?.inject === 'function')
          sidebar?.inject?.()?.setPinned?.(id, true)
        } catch (error) {
          // ignore
        }
        writeOrder(readOrder().filter((rowId) => rowId !== id))
        render()
        renderSoon()
        log('info', 'more.promote', '从「更多」放回侧栏', { id, index, keep: [...KEEP] })
      }

      /** 按住行体拖动：上下移动=排序；拖出列表上方=放回侧栏；没移动=点击切换。 */
      function bindRow(rowEl, row) {
        const panelId = row.id
        const ghost = createGhost(ctx)
        rowEl.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const startY = event.clientY
          let moved = false
          let promoting = false
          rowEl.classList.add('st-dragging')
          log('debug', 'more.row.drag.start', '开始拖动「更多」里的面板', { id: panelId })
          const onMove = (moveEvent) => {
            if (!moved && Math.abs(moveEvent.clientY - startY) < 4) return
            moved = true
            ghost.show(moveEvent.clientX, moveEvent.clientY, row)
            if (isOverSidebar(moveEvent)) {
              promoting = true
              rowEl.classList.add('st-promote')
              showDropLine(moveEvent.clientY)
              showHint(moveEvent.clientX, moveEvent.clientY)
              return
            }
            if (promoting) {
              promoting = false
              rowEl.classList.remove('st-promote')
              clearDropLine()
            }
            moveRowTo(rowEl, moveEvent.clientY)
          }
          const onUp = () => {
            document.removeEventListener('pointermove', onMove, true)
            document.removeEventListener('pointerup', onUp, true)
            rowEl.classList.remove('st-dragging')
            rowEl.classList.remove('st-promote')
            ghost.hide()
            const target = dropIndex
            clearDropLine()
            if (promoting && target !== null) {
              promote(panelId, target)
              suppressClickUntil = Date.now() + 400
            } else if (moved) {
              commitOrder()
              suppressClickUntil = Date.now() + 400
              log('info', 'more.row.reorder', '「更多」内拖动排序', { id: panelId })
            } else if (Date.now() >= suppressClickUntil) {
              selectPanel(panelId)
            }
          }
          document.addEventListener('pointermove', onMove, true)
          document.addEventListener('pointerup', onUp, true)
        })
      }

      function rowElement(row) {
        const line = document.createElement('div')
        line.className = 'st-row'
        line.dataset.panelId = row.id
        line.setAttribute('role', 'menuitem')

        const glyph = document.createElement('span')
        glyph.className = 'st-ico'
        glyph.appendChild(svgNode(rowIconMarkup(row, ctx, 16)))
        line.appendChild(glyph)

        const text = document.createElement('span')
        text.className = 'st-label'
        text.textContent = row.label
        line.appendChild(text)

        bindRow(line, row)
        return line
      }

      function actionRow(kind, text, run) {
        const line = document.createElement('div')
        line.className = 'st-row'
        line.setAttribute('role', 'menuitem')
        const glyph = document.createElement('span')
        glyph.className = 'st-ico'
        glyph.appendChild(svgNode(icon(kind)))
        line.appendChild(glyph)
        const label = document.createElement('span')
        label.className = 'st-label'
        label.textContent = text
        line.appendChild(label)
        line.addEventListener('click', run)
        return line
      }

      function render() {
        if (list === null) return
        // React 重排侧栏时可能把我们的节点摘掉：重新挂回「更多」那行下面。
        // 面板 pin 状态变化还会重建「更多」按钮本身，所以先找回当前那颗按钮。
        if (!list.isConnected) {
          if (anchorButton === null || !anchorButton.isConnected) {
            const fresh = anyMoreButton()
            if (fresh !== null) anchorButton = fresh
          }
          if (anchorButton === null) {
            list = null
            return
          }
          const mounter = anchorButton.getBoundingClientRect().width < 60 ? mountFlyout : mountInline
          const next = mounter(anchorButton)
          if (next === null) {
            list = null
            return
          }
          list = next
          watchNav(anchorButton.closest('nav'))
        }
        list.textContent = ''
        // React 重渲染可能重建「更多」按钮：展开态箭头需要重新标记
        if (anchorButton !== null) {
          anchorButton.classList.add('st-more-open')
          anchorButton.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'
        }
        for (const row of currentRows()) list.appendChild(rowElement(row))
        const gap = document.createElement('div')
        gap.style.height = '2px'
        list.appendChild(gap)

        // 移动布局模式（融合自 web 侧 dsh-mobile-layout）：点一次循环
        // auto → always → off，持久化到 localStorage。
        list.appendChild(actionRow('mobile', mobileLayout.modeText(), () => {
          const next = mobileLayout.cycleMode()
          render()
          log('info', 'more.mobile', '切换移动布局模式', { mode: next })
        }))

        const navigation = optionalService('pluginNavigation')
        if (navigation !== null && typeof navigation.openList === 'function') {
          list.appendChild(actionRow('browse', labelFor('浏览更多插件', 'Browse more plugins'), () => {
            close()
            log('info', 'more.browse', '打开插件列表', {})
            try {
              navigation.openList()
            } catch (error) {
              log('warn', 'more.browse.failed', '打开插件列表失败', { error: error instanceof Error ? error.message : String(error) })
            }
          }))
        } else {
          // pluginNavigation 由 ui-plugin-manager 动态 provide；没有它时隐藏该入口。
          logOnce('debug', 'service:pluginNavigation', 'service.missing', 'pluginNavigation 不可用，隐藏「浏览更多插件」入口', {})
        }

        const workspace = optionalService('uiWorkspace')
        if (workspace !== null && typeof workspace.startSession === 'function') {
          list.appendChild(actionRow('create', labelFor('创建你的插件', 'Create your own plugin'), () => {
            close()
            log('info', 'more.create', '新建插件创作会话', {})
            try {
              workspace.startSession(undefined, {
                agentPreset: 'cordis',
                prompt: labelFor('创建一个带左侧栏入口的 DSH 插件。', 'Create a DSH plugin with a left sidebar entry.'),
                whenDraftExists: 'append',
              })
            } catch (error) {
              log('warn', 'more.create.failed', '创建插件会话失败', { error: error instanceof Error ? error.message : String(error) })
            }
          }))
        } else {
          logOnce('debug', 'service:uiWorkspace', 'service.missing', 'uiWorkspace 不可用，隐藏「创建你的插件」入口', {})
        }
      }

      /** React 提交 pin 状态之后再来一次，保证下拉没被框架重排顺手摘掉。 */
      function renderSoon() {
        window.setTimeout(() => {
          try {
            render()
          } catch (error) {
            // 下拉已关闭或侧栏已卸载
          }
        }, 0)
      }

      /** 内嵌挂载：插在「更多」那一行后面，让下面的内容被自然挤下去。 */
      function mountInline(button) {
        const nav = button.closest('nav')
        if (nav === null) return null
        const holder = document.createElement('div')
        holder.className = 'st-list'
        const row = [...nav.children].find((child) => child === button || child.contains(button)) ?? button
        nav.insertBefore(holder, row.nextSibling)
        return holder
      }

      /** rail 模式：空间不够，退回贴着侧栏右侧的浮层。 */
      function mountFlyout(button) {
        const holder = document.createElement('div')
        holder.className = 'st-list st-flyout'
        document.body.appendChild(holder)
        const box = button.getBoundingClientRect()
        holder.style.position = 'fixed'
        holder.style.zIndex = '2147483000'
        holder.style.minWidth = '200px'
        holder.style.maxWidth = '260px'
        holder.style.visibility = 'hidden'
        holder.style.left = '0px'
        holder.style.top = '0px'
        const size = holder.getBoundingClientRect()
        let left = box.right + 8
        let top = box.top
        if (left + size.width > window.innerWidth - 8) left = Math.max(8, box.left - size.width - 8)
        if (top + size.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - size.height - 8)
        holder.style.left = Math.round(left) + 'px'
        holder.style.top = Math.round(top) + 'px'
        holder.style.visibility = 'visible'
        return holder
      }

      function open(button) {
        close()
        anchorButton = button
        const railMode = button.getBoundingClientRect().width < 60
        list = railMode ? mountFlyout(button) : mountInline(button)
        if (list === null) {
          anchorButton = null
          return
        }
        watchNav(button.closest('nav'))
        button.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'
        button.classList.add('st-more-open')   // 箭头朝上 = 已展开
        render()
        log('info', 'more.open', '打开「更多」', { hidden: currentRows().length, rail: railMode, keep: [...KEEP] })
        // 点击空白不收起（见 close() 注释）：只监听 Esc。
        document.addEventListener('keydown', onKeyDown, true)
      }

      function toggle(button) {
        if (list !== null && anchorButton === button) close()
        else open(button)
      }

      return { toggle, close, isOpen: () => list !== null, render, renderSoon, listElement: () => list }
    }

    /** 侧栏面板按钮本身的拖拽：上下排序；拖到「更多」下方＝移入更多。dragClick 与外部 click 处理共享，拖完不吃成点击。 */
    function bindSidebarDrag(ctx, dropdown, dragClick) {
      let state = null
      let line = null
      let hint = null
      let swallowClickUntil = 0
      const ghost = createGhost(ctx)
      const panelRow = (id) => panelRows(ctx).find((row) => row.id === id) ?? { id, label: id }

      const clear = () => {
        if (line !== null) { line.remove(); line = null }
        if (hint !== null) { hint.remove(); hint = null }
        ghost.hide()
        try { dropdown.listElement()?.classList.remove('st-drop-target') } catch (error) { /* ignore */ }
      }
      const showHint = (x, y, text) => {
        if (hint === null) {
          hint = document.createElement('div')
          hint.className = 'st-hint'
          document.body.appendChild(hint)
        }
        hint.textContent = text
        hint.style.left = Math.round(x) + 'px'
        hint.style.top = Math.round(y) + 'px'
      }
      const rowWrappers = (nav) => [...nav.children].filter((child) => {
        const button = typeof child.matches === 'function' && child.matches('button') ? child : child.querySelector?.('button')
        if (!button) return false
        if (button.getAttribute?.('aria-haspopup') === 'menu') return false
        return [...button.classList].some((name) => name.endsWith('_panelRow'))
      })
      const moreBottom = (nav) => {
        const more = nav.querySelector('button[aria-haspopup="menu"]')
        return more === null ? nav.getBoundingClientRect().bottom : more.getBoundingClientRect().bottom
      }
      const showLine = (nav, clientY, dragged) => {
        const wrappers = rowWrappers(nav).filter((w) => !w.contains(dragged))
        let index = 0
        for (const wrapper of wrappers) {
          const box = wrapper.getBoundingClientRect()
          if (clientY > box.top + box.height / 2) index += 1
        }
        state.index = index
        if (line === null) {
          line = document.createElement('div')
          line.className = 'st-drop-line'
        }
        const reference = index < wrappers.length ? wrappers[index] : wrappers.length > 0 ? wrappers[wrappers.length - 1].nextSibling : null
        nav.insertBefore(line, reference)
      }
      const commitReorder = (nav, id) => {
        const pinned = pinnedSorted(ctx)
        const next = moveInto(pinned.filter((rowId) => rowId !== id), id, state.index ?? pinned.length)
        const keep = next.filter((rowId) => rowId !== 'plugins')
        KEEP.length = 0
        KEEP.push(...keep)
        persistKeep()
        applyPinnedOrder(ctx, next)
        try { dropdown.renderSoon() } catch (error) { /* 下拉未打开 */ }
        log('info', 'sidebar.reorder', '侧栏面板拖动排序已保存', { id, index: state.index ?? null, pinned: next })
      }
      const moveToMore = (id) => {
        const at = KEEP.indexOf(id)
        if (at !== -1) KEEP.splice(at, 1)
        persistKeep()
        let pinned = false
        try {
          const sidebar = ctx.slots.entriesOfSlot('sidebar').find((entry) => typeof entry?.inject === 'function')
          const setPinned = sidebar?.inject?.()?.setPinned
          if (typeof setPinned === 'function') {
            setPinned(id, false)
            pinned = true
          }
        } catch (error) {
          // 侧栏可能正在重建
        }
        if (!pinned) logOnce('warn', 'setPinned:missing', 'sidebar.setPinned.missing', '找不到侧栏 setPinned 接口，面板可能没有真正收起', { id })
        writeOrder([...readOrder().filter((rowId) => rowId !== id), id])
        try { dropdown.render() } catch (error) { /* 下拉未打开 */ }
        try { dropdown.renderSoon() } catch (error) { /* 下拉未打开 */ }
        log('info', 'sidebar.to-more', '把面板移入「更多」', { id, keep: [...KEEP] })
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const button = event.target?.closest?.('button')
        if (button === null || button === undefined) return
        const nav = button.closest('nav')
        if (nav === null) return
        if (button.getAttribute('aria-haspopup') === 'menu') return
        if (![...button.classList].some((name) => name.endsWith('_panelRow'))) return
        const index = rowWrappers(nav).findIndex((wrapper) => wrapper === button || wrapper.contains(button))
        if (index === -1) return
        const id = pinnedSorted(ctx)[index]
        if (id === undefined || id === 'plugins') return
        const dragRow = panelRow(id)
        log('debug', 'sidebar.row.drag.start', '开始拖动侧栏面板', { id })

        const startX = event.clientX
        const startY = event.clientY
        let moved = false
        state = { id, index: null }
        const onMove = (moveEvent) => {
          if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return
          moved = true
          ghost.show(moveEvent.clientX, moveEvent.clientY, dragRow)
          const owner = button.closest('nav')
          if (owner === null) return
          const targetList = dropdown.listElement()
          if (moveEvent.clientY > moreBottom(owner) + 4) {
            state.mode = 'hide'
            if (line !== null) { line.remove(); line = null }
            showHint(moveEvent.clientX, moveEvent.clientY, '松手移入更多')
            if (targetList !== null) targetList.classList.add('st-drop-target')
            return
          }
          state.mode = 'reorder'
          if (hint !== null) { hint.remove(); hint = null }
          if (targetList !== null) targetList.classList.remove('st-drop-target')
          showLine(owner, moveEvent.clientY, button)
        }
        const onUp = () => {
          document.removeEventListener('pointermove', onMove, true)
          document.removeEventListener('pointerup', onUp, true)
          const mode = state?.mode
          const navNow = button.closest('nav')
          clear()
          if (mode !== null && mode !== undefined) {
            swallowClickUntil = Date.now() + 300
            dragClick.until = swallowClickUntil
          }
          if (mode === 'hide') moveToMore(id)
          else if (mode === 'reorder' && navNow !== null) commitReorder(navNow, id)
          state = null
        }
        document.addEventListener('pointermove', onMove, true)
        document.addEventListener('pointerup', onUp, true)
      }

      // 拖完不要顺带触发按钮的 click（那会切走面板）
      const onClickCapture = (event) => {
        if (Date.now() >= swallowClickUntil) return
        event.stopImmediatePropagation()
        event.preventDefault()
      }

      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('click', onClickCapture, true)
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('click', onClickCapture, true)
      }
    }

    /** 判定一颗按钮是不是侧栏「更多」：带 aria-haspopup="menu"、在 nav 里，且该 nav 有面板行。 */
    function moreButtonIn(button) {
      if (button === null || button === undefined) return null
      const nav = button.closest?.('nav')
      if (nav === null || nav === undefined) return null
      const hasPanelRow = [...nav.querySelectorAll('button')].some((node) => [...node.classList].some((name) => name.endsWith('_panelRow')))
      return hasPanelRow ? button : null
    }

    /** 当前页面里的「更多」按钮：pin 状态变化会让 React 重建它，不能一直握着旧节点。 */
    function anyMoreButton() {
      for (const button of document.querySelectorAll('button[aria-haspopup="menu"]')) {
        if (moreButtonIn(button) !== null) return button
      }
      return null
    }

    /** 「更多」按钮识别。 */
    function findMoreButton(event) {
      return moreButtonIn(event.target?.closest?.('button[aria-haspopup="menu"]'))
    }

    return {
      exportName: 'dsh-sidebar-tidy',
      version: PLUGIN_VERSION,
      tidy,
      sortRows,
      reorder,
      moveInto,
      KEEP,
      // pluginNavigation / uiWorkspace 不是核心服务：前者由 ui-plugin-manager
      // 动态 provide，后者可能被极简组合省略。硬 inject 会让整个插件在缺少
      // 它们时直接不激活，所以改为运行时 ctx.get(...) 可选读取。
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        logCtx = ctx
        ctx.effect(() => ensureStyle(), 'sidebar-tidy: styles')
        const mobileLayout = createMobileLayout(ctx)
        const dropdown = createDropdown(ctx, mobileLayout)
        log('info', 'plugin.apply', '客户端半侧已激活', {
          version: PLUGIN_VERSION,
          keep: [...KEEP],
          panels: panelRows(ctx).length,
          hidden: panelRows(ctx).filter((row) => !KEEP.includes(row.id) && row.id !== 'plugins').length,
          pluginNavigation: optionalService('pluginNavigation') !== null,
          uiWorkspace: optionalService('uiWorkspace') !== null,
          mobileLayout: mobileLayout.getMode(),
        })

        // A. 侧栏只留白名单
        let scheduled = false
        let lastTidyCalls = -2
        const schedule = () => {
          if (scheduled) return
          scheduled = true
          queueMicrotask(() => {
            scheduled = false
            const calls = tidy(ctx)
            if (calls >= 0 && calls !== lastTidyCalls) {
              lastTidyCalls = calls
              log('info', 'sidebar.tidy', '同步侧栏面板 pin 状态', { calls, keep: [...KEEP] })
            } else if (calls < 0) {
              logOnce('warn', 'tidy:missing', 'sidebar.tidy.missing', '找不到侧栏 setPinned 接口，无法自动收起面板', {})
            }
          })
        }
        ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', schedule), 'sidebar-tidy: panels')
        ctx.effect(() => ctx.slots.subscribe('sidebar', schedule), 'sidebar-tidy: sidebar')
        schedule()

        // 恢复持久化顺序与自定义白名单（重启/重载后不丢）；面板列表变化时若下拉开着就重绘
        const sync = () => {
          const order = readOrder()
          if (order.length > 0) {
            applyOrder(ctx, order)
            log('debug', 'sync.order', '恢复「更多」内的持久化顺序', { count: order.length, ids: order })
          }
          const pinnedOrder = readPinnedOrder()
          if (pinnedOrder !== null && pinnedOrder.length > 0) {
            const valid = pinnedOrder.filter((id) => id === 'plugins' || KEEP.includes(id))
            const rows = panelRows(ctx)
            const mismatch = valid.some((id, index) => {
              const row = rows.find((item) => item.id === id)
              return row !== undefined && row.order !== index
            })
            if (valid.length > 0 && mismatch) {
              applyPinnedOrder(ctx, valid, false)
              log('debug', 'sync.pinned', '恢复侧栏固定面板顺序', { ids: valid })
            }
          }
          if (dropdown.isOpen()) dropdown.render()
        }
        queueMicrotask(sync)
        ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', sync), 'sidebar-tidy: sync')
        ctx.effect(() => {
          const onPageHide = () => { void flushLogs('pagehide') }
          const onVisibility = () => {
            if (document.visibilityState === 'hidden') void flushLogs('hidden')
          }
          window.addEventListener('pagehide', onPageHide)
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            window.removeEventListener('pagehide', onPageHide)
            document.removeEventListener('visibilitychange', onVisibility)
            log('info', 'plugin.dispose', '客户端半侧已卸载', {})
            void flushLogs('dispose')
          }
        }, 'sidebar-tidy: log lifecycle')

        // B. 接管「更多」按钮
        // 拖拽结束的那次 click 用共享时间戳吃掉：拖回原位松手不算「点侧栏面板」，
        // 不能把开着的「更多」顺手关掉。
        const dragClick = { until: 0 }
        const onClick = (event) => {
          if (Date.now() < dragClick.until) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          const button = findMoreButton(event)
          if (button !== null) {
            event.preventDefault()
            event.stopPropagation()
            dropdown.toggle(button)
            return
          }
          // 点侧栏面板行时收起下拉；点空白处不收起（2026-10-25 需求）。
          if (!dropdown.isOpen()) return
          const panelButton = event.target?.closest?.('button')
          if (panelButton === null || panelButton === undefined) return
          if (panelButton.closest('nav') === null) return
          if ([...panelButton.classList].some((name) => name.endsWith('_panelRow'))) dropdown.close()
        }
        ctx.effect(() => {
          document.addEventListener('click', onClick, true)
          return () => {
            document.removeEventListener('click', onClick, true)
            dropdown.close()
          }
        }, 'sidebar-tidy: more button')

        // 侧栏按钮本身也能拖：上下排序 / 拖到「更多」下方收起来
        ctx.effect(() => bindSidebarDrag(ctx, dropdown, dragClick), 'sidebar-tidy: sidebar drag')

        // 移动抽屉布局：auto 只作用于窄屏，always 复刻 WSL 原插件行为
        ctx.effect(() => mobileLayout.start(), 'sidebar-tidy: mobile layout')

        // C. 兜底：万一没拦住框架菜单，让它的槽位里也列出收起的面板
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
          name: 'sidebar.panellist.actions',
          id: 'sidebar-tidy-more',
          order: -10,
        }, function HiddenPanels({ entries, onOpen, onDismiss }) {
          const hidden = (Array.isArray(entries) ? entries : []).filter((entry) => entry !== null && typeof entry === 'object' && entry.pinned === false)
          if (hidden.length === 0) return null
          return h(React.Fragment, null, hidden.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            role: 'menuitem',
            onClick: () => {
              log('info', 'fallback.open', '使用框架原生「更多」菜单打开面板', { id: entry.id })
              try {
                onDismiss()
              } catch (error) {
                // ignore
              }
              onOpen(entry.id)
            },
            style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', background: 'none', border: 0, color: 'inherit', cursor: 'pointer' },
          }, entry.label)))
        }))
      },
    }
  },
})

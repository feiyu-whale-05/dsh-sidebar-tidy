// dsh-sidebar-tidy 自测：纯逻辑 + 模块形状。 node selftest.mjs
import { readFileSync, statSync } from 'node:fs'
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) }, localStorage: undefined }
new Function('window', readFileSync(new URL('./client.js', import.meta.url), 'utf8'))(globalThis.window)
if (loaded.length !== 1) throw new Error('client.js 应当自注册一个模块')
const definition = loaded[0]
if (definition.id !== 'dsh-sidebar-tidy') throw new Error('module id 不对: ' + definition.id)

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
}
const mod = definition.factory((id) => {
  if (id === 'react') return ReactStub
  throw new Error('未预期的 require: ' + id)
})

let failed = 0
const check = (label, ok, detail) => {
  console.log((ok ? 'OK ' : 'FAIL ') + label + (ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
  if (!ok) failed += 1
}

check('inject', JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale', 'layout']), mod.inject)
check('version 与 DSH 一致', mod.version === '0.2.2-rc.3', mod.version)
check('KEEP 默认五个面板', Array.isArray(mod.KEEP) && mod.KEEP.length === 5, mod.KEEP)

// —— 打包融合：better-sidebar 作为依赖 + 同 patch 挂载 ——
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
check('依赖 dsh-better-sidebar@0.32.1', pkg.dependencies?.['dsh-better-sidebar'] === '0.32.1',
  pkg.dependencies?.['dsh-better-sidebar'])
check('patch 同时挂载 better-sidebar', /- id:\s*better-sidebar[\s\S]*?name:\s*['"]?dsh-better-sidebar/.test(patch)
  && /disabled:\s*!!js/.test(patch))

// —— 插件六件套：中文名/简介/detail/图标/资源/日志配置 ——
const zh = JSON.parse(readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('./locale/en.json', import.meta.url), 'utf8'))
const zhDetail = readFileSync(new URL('./docs/zh.md', import.meta.url), 'utf8')
const enDetail = readFileSync(new URL('./docs/en.md', import.meta.url), 'utf8')
check('locale 中文名/简介/detail', typeof zh.meta?.title === 'string' && zh.meta.title !== ''
  && typeof zh.meta.description === 'string' && zh.meta.description !== ''
  && zh.meta.detail === 'docs/zh.md' && en.meta?.detail === 'docs/en.md', { zh: zh.meta, en: en.meta })
check('detail 首行 900×400 预览图', /^!\[[^\]]*\]\(\/assets\/preview\.svg\)/u.test(zhDetail)
  && /^!\[[^\]]*\]\(\/assets\/preview\.svg\)/u.test(enDetail))
check('icon 与 exports 齐全', pkg.icon === './icon.svg' && statSync(new URL('./icon.svg', import.meta.url)).size <= 256 * 1024
  && pkg.exports?.['./package.json'] === './package.json'
  && pkg.exports?.['./locale/zh.json'] === './locale/zh.json'
  && pkg.exports?.['./locale/en.json'] === './locale/en.json')
check('patch 带 logDir 配置', /config:\s*[\r\n]+\s*logDir:\s*['"]?D:\/DSH-plugins\/log\/dsh-sidebar-tidy/.test(patch))
check('日志 2 MiB 轮转且保留 5 份', /maxFileBytes:\s*2097152/.test(patch)
  && /const MAX_BACKUPS = 5/u.test(readFileSync(new URL('./index.js', import.meta.url), 'utf8')))

// —— 金丝雀六条行为（常量 / 健康 / 冷启动 / 漂移 / 幂等 / 抖动）——
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const canaryLimitMatch = /const CANARY_MISS_LIMIT = (\d+)/u.exec(source)
const canaryTickMatch = /const CANARY_TICK_MS = (\d+)/u.exec(source)
const canaryLimit = canaryLimitMatch === null ? -1 : Number(canaryLimitMatch[1])
const canaryTick = canaryTickMatch === null ? -1 : Number(canaryTickMatch[1])
check('canary 常量 40 / 250ms', canaryLimit === 40 && canaryTick === 250
  && mod.CANARY_MISS_LIMIT === canaryLimit && mod.CANARY_TICK_MS === canaryTick,
{ canaryLimit, canaryTick })

const healthyGuard = mod.createCanaryGuard(canaryLimit, () => { throw new Error('healthy must not trip') })
for (let index = 0; index < canaryLimit + 20; index += 1) healthyGuard.step(3)
check('canary 健康不触发', healthyGuard.state().tripped === false && healthyGuard.state().armed === true,
  healthyGuard.state())

const coldGuard = mod.createCanaryGuard(canaryLimit, () => { throw new Error('cold start must not trip') })
for (let index = 0; index < canaryLimit + 20; index += 1) coldGuard.step(0)
const coldState = coldGuard.state()
coldGuard.step(3)
check('canary 冷启动不触发', coldState.tripped === false && coldState.misses === 0
  && coldState.armed === false && coldGuard.state().armed === true, { coldState, after: coldGuard.state() })

const driftTrips = []
const driftGuard = mod.createCanaryGuard(canaryLimit, reason => driftTrips.push(reason))
driftGuard.step(3)
for (let index = 0; index < canaryLimit; index += 1) driftGuard.step(0)
check('canary 漂移触发并告警', driftTrips.length === 1
  && /markedColumnCount=0/u.test(driftTrips[0]) && new RegExp(`limit ${canaryLimit}`, 'u').test(driftTrips[0]),
{ trips: driftTrips, state: driftGuard.state() })
for (let index = 0; index < canaryLimit * 3; index += 1) driftGuard.step(0)
check('canary 幂等只告警一次', driftTrips.length === 1, { trips: driftTrips.length, state: driftGuard.state() })

const jitterTrips = []
const jitterGuard = mod.createCanaryGuard(canaryLimit, reason => jitterTrips.push(reason))
jitterGuard.step(3)
for (let index = 0; index < Math.floor(canaryLimit / 2); index += 1) jitterGuard.step(0)
jitterGuard.step(3)
for (let index = 0; index < canaryLimit * 3; index += 1) {
  jitterGuard.step(index % 5 === 4 ? 3 : 0)
}
check('canary 抖动不自杀', jitterTrips.length === 0 && jitterGuard.state().tripped === false,
{ trips: jitterTrips.length, state: jitterGuard.state() })

const partialGuard = mod.createCanaryGuard(canaryLimit, () => { throw new Error('partial loss must not trip') })
partialGuard.step(3)
for (let index = 0; index < canaryLimit * 2; index += 1) partialGuard.step(1)
check('canary 少一列不自杀', partialGuard.state().tripped === false && partialGuard.state().misses === 0,
  partialGuard.state())

// —— 排序：持久化顺序优先，其余按 order/label ——
const rows = [
  { id: 'a', label: 'A', order: 0 },
  { id: 'b', label: 'B', order: 1 },
  { id: 'c', label: 'C', order: 2 },
  { id: 'd', label: 'D', order: 3 },
]
const sorted = mod.sortRows(rows, ['c', 'a'])
check('sortRows 已存顺序优先', sorted.map((r) => r.id).join('') === 'cabd', sorted.map((r) => r.id))

// —— 拖拽重排 ——
check('reorder 下移', mod.reorder(['a', 'b', 'c'], 0, 2).join('') === 'bca')
check('reorder 上移', mod.reorder(['a', 'b', 'c'], 2, 0).join('') === 'cab')
check('reorder 原位', mod.reorder(['a', 'b', 'c'], 1, 1).join('') === 'abc')
check('reorder 越界', mod.reorder(['a', 'b'], 5, 0).join('') === 'ab')

// —— 从「更多」拖回侧栏：插入位置 ——
check('moveInto 插到中间', mod.moveInto(['a', 'c'], 'b', 1).join('') === 'abc')
check('moveInto 已存在先摘出', mod.moveInto(['a', 'b', 'c'], 'b', 2).join('') === 'acb')
check('moveInto 越界贴尾', mod.moveInto(['a', 'b'], 'c', 99).join('') === 'abc')
check('moveInto 插到最前', mod.moveInto(['b', 'c'], 'a', 0).join('') === 'abc')

// —— tidy：白名单外取消 pin ——
const calls = []
const panels = ['plugins', 'dsh-market', 'schedules', 'dsh-security', 'skill-explorer'].map((id) => ({ options: { id } }))
const ctx = {
  slots: {
    entriesOfSlot: (name) => (name === 'sidebar' ? [{ inject: () => ({ setPinned: (id, pinned) => calls.push([id, pinned]) }) }] : panels),
    subscribe: () => () => {},
  },
  effect: (fn) => fn(),
}
const want = [
  ['dsh-market', true],
  ['schedules', true],
  ['dsh-security', true],
  ['skill-explorer', true],
]
check('tidy 下发 pin 状态', mod.tidy(ctx) === want.length && want.every(([id, p]) => calls.some(([ci, cp]) => ci === id && cp === p)), calls)

const noneCtx = { slots: { entriesOfSlot: () => [], subscribe: () => () => {} }, effect: (fn) => fn() }
check('tidy 空 slots 安全返回', mod.tidy(noneCtx) === -1)

console.log(failed === 0 ? '全部通过' : failed + ' 项失败')
if (failed !== 0) process.exitCode = 1

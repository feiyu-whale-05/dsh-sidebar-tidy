// dsh-sidebar-tidy 自测：纯逻辑 + 模块形状。 node selftest.mjs
import { readFileSync } from 'node:fs'

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

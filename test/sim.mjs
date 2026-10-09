/**
 * dsh-bite 仿真测试台
 *
 * 假 ctx / 假 fs-safe 临时存储 / 真实事件形状（从真机会话日志采样）驱动：
 * ① 回合提取（真实用户过滤 / 截断预算 / 跳过工具步）
 * ② 钉子存储（落盘 / 去重 / 上限丢最旧 / 解钉 / 跨实例持久）
 * ③ 压缩侦测 + 钉子找回（懒扫描 / 事件监听 / 去重 / 在场不注入 / 子代理豁免）
 * ④ 斜杠命令（pin / pins / unpin）
 * ⑤ HTTP 路由（pins / pin / unpin / fish.webp / 404 / 坏 JSON）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBite, SOURCE_KIND, ROUTE_PREFIX } from '../src/index.mjs'

let passed = 0
const log = (...a) => console.log(...a)
function group(name) {
  log(`\n═══ ${name}`)
}
function ok(msg) {
  passed++
  log(`  ✓ ${msg}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实事件形状（采自真机会话日志）
// ─────────────────────────────────────────────────────────────────────────────

const evUser = {
  type: 'user/message',
  seq: 8,
  data: {
    content: [{ type: 'text', text: '创建文件 tide-e2e.txt，内容为 hello。完成后一句话确认。' }],
    source: { kind: 'user' },
    role: 'user',
    id: 'u-1',
  },
}
const evAssistantTool = {
  type: 'assistant/message',
  seq: 12,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Simple task. Let me do it.' },
        { type: 'tool-call', id: 'call_1', name: 'write', arguments: '{}' },
      ],
      id: 'a-tool',
    },
  },
}
const evInjected = {
  type: 'user/message',
  seq: 13,
  data: {
    content: [{ type: 'text', text: '〔系统注记 · tide 收尾模式〕现在执行优雅暂停收尾。' }],
    source: { kind: 'dsh-tide' },
    role: 'user',
    id: 'inj-1',
  },
}
const evAssistantFinal = {
  type: 'assistant/message',
  seq: 17,
  data: {
    turn: 1,
    step: 2,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '已创建 tide-e2e.txt（内容 hello）。' }],
      id: 'a-final',
    },
  },
}
const evAssistantTool2 = {
  type: 'assistant/message',
  seq: 21,
  data: {
    turn: 2,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_2', name: 'read', arguments: '{}' }],
      id: 'a-tool2',
    },
  },
}
const EVENTS = [evUser, evAssistantTool, evInjected, evAssistantFinal, evAssistantTool2]
const COMPACT_END = { type: 'compaction/end', seq: 40, data: {} }

// ─────────────────────────────────────────────────────────────────────────────
// 假环境
// ─────────────────────────────────────────────────────────────────────────────

function makeSession(id, events, header = {}) {
  return { id, header, snapshotEvents: () => events }
}

function makeEnv({ maxPins = 12, maxPinChars = 2000, storageDir = null } = {}) {
  const dir = storageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bite-sim-'))
  const handlers = {}
  const commands = []
  const routes = []
  const logs = []
  const liveMap = new Map()
  const persistence = {
    // rc.2 版 API：stat 探存在性；open(id, 'read') 拿句柄；handle.read() 取事件；close 必须执行
    stat: async (id) => {
      const session = liveMap.get(id)
      return session === undefined ? undefined : { header: { id }, revision: 'r1' }
    },
    open: async (id) => {
      const session = liveMap.get(id)
      if (session === undefined) throw new Error('session not found')
      return {
        read: async () => ({ events: session.snapshotEvents() }),
        close: async () => {},
      }
    },
  }
  let scopedView = null
  const ctx = {
    logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
    on: (name, fn) => {
      handlers[name] = fn
    },
    effect: (fn) => {
      const r = fn()
      if (r && typeof r.next === 'function') {
        // 生成器 effect：驱动到完成（yield 的值即注册产物）
        let step = r.next()
        while (!step.done) step = r.next(step.value)
      }
      return () => {}
    },
    inject: (_names, cb) => cb(scopedView),
    commands: {
      register: (definition) => {
        commands.push(definition)
        return () => {}
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  // 作用域视图：注入回调拿到的“子 ctx”（含所有服务，与真机一致）
  scopedView = {
    sessions: { get: (id) => liveMap.get(id) },
    sessionPersistence: persistence,
    webServer: ctx.webServer,
    effect: ctx.effect,
    logger: ctx.logger,
    commands: ctx.commands,
  }
  const config = { maxPins, maxPinChars, storageDir: dir }
  const rt = createBite({ ctx, config })
  rt.start()
  return { rt, ctx, handlers, commands, routes, logs, liveMap, storageDir: dir }
}

// ─────────────────────────────────────────────────────────────────────────────
// 假 HTTP req/res
// ─────────────────────────────────────────────────────────────────────────────

function fakeReq({ url, method = 'GET', body = null }) {
  const listeners = {}
  return {
    url,
    method,
    on(ev, cb) {
      ;(listeners[ev] ??= []).push(cb)
      return this
    },
    destroy() {},
    _flush() {
      if (body !== null) for (const cb of listeners.data ?? []) cb(Buffer.from(body))
      for (const cb of listeners.end ?? []) cb()
    },
  }
}

function fakeRes() {
  return {
    status: null,
    headers: null,
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
    json() {
      return JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
    },
  }
}

async function callRoute(rt, req, res) {
  const p = rt._route(req, res)
  if (req.method === 'POST') req._flush()
  await p
  return res
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // ── ① 回合提取 ─────────────────────────────────────────────────────────
  group('① 回合提取')
  {
    const env = makeEnv()
    const turn = env.rt._extractTurn(EVENTS, 'a-final')
    assert.equal(turn.userText, '创建文件 tide-e2e.txt，内容为 hello。完成后一句话确认。')
    ok('回溯到真实用户消息（跳过 dsh-tide 注入）')
    assert.equal(turn.assistantText, '已创建 tide-e2e.txt（内容 hello）。')
    ok('助手回复正文提取正确')

    const lastId = env.rt._lastAssistantMessageId(EVENTS)
    assert.equal(lastId, 'a-final')
    ok('/pin 定位最后一条"有正文"回复（跳过末尾纯工具步）')

    const toolTurn = env.rt._extractTurn(EVENTS, 'a-tool')
    assert.equal(toolTurn.assistantText, '')
    ok('工具步消息无正文时 assistantText 为空串（不抛错）')

    const env2 = makeEnv({ maxPinChars: 20 })
    const t2 = env2.rt._extractTurn(EVENTS, 'a-final')
    assert.ok(t2.userText.endsWith('…') && t2.userText.length <= 8)
    ok('用户文本按 40% 预算截断（maxPinChars=20 → ≤8 字符）')
    assert.ok(t2.assistantText.endsWith('…') && t2.assistantText.length <= 12)
    ok('回复文本按 60% 预算截断（≤12 字符）')

    assert.equal(env.rt._extractTurn(EVENTS, '不存在的id'), null)
    ok('不存在的 messageId → null')
  }

  // ── ② 钉子存储 ─────────────────────────────────────────────────────────
  group('② 钉子存储')
  {
    const env = makeEnv()
    const r1 = env.rt._pinTurn({ sessionId: 'S1', assistantMessageId: 'a-final', events: EVENTS })
    assert.equal(r1.ok, true)
    assert.equal(r1.already, false)
    ok('落钉成功')
    assert.ok(fs.existsSync(path.join(env.storageDir, 'pins.json')))
    ok('pins.json 已落盘')
    const raw = JSON.parse(fs.readFileSync(path.join(env.storageDir, 'pins.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.pins.length, 1)
    ok('文件结构 {version:1, pins:[…]}')

    const r2 = env.rt._pinTurn({ sessionId: 'S1', assistantMessageId: 'a-final', events: EVENTS })
    assert.equal(r2.already, true)
    assert.equal(env.rt._pinsOf('S1').length, 1)
    ok('重复钉同一轮 → already（幂等）')

    const rBad = env.rt._pinTurn({ sessionId: 'S1', assistantMessageId: 'nope', events: EVENTS })
    assert.equal(rBad.ok, false)
    assert.equal(rBad.code, 'target-not-found')
    ok('钉不存在的目标 → target-not-found')

    // 上限丢最旧
    const envCap = makeEnv({ maxPins: 2 })
    const e1 = [...EVENTS]
    const mk = (id, seq) => ({
      type: 'assistant/message',
      seq,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `回复-${id}` }], id } },
    })
    const ev3 = [...e1, mk('a-x', 30), mk('a-y', 31), mk('a-z', 32)]
    const rx = envCap.rt._pinTurn({ sessionId: 'S1', assistantMessageId: 'a-x', events: ev3 })
    const ry = envCap.rt._pinTurn({ sessionId: 'S1', assistantMessageId: 'a-y', events: ev3 })
    const rz = envCap.rt._pinTurn({ sessionId: 'S1', assistantMessageId: 'a-z', events: ev3 })
    assert.equal(rx.ok && ry.ok && rz.ok, true)
    assert.ok(rz.dropped !== null && rz.dropped.assistantMessageId === 'a-x')
    ok('maxPins=2 时第 3 条挤掉最旧（dropped 提示正确）')
    const remain = envCap.rt._pinsOf('S1').map((p) => p.assistantMessageId)
    assert.deepEqual(remain, ['a-y', 'a-z'])
    ok('存储里只剩最新两条（时间序）')

    // 解钉
    const u1 = env.rt._unpinTurn({ sessionId: 'S1', assistantMessageId: 'a-final' })
    assert.equal(u1.removed, 1)
    assert.equal(env.rt._pinsOf('S1').length, 0)
    ok('解钉成功（removed=1）')
    const u2 = env.rt._unpinTurn({ sessionId: 'S1', assistantMessageId: 'a-final' })
    assert.equal(u2.removed, 0)
    ok('解不存在的钉子 → removed=0（幂等）')

    // 跨实例持久
    const envPersist2 = makeEnv({ storageDir: env.storageDir })
    env.rt._pinTurn({ sessionId: 'S9', assistantMessageId: 'a-final', events: EVENTS })
    const seen = envPersist2.rt._pinsOf('S9')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].assistantText, '已创建 tide-e2e.txt（内容 hello）。')
    ok('新实例（模拟重启）从同一存储读回钉子')
  }

  // ── ③ 压缩侦测 + 钉子找回 ──────────────────────────────────────────────
  group('③ 压缩侦测 + 钉子找回')
  {
    // 懒扫描路径
    const env = makeEnv()
    env.rt._pinTurn({ sessionId: 'S1', assistantMessageId: 'a-final', events: EVENTS })
    const session = makeSession('S1', [...EVENTS, COMPACT_END])
    const payload = { agent: { session }, messages: [{ id: 'other-1' }] }
    const d1 = env.rt._decideDigest(payload)
    assert.ok(d1 !== null)
    assert.equal(d1.source.kind, SOURCE_KIND)
    assert.equal(d1.source.subtype, 'digest')
    ok('懒扫描发现历史压缩 → 生成找回注记（source.kind=dsh-bite, subtype=digest）')
    const text = d1.content[0].text
    assert.ok(text.includes('钉子 1') && text.includes('已创建 tide-e2e.txt'))
    assert.ok(text.includes('当时用户') && text.includes('创建文件 tide-e2e.txt'))
    ok('注记包含用户提问 + 当时回复全文')

    const d2 = env.rt._decideDigest(payload)
    assert.equal(d2, null)
    ok('同一压缩只找回一次（已消化 → null）')

    // 事件监听路径：新压缩
    env.handlers['session/event'](session, { type: 'compaction/end', seq: 50 })
    const d3 = env.rt._decideDigest(payload)
    assert.ok(d3 !== null)
    ok('监听 session/event 捕获新压缩 → 再次找回')

    // 在场不注入
    const envK = makeEnv()
    envK.rt._pinTurn({ sessionId: 'SK', assistantMessageId: 'a-final', events: EVENTS })
    const sessionK = makeSession('SK', [...EVENTS, COMPACT_END])
    envK.rt._observeSessionEvent(sessionK, { type: 'compaction/end', seq: 40 })
    const dk = envK.rt._decideDigest({ agent: { session: sessionK }, messages: [{ id: 'a-final' }] })
    assert.equal(dk, null)
    ok('钉子消息仍在请求面（未被 shadow）→ 不注入')

    // 无压缩
    const envN = makeEnv()
    envN.rt._pinTurn({ sessionId: 'SN', assistantMessageId: 'a-final', events: EVENTS })
    const sessionN = makeSession('SN', EVENTS)
    const dn = envN.rt._decideDigest({ agent: { session: sessionN }, messages: [{ id: 'x' }] })
    assert.equal(dn, null)
    ok('没有压缩 → 不注入')

    // 无钉子
    const envZ = makeEnv()
    const sessionZ = makeSession('SZ', [...EVENTS, COMPACT_END])
    const dz = envZ.rt._decideDigest({ agent: { session: sessionZ }, messages: [] })
    assert.equal(dz, null)
    ok('没有钉子 → 不注入')

    // 子代理豁免
    const envSub = makeEnv()
    envSub.rt._pinTurn({ sessionId: 'SS', assistantMessageId: 'a-final', events: EVENTS })
    const sessionSub = makeSession('SS', [...EVENTS, COMPACT_END], { origin: 'subagent' })
    const dsub = envSub.rt._decideDigest({ agent: { session: sessionSub }, messages: [] })
    assert.equal(dsub, null)
    ok('子代理会话豁免')

    // pre-step 处理器整体（放行时把注记追加进 messages）
    const envP = makeEnv()
    envP.rt._pinTurn({ sessionId: 'SP', assistantMessageId: 'a-final', events: EVENTS })
    const sessionP = makeSession('SP', [...EVENTS, COMPACT_END])
    const next = async () => ({ kind: 'enter', messages: [{ id: 'm1' }] })
    const decision = await envP.handlers['agent/pre-step']({ agent: { session: sessionP }, messages: [] }, next)
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    assert.equal(decision.messages[1].source.subtype, 'digest')
    ok('pre-step 放行时注记追加到 decision.messages（原消息保留）')
  }

  // ── ④ 斜杠命令 ─────────────────────────────────────────────────────────
  group('④ 斜杠命令')
  {
    const env = makeEnv()
    const session = makeSession('S1', EVENTS)
    env.liveMap.set('S1', session)
    const inv = { agent: { session }, rawInput: '', signal: undefined }

    const rPin = await env.rt._commands.pin(inv)
    assert.equal(rPin.kind, 'success')
    assert.ok(rPin.text.includes('已咬钩'))
    ok('/pin 钉住最近一轮（成功文案）')

    const rPins = await env.rt._commands.pins(inv)
    assert.equal(rPins.kind, 'success')
    assert.ok(rPins.text.includes('1 条') && rPins.text.includes('用户：创建文件'))
    ok('/pins 列出钉子（含内容摘要）')

    const rAgain = await env.rt._commands.pin(inv)
    assert.ok(rAgain.text.includes('已经咬过钩'))
    ok('/pin 重复 → 提示已钉过')

    const rOut = await env.rt._commands.unpin({ ...inv, rawInput: '1' })
    assert.equal(rOut.kind, 'success')
    ok('/unpin 1 按序号解钉')

    const rEmpty = await env.rt._commands.unpin(inv)
    assert.equal(rEmpty.kind, 'error')
    ok('空列表时 /unpin → 报错（没有可解的钉子）')

    await env.rt._commands.pin(inv)
    const rRange = await env.rt._commands.unpin({ ...inv, rawInput: '9' })
    assert.equal(rRange.kind, 'error')
    assert.ok(rRange.text.includes('超范围'))
    ok('/unpin 序号越界 → 报错')
    const rUsage = await env.rt._commands.unpin({ ...inv, rawInput: 'abc' })
    assert.ok(rUsage.text.includes('用法'))
    ok('/unpin 非法参数 → 用法提示')

    const cmdNames = env.commands.map((c) => c.name)
    assert.deepEqual(cmdNames, ['pin', 'pins', 'unpin'])
    ok('三个命令注册到 commands 服务')
  }

  // ── ⑤ HTTP 路由 ───────────────────────────────────────────────────────
  group('⑤ HTTP 路由')
  {
    const env = makeEnv()
    const session = makeSession('S1', EVENTS)
    env.liveMap.set('S1', session)

    // POST /pin（活会话路径）
    let res = await callRoute(
      env.rt,
      fakeReq({ url: `${ROUTE_PREFIX}/pin`, method: 'POST', body: JSON.stringify({ sessionId: 'S1', messageId: 'a-final' }) }),
      fakeRes(),
    )
    const j1 = res.json()
    assert.equal(j1.ok, true)
    assert.equal(j1.already, false)
    ok('POST /pin 活会话 → 落钉成功')

    // GET /pins
    res = await callRoute(env.rt, fakeReq({ url: `${ROUTE_PREFIX}/pins?session=S1` }), fakeRes())
    const j2 = res.json()
    assert.equal(j2.ok, true)
    assert.equal(j2.pins.length, 1)
    assert.equal(j2.pins[0].assistantMessageId, 'a-final')
    ok('GET /pins?session=S1 → 返回钉子列表')

    // POST /unpin
    res = await callRoute(
      env.rt,
      fakeReq({ url: `${ROUTE_PREFIX}/unpin`, method: 'POST', body: JSON.stringify({ sessionId: 'S1', messageId: 'a-final' }) }),
      fakeRes(),
    )
    assert.equal(res.json().removed, 1)
    ok('POST /unpin → 解钉')

    // 活会话缺失 → 持久化回退（fake persistence 用 liveMap，所以删除 live 后 inspect 抛错）
    env.liveMap.delete('S1')
    res = await callRoute(
      env.rt,
      fakeReq({ url: `${ROUTE_PREFIX}/pin`, method: 'POST', body: JSON.stringify({ sessionId: 'S1', messageId: 'a-final' }) }),
      fakeRes(),
    )
    const j4 = res.json()
    assert.equal(j4.ok, false)
    assert.equal(j4.code, 'session-not-found')
    ok('会话不存在（持久化也查不到）→ session-not-found')

    // fish.webp
    res = await callRoute(env.rt, fakeReq({ url: `${ROUTE_PREFIX}/fish.webp` }), fakeRes())
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'image/webp')
    assert.ok(res.chunks[0].length > 10000)
    ok(`GET /fish.webp → 200 image/webp（${res.chunks[0].length} 字节）`)

    // 404
    res = await callRoute(env.rt, fakeReq({ url: `${ROUTE_PREFIX}/nope` }), fakeRes())
    assert.equal(res.status, 404)
    ok('未知子路径 → 404')

    // 坏 JSON
    res = await callRoute(env.rt, fakeReq({ url: `${ROUTE_PREFIX}/pin`, method: 'POST', body: '{bad' }), fakeRes())
    assert.equal(res.status, 400)
    ok('POST 坏 JSON → 400')

    // health
    res = await callRoute(env.rt, fakeReq({ url: `${ROUTE_PREFIX}/health` }), fakeRes())
    assert.equal(res.json().name, SOURCE_KIND)
    ok('GET /health → 服务信息')

    // 路由已注册（前缀）
    assert.equal(env.routes.length, 1)
    assert.equal(env.routes[0].kind, 'prefix')
    assert.equal(env.routes[0].path, ROUTE_PREFIX)
    ok('webServer 注册 prefix 路由')

    // pre-step 与 session/event 已挂钩
    assert.ok(typeof env.handlers['agent/pre-step'] === 'function')
    assert.ok(typeof env.handlers['session/event'] === 'function')
    ok('agent/pre-step 与 session/event 钩子就位')
  }

  log(`\n全部通过：${passed} 项断言`)
  process.exit(0)
}

main().catch((error) => {
  console.error('\n✗ 断言失败：')
  console.error(error)
  process.exit(1)
})

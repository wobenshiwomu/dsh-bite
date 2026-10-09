/**
 * dsh-bite — 咬钩：钉住的内容，压缩也带不走。
 *
 * 面向 DeepSeek Harness 的插件：用户把关键回合（提问 + 回复打包成一条"钉子"）
 * 钉住；当上下文压缩（compaction）把这段历史冲掉之后，插件在下一个模型请求
 * 前自动把钉子内容"找回并重注入"，让被压缩冲走的背景回到模型眼前。
 *
 * 三个入口（同一套钉子内核）：
 *  - Web UI：每条助手回复旁的钉子按钮（绿/红），点击落钉/解钉；
 *    落钉时客户端播放"肥鱼掠食"动画（纯粹表演，数据先行）。
 *  - 斜杠命令：/pin（钉最近一轮）/ /pins（列出）/ /unpin [序号]（解钉）。
 *  - HTTP（本机）：GET /dsh-bite/pins、POST /dsh-bite/pin|unpin、
 *    GET /dsh-bite/fish.webp（动画素材）。
 *
 * 机制基础（全部已在本机 DSH 源码/真机验证）：
 *  - 压缩完成会向会话日志 append `compaction/end` 事件；插件通过
 *    `ctx.on('session/event', (session, event) => …)` 观察（官方包同款用法）。
 *  - 重注入走 `agent/pre-step`：在决策放行时把注记追加进 decision.messages
 *    （dsh-tide 同款骨架，不需要 surfaceOp —— 那是"回合外 append"才需要的）。
 *  - 钉住内容从持久化会话日志提取：助手消息按 messageId 定位，向前回溯到
 *    最近一条"真实用户消息"（source.kind === 'user'；插件注入的消息都带
 *    各自 kind，天然可排除）。
 *  - 存储：$DSH_HOME/storages/dsh-bite/pins.json，写临时文件 + rename 原子替换
 *    （跨进程可读；读新写旧不撕裂）。
 *
 * @module dsh-bite
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'

export const name = 'dsh-bite'
// webServer 刻意不放进顶层 inject：headless 等没有 web 服务的几何下，
// 强依赖会让整个插件卡在 pending（实测）。路由改为就绪后再挂。
export const inject = ['commands']

export const Config = Schema.object({
  maxPins: Schema.number().default(12).description('每个会话最多钉子数：超出后丢最旧的一条（并在响应里提示）'),
  maxPinChars: Schema.number().default(0).description('每条钉子的字符预算：0=完整保留原文（默认）；>0=按预算截断（用户原话 40% / 回复 60%）'),
  storageDir: Schema.string().default('').description('钉子存储目录（默认 $DSH_HOME/storages/dsh-bite）'),
})

export const SOURCE_KIND = 'dsh-bite'
export const ROUTE_PREFIX = '/dsh-bite'
const PINS_VERSION = 1
/** 随包分发的肥鱼动画素材（webp，透明通道）。 */
const FISH_PATH = fileURLToPath(new URL('../assets/fish.webp', import.meta.url))

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 提取消息的全部文本块，换行拼接。 */
function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim()
}

/** 截断到 max 个字符，加省略号。 */
function truncate(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 移除 undefined 字段：会话日志要求无损 JSON。 */
function cleanMeta(meta) {
  const out = {}
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** bite 注记的 source（浅校验、原样保留的天然审计槽位）。 */
function biteSource(subtype, meta) {
  return { kind: SOURCE_KIND, subtype, bite: cleanMeta(meta) }
}

/** 子代理会话不参与钉子重注入（它们有自己的上下文生命周期）。 */
function isSubagentSession(session) {
  const header = session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

export function createBite({ ctx, config, deps = {} }) {
  const fsImpl = deps.fs ?? fs
  const env = deps.env ?? process.env
  const homeDir = deps.homeDir ?? os.homedir()

  const storageDir = config.storageDir !== '' && config.storageDir !== undefined
    ? config.storageDir
    : path.join(env.DSH_HOME ?? path.join(homeDir, '.dsh'), 'storages', 'dsh-bite')
  const pinsFile = path.join(storageDir, 'pins.json')

  /** 懒注入的服务：sessions / sessionPersistence（路由按会话 id 读取日志用）。 */
  let svc = {}

  // —— 钉子存储（读新写旧，tmp + rename 原子替换） ——

  function loadPins() {
    try {
      const data = JSON.parse(fsImpl.readFileSync(pinsFile, 'utf8'))
      return Array.isArray(data?.pins) ? data.pins : []
    } catch {
      return []
    }
  }

  function savePins(pins) {
    try {
      fsImpl.mkdirSync(storageDir, { recursive: true })
      const tmp = `${pinsFile}.tmp`
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: PINS_VERSION, pins }, null, 2))
      fsImpl.renameSync(tmp, pinsFile)
      return true
    } catch (error) {
      ctx.logger.warn(`[dsh-bite] 钉子落盘失败: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function pinsOf(sessionId) {
    return loadPins()
      .filter((p) => p?.sessionId === sessionId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  // —— 回合内容提取 ——

  /**
   * 从会话事件流中提取"被钉的那一轮"：按 assistantMessageId 定位助手消息
   * （取最后一条匹配——replacement 语义下旧副本可能仍在日志里），向前回溯
   * 最近一条真实用户消息（source.kind === 'user'）。
   */
  function extractTurn(events, assistantMessageId) {
    if (!Array.isArray(events)) return null
    // maxPinChars: 0（默认）= 完整保留原文，不截断；>0 才按预算截断
    const limit = Number.isFinite(config.maxPinChars) && config.maxPinChars > 0 ? Math.floor(config.maxPinChars) : 0
    const userBudget = limit > 0 ? Math.max(1, Math.floor(limit * 0.4)) : 0
    const assistantBudget = limit > 0 ? Math.max(1, limit - userBudget) : 0

    let targetIndex = -1
    let targetMessage = null
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e?.type !== 'assistant/message') continue
      let msg
      try {
        msg = deriveEventMessage(e)
      } catch {
        continue
      }
      if (msg?.role === 'assistant' && msg.id === assistantMessageId) {
        targetIndex = i
        targetMessage = msg
      }
    }
    if (targetMessage === null) return null

    let userText = ''
    for (let j = targetIndex - 1; j >= 0; j--) {
      const e = events[j]
      if (e?.type !== 'user/message') continue
      if (e?.data?.source?.kind !== 'user') continue
      let msg
      try {
        msg = deriveEventMessage(e)
      } catch {
        continue
      }
      if (msg?.role !== 'user') continue
      userText = messageText(msg)
      break
    }

    return {
      userText: limit > 0 ? truncate(userText, userBudget) : userText,
      assistantText: limit > 0 ? truncate(messageText(targetMessage), assistantBudget) : messageText(targetMessage),
    }
  }

  /** 从事件流取最后一条"有正文"的助手消息 id（跳过纯工具调用/推理步；/pin 命令用）。 */
  function lastAssistantMessageId(events) {
    if (!Array.isArray(events)) return null
    let id = null
    for (const e of events) {
      if (e?.type !== 'assistant/message') continue
      let msg
      try {
        msg = deriveEventMessage(e)
      } catch {
        continue
      }
      if (msg?.role !== 'assistant' || typeof msg.id !== 'string') continue
      if (messageText(msg) !== '') id = msg.id
    }
    return id
  }

  // —— 钉 / 解钉核心 ——

  function pinTurn({ sessionId, assistantMessageId, events }) {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'bad-session' }
    if (typeof assistantMessageId !== 'string' || assistantMessageId === '') return { ok: false, code: 'bad-target' }
    const turn = extractTurn(events, assistantMessageId)
    if (turn === null) return { ok: false, code: 'target-not-found' }

    const pins = loadPins()
    const existing = pins.find((p) => p.sessionId === sessionId && p.assistantMessageId === assistantMessageId)
    if (existing !== undefined) {
      return { ok: true, already: true, pin: { id: existing.id, assistantMessageId, createdAt: existing.createdAt } }
    }

    const now = Date.now()
    const pin = {
      id: randomUUID(),
      sessionId,
      assistantMessageId,
      userText: turn.userText,
      assistantText: turn.assistantText,
      createdAt: now,
    }

    // 每会话上限：超出丢最旧（在响应里提示）
    const mine = pins
      .filter((p) => p.sessionId === sessionId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    let dropped = null
    while (mine.length >= config.maxPins) dropped = mine.shift()
    const keep = new Set(mine.map((p) => p.id))
    const next = pins.filter((p) => p.sessionId !== sessionId || keep.has(p.id))
    next.push(pin)

    if (!savePins(next)) return { ok: false, code: 'save-failed' }
    return {
      ok: true,
      already: false,
      pin: { id: pin.id, assistantMessageId, createdAt: now },
      dropped: dropped === null ? null : { assistantMessageId: dropped.assistantMessageId, createdAt: dropped.createdAt },
      count: mine.length + 1,
    }
  }

  function unpinTurn({ sessionId, assistantMessageId }) {
    const pins = loadPins()
    const next = pins.filter(
      (p) => !(p.sessionId === sessionId && p.assistantMessageId === assistantMessageId),
    )
    if (next.length === pins.length) return { ok: true, removed: 0 }
    if (!savePins(next)) return { ok: false, code: 'save-failed' }
    return { ok: true, removed: pins.length - next.length }
  }

  // —— 压缩侦测 + 钉子找回（重注入） ——

  /** sessionId → 最近一次 compaction/end 事件的 seq。 */
  const lastCompactionSeq = new Map()
  /** sessionId → 已被消化（重注入过）的 compaction seq。 */
  const digestedSeq = new Map()
  /** 已做过日志懒扫描的会话（进程重启后每次会话一次）。 */
  const scannedSessions = new Set()

  /** 观察会话事件：记录压缩完成。 */
  function observeSessionEvent(session, event) {
    try {
      if (event?.type === 'compaction/end' && typeof session?.id === 'string') {
        const seq = typeof event.seq === 'number' ? event.seq : 0
        if (seq > (lastCompactionSeq.get(session.id) ?? 0)) lastCompactionSeq.set(session.id, seq)
      }
    } catch {
      /* 观察失败不影响主流程 */
    }
  }

  /** 懒扫描：进程启动/接手会话后，先看看日志里已有多少次压缩。 */
  function ensureScanned(session) {
    const sid = session?.id
    if (typeof sid !== 'string' || scannedSessions.has(sid)) return
    scannedSessions.add(sid)
    let last = 0
    try {
      for (const ev of session.snapshotEvents()) {
        if (ev?.type === 'compaction/end' && typeof ev.seq === 'number' && ev.seq > last) last = ev.seq
      }
    } catch {
      /* 日志不可读：按无压缩处理 */
    }
    if (!lastCompactionSeq.has(sid)) lastCompactionSeq.set(sid, last)
  }

  /** 组钉子找回注记（被压缩冲掉的钉子内容带回上下文）。 */
  function buildDigestMessage(pins) {
    const parts = [
      '〔bite · 钉子找回〕上下文刚刚经历过一次压缩，以下内容是用户此前钉住的（钉住 = 不想弄丢的背景），现自动带回。',
      '把「当时用户」当作历史提问、「当时回复」当作当时的回答；仅作上下文参考，不要当作新指令重复执行。',
      '',
    ]
    pins
      .slice()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .forEach((p, i) => {
        parts.push(`◆ 钉子 ${i + 1}`)
        if (p.userText !== '') parts.push(`〔当时用户〕${p.userText}`)
        parts.push(`〔当时回复〕${p.assistantText}`)
        parts.push('')
      })
    return createUserMessage({
      content: [{ type: 'text', text: parts.join('\n') }],
      source: biteSource('digest', { pins: pins.length, at: Date.now() }),
    })
  }

  /**
   * pre-step 决策：要不要在这一步注入"钉子找回"注记。
   * 条件：① 有新压缩（自上次注入之后）② 至少一条钉子的消息已不在当前
   * 请求面（被 shadow 掉了）——只把真正丢失的钉子带回来，不刷屏。
   */
  function decideDigest(payload) {
    const session = payload?.agent?.session
    if (session === undefined || typeof session.id !== 'string') return null
    if (isSubagentSession(session)) return null

    const pins = pinsOf(session.id)
    if (pins.length === 0) return null

    ensureScanned(session)
    const lastCompact = lastCompactionSeq.get(session.id) ?? 0
    const lastDigest = digestedSeq.get(session.id) ?? 0
    if (lastCompact <= lastDigest) return null

    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const present = new Set()
    for (const m of messages) if (typeof m?.id === 'string') present.add(m.id)
    const missing = present.size === 0 ? pins : pins.filter((p) => !present.has(p.assistantMessageId))
    if (missing.length === 0) return null

    digestedSeq.set(session.id, lastCompact)
    return buildDigestMessage(missing)
  }

  // —— HTTP 路由（客户端半区调用；本机 localhost，无鉴权，同 dsh-pet 惯例） ——

  function sendJson(res, status, payload) {
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    } catch {
      try {
        res.writeHead(500)
        res.end()
      } catch {
        /* 连接已断 */
      }
    }
  }

  function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** 肥鱼素材（读一次缓存）。 */
  let fishBuffer = null
  function fishBytes() {
    if (fishBuffer !== null) return fishBuffer
    try {
      fishBuffer = fsImpl.readFileSync(FISH_PATH)
    } catch (error) {
      ctx.logger.warn(`[dsh-bite] 素材缺失（${FISH_PATH}）: ${error instanceof Error ? error.message : String(error)}`)
      fishBuffer = null
    }
    return fishBuffer
  }

  /** 解析会话的事件流：活会话直接快照，否则走持久化目录。 */
  async function resolveEvents(sessionId) {
    const live = svc.sessions?.get?.(sessionId)
    if (live !== undefined) {
      try {
        return { ok: true, events: live.snapshotEvents() }
      } catch (error) {
        return { ok: false, code: 'session-unreadable', message: String(error?.message ?? error) }
      }
    }
    const persistence = svc.sessionPersistence
    if (persistence === undefined) return { ok: false, code: 'no-persistence' }
    try {
      // 与官方 dsh-message-feedback 同款（rc.2 版 API）：stat 探存在性，
      // open(id, 'read') 拿句柄，read() 取事件，close 必须执行。
      const snapshot = await persistence.stat(sessionId)
      if (snapshot === undefined) return { ok: false, code: 'session-not-found' }
      const handle = await persistence.open(sessionId, 'read')
      try {
        const { events } = await handle.read()
        if (Array.isArray(events)) return { ok: true, events }
        return { ok: false, code: 'session-unreadable' }
      } finally {
        await handle.close()
      }
    } catch (error) {
      ctx.logger.warn(`[dsh-bite] 读取会话失败(${sessionId}): ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, code: 'session-not-found' }
    }
  }

  async function routeHandler(req, res) {
    try {
      const url = new URL(req.url ?? ROUTE_PREFIX, 'http://localhost')
      const route = url.pathname

      if (route === `${ROUTE_PREFIX}/fish.webp`) {
        const buf = fishBytes()
        if (buf === null) return sendJson(res, 404, { ok: false, code: 'asset-missing' })
        res.writeHead(200, {
          'content-type': 'image/webp',
          'content-length': buf.length,
          'cache-control': 'public, max-age=86400',
        })
        res.end(buf)
        return
      }

      if (route === `${ROUTE_PREFIX}/pins` && req.method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        const pins = pinsOf(sessionId).map((p) => ({
          id: p.id,
          assistantMessageId: p.assistantMessageId,
          createdAt: p.createdAt,
        }))
        return sendJson(res, 200, { ok: true, pins })
      }

      if (route === `${ROUTE_PREFIX}/pin` && req.method === 'POST') {
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return sendJson(res, 400, { ok: false, code: 'bad-json' })
        }
        const resolved = await resolveEvents(String(body.sessionId ?? ''))
        if (!resolved.ok) return sendJson(res, 200, resolved)
        const result = pinTurn({
          sessionId: String(body.sessionId ?? ''),
          assistantMessageId: String(body.messageId ?? ''),
          events: resolved.events,
        })
        return sendJson(res, result.ok ? 200 : 200, result)
      }

      if (route === `${ROUTE_PREFIX}/unpin` && req.method === 'POST') {
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return sendJson(res, 400, { ok: false, code: 'bad-json' })
        }
        const result = unpinTurn({
          sessionId: String(body.sessionId ?? ''),
          assistantMessageId: String(body.messageId ?? ''),
        })
        return sendJson(res, 200, result)
      }

      if (route === `${ROUTE_PREFIX}/health`) {
        return sendJson(res, 200, { ok: true, name: SOURCE_KIND, pins: loadPins().length })
      }

      return sendJson(res, 404, { ok: false, code: 'not-found' })
    } catch (error) {
      ctx.logger.warn(`[dsh-bite] 路由失败: ${error instanceof Error ? error.message : String(error)}`)
      return sendJson(res, 500, { ok: false, code: 'internal' })
    }
  }

  // —— 斜杠命令 ——

  function fmtTime(ts) {
    try {
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    } catch {
      return '?'
    }
  }

  function lineOf(pin, index) {
    const u = truncate(String(pin.userText ?? '').replace(/\s+/g, ' '), 42)
    const a = truncate(String(pin.assistantText ?? '').replace(/\s+/g, ' '), 42)
    return `${index}. [${fmtTime(pin.createdAt)}] 用户：${u === '' ? '（无）' : u} ｜ 回复：${a}`
  }

  async function cmdPin(invocation) {
    const session = invocation?.agent?.session
    if (session === undefined || typeof session.id !== 'string') {
      return { kind: 'error', text: 'bite：没有活跃会话，钉不了。' }
    }
    let events
    try {
      events = session.snapshotEvents()
    } catch {
      return { kind: 'error', text: 'bite：读不到会话日志。' }
    }
    const messageId = lastAssistantMessageId(events)
    if (messageId === null) return { kind: 'error', text: 'bite：这一段还没有可钉的回复。' }
    const result = pinTurn({ sessionId: session.id, assistantMessageId: messageId, events })
    if (!result.ok) return { kind: 'error', text: `bite：钉失败（${result.code}）。` }
    if (result.already === true) return { kind: 'success', text: 'bite：这一轮已经咬过钩了。' }
    const extra = result.dropped !== null ? '（超出上限，最旧的一条被替换）' : ''
    return {
      kind: 'success',
      text: `bite：已咬钩，最近一轮钉住了（本会话共 ${result.count ?? '?'} 条）。压缩也带不走它了。${extra}`,
      sourceEventSeq: undefined,
    }
  }

  async function cmdPins(invocation) {
    const session = invocation?.agent?.session
    if (session === undefined || typeof session.id !== 'string') {
      return { kind: 'error', text: 'bite：没有活跃会话。' }
    }
    const pins = pinsOf(session.id)
    if (pins.length === 0) {
      return { kind: 'success', text: 'bite：本会话还没有钉子。点消息旁的钉子按钮，或 /pin 钉住最近一轮。' }
    }
    const lines = pins.map((p, i) => lineOf(p, i + 1))
    return { kind: 'success', text: `bite：本会话钉子 ${pins.length} 条（压缩后会找回）：\n${lines.join('\n')}` }
  }

  const UNPIN_USAGE = 'bite 用法：/unpin（解最新一条）或 /unpin <序号>（见 /pins）。'

  async function cmdUnpin(invocation) {
    const session = invocation?.agent?.session
    if (session === undefined || typeof session.id !== 'string') {
      return { kind: 'error', text: 'bite：没有活跃会话。' }
    }
    const pins = pinsOf(session.id)
    if (pins.length === 0) return { kind: 'error', text: 'bite：本会话没有可解的钉子。' }
    const raw = String(invocation?.rawInput ?? '').trim()
    let target
    if (raw === '') {
      target = pins[pins.length - 1]
    } else if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      if (n < 1 || n > pins.length) return { kind: 'error', text: `bite：序号超范围（1-${pins.length}）。` }
      target = pins[n - 1]
    } else {
      return { kind: 'error', text: UNPIN_USAGE }
    }
    const result = unpinTurn({ sessionId: session.id, assistantMessageId: target.assistantMessageId })
    if (!result.ok) return { kind: 'error', text: `bite：解钉失败（${result.code}）。` }
    return { kind: 'success', text: `bite：吐出来了，解掉 1 条（剩 ${pins.length - 1} 条）。` }
  }

  // —— 装配 ——

  function start() {
    // 压缩侦测
    ctx.on('session/event', observeSessionEvent)

    // 重注入（pre-step：放行时把钉子找回注记追加进请求面）
    ctx.on('agent/pre-step', async (payload, next) => {
      let digest
      try {
        digest = decideDigest(payload)
      } catch (error) {
        ctx.logger.warn(`[dsh-bite] 找回判定失败（放行）: ${error instanceof Error ? error.message : String(error)}`)
        digest = null
      }
      const decision = await next()
      if (digest !== null && decision?.kind === 'enter' && Array.isArray(decision.messages)) {
        return { ...decision, messages: [...decision.messages, digest] }
      }
      return decision
    })

    // HTTP 路由（客户端半区 + 素材）——webServer 可选：headless 等几何下不存在，跳过即可
    try {
      ctx.inject(['webServer'], (scoped) => {
        scoped.effect(() => {
          const dispose = scoped.webServer.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: routeHandler,
          })
          return dispose
        }, 'dsh-bite: routes')
      })
    } catch (error) {
      ctx.logger.warn(`[dsh-bite] 路由注册失败（无 web 服务时忽略）: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 斜杠命令
    ctx.effect(function* () {
      yield ctx.commands.register({
        definitionId: CommandDefinitionId('dsh-bite/pin'),
        name: 'pin',
        description: 'bite：钉住最近一轮对话（压缩后自动找回）',
        handler: cmdPin,
      })
      yield ctx.commands.register({
        definitionId: CommandDefinitionId('dsh-bite/pins'),
        name: 'pins',
        description: 'bite：列出本会话的钉子',
        handler: cmdPins,
      })
      yield ctx.commands.register({
        definitionId: CommandDefinitionId('dsh-bite/unpin'),
        name: 'unpin',
        description: 'bite：解钉（/unpin [序号]，默认最新一条）',
        handler: cmdUnpin,
      })
    }, 'dsh-bite: commands')

    // 懒注入服务（路由按会话 id 读日志用）
    try {
      ctx.inject(['sessions', 'sessionPersistence'], (scoped) => {
        svc = {
          sessions: scoped.sessions,
          sessionPersistence: scoped.sessionPersistence,
        }
      })
    } catch (error) {
      ctx.logger.warn(`[dsh-bite] 服务注入失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    ctx.effect(() => {
      const banner = `[dsh-bite] 已加载（maxPins=${config.maxPins}, maxPinChars=${config.maxPinChars}, storage=${storageDir}）`
      ctx.logger.info(banner)
      console.log(banner)
      return () => ctx.logger.info('[dsh-bite] 已卸载')
    })
  }

  return {
    start,
    // 测试与调试入口
    _pinsOf: pinsOf,
    _loadPins: loadPins,
    _pinTurn: pinTurn,
    _unpinTurn: unpinTurn,
    _extractTurn: extractTurn,
    _lastAssistantMessageId: lastAssistantMessageId,
    _decideDigest: decideDigest,
    _observeSessionEvent: observeSessionEvent,
    _route: routeHandler,
    _commands: { pin: cmdPin, pins: cmdPins, unpin: cmdUnpin },
    _storageDir: storageDir,
    _markCompaction: (sid, seq) => {
      if (seq > (lastCompactionSeq.get(sid) ?? 0)) lastCompactionSeq.set(sid, seq)
    },
  }
}

export function apply(ctx, config) {
  const rt = createBite({ ctx, config })
  rt.start()
  return rt
}

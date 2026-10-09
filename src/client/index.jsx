// dsh-bite — 浏览器半区。
//
// 一条「钉子」按钮挂进 `conversation.chat.assistant-actions`（助手回复的
// 操作行）：未钉=绿色描边，已钉=红色。点击=落钉（带肥鱼掠食动画）或解钉
// （直接变色）。数据先走宿主 HTTP（/dsh-bite/pin|unpin），动画纯粹是表演：
// 鱼从屏幕左侧与按钮同高窜出，嘴越过按钮的那一刻按钮才变色（"吃掉"）。
//
// 常量 FISH 里的嘴心比例来自对素材的像素级测量（1536×1024 原图：
// 嘴心 x=19.7% / y=44.4%；水平翻转面朝右后 x→80.3%）。
import { useEffect, useRef, useState } from 'react'

const ROUTE = '/dsh-bite'
const FISH = {
  url: `${ROUTE}/fish.webp`,
  height: 240,
  width: 360, // 素材 3:2
  mouthYRatio: 0.444, // 嘴心纵向比例
  mouthXRatio: 0.803, // 嘴心横向比例（翻转后）
  durationMs: 900,
}

// ── 会话 → 钉子集合 的共享缓存（跨按钮实例） ──────────────────────────────
const pinCache = new Map() // sessionId → Set<assistantMessageId>
const listeners = new Set()
const inflight = new Map()

function bump() {
  for (const l of listeners) {
    try {
      l()
    } catch {
      /* 单个订阅者失败不影响其他 */
    }
  }
}

function isPinned(sessionId, messageId) {
  return pinCache.get(sessionId)?.has(messageId) === true
}

function markPinned(sessionId, messageId, value) {
  const set = pinCache.get(sessionId) ?? new Set()
  if (value) set.add(messageId)
  else set.delete(messageId)
  pinCache.set(sessionId, set)
  bump()
}

function ensurePins(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve()
  const running = inflight.get(sessionId)
  if (running !== undefined) return running
  const p = fetch(`${ROUTE}/pins?session=${encodeURIComponent(sessionId)}`)
    .then((r) => r.json())
    .then((j) => {
      if (j?.ok === true && Array.isArray(j.pins)) {
        pinCache.set(sessionId, new Set(j.pins.map((x) => x.assistantMessageId)))
        bump()
      }
    })
    .catch(() => {})
    .finally(() => inflight.delete(sessionId))
  inflight.set(sessionId, p)
  return p
}

async function postJson(path, payload) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return r.json()
}

// ── 肥鱼掠食动画（纯 DOM，一次性掠过） ───────────────────────────────────
function playFish(buttonEl, onEaten) {
  try {
    const rect = buttonEl.getBoundingClientRect()
    const { height: h, width: w, mouthYRatio, mouthXRatio, durationMs } = FISH
    const img = document.createElement('img')
    img.src = FISH.url
    img.alt = ''
    img.className = 'dsh-bite-fish'
    const ty = Math.max(4, rect.top + rect.height / 2 - h * mouthYRatio)
    const startX = -w - 8
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 360
    const endX = viewportW + 16
    img.style.transform = `translateX(${startX}px) translateY(${ty}px) scaleX(-1)`
    document.body.appendChild(img)
    void img.getBoundingClientRect() // 强制 reflow，让下面的 transition 生效
    img.style.transition = `transform ${durationMs}ms linear`
    img.style.transform = `translateX(${endX}px) translateY(${ty}px) scaleX(-1)`

    // 嘴心越过按钮中心的时刻 → 变色（"吃掉"）
    const buttonCenterX = rect.left + rect.width / 2
    const leftEdgeAtEat = buttonCenterX - w * mouthXRatio
    const tEat = Math.max(0, Math.min(durationMs, (durationMs * (leftEdgeAtEat - startX)) / (endX - startX)))
    const eatTimer = setTimeout(() => {
      try {
        if (typeof onEaten === 'function') onEaten()
      } catch {
        /* 表演回调失败不影响数据 */
      }
    }, tEat)

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(eatTimer)
      img.remove()
    }
    img.addEventListener('transitionend', cleanup, { once: true })
    setTimeout(cleanup, durationMs + 500) // 兜底（素材加载失败时 transitionend 不触发）
  } catch {
    try {
      if (typeof onEaten === 'function') onEaten()
    } catch {
      /* 无论如何保证状态推进 */
    }
  }
}

// ── 按钮组件 ─────────────────────────────────────────────────────────────
// sessionId 双保险：scope='session' 槽位在类型契约上会把 sessionId 传给
// inject()（FactoryInjectParams），部分宿主实现也会并进组件 props —— 取先到者。
function BiteAction(props) {
  const sessionId = props.biteSessionId ?? props.sessionId
  const messageId = props.messageId
  const [pinned, setPinned] = useState(() => isPinned(sessionId, messageId))
  const [busy, setBusy] = useState(false)
  const btnRef = useRef(null)

  useEffect(() => {
    const l = () => setPinned(isPinned(sessionId, messageId))
    listeners.add(l)
    l()
    ensurePins(sessionId)
    return () => {
      listeners.delete(l)
    }
  }, [sessionId, messageId])

  if (typeof sessionId !== 'string' || typeof messageId !== 'string') return null

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (!pinned) {
        const j = await postJson(`${ROUTE}/pin`, { sessionId, messageId })
        if (j?.ok !== true) {
          console.warn('[dsh-bite] 落钉失败:', j?.code ?? j)
          return
        }
        // 数据已落 —— 表演开始；变色发生在鱼嘴越过按钮的那一刻
        if (btnRef.current !== null) {
          playFish(btnRef.current, () => markPinned(sessionId, messageId, true))
        } else {
          markPinned(sessionId, messageId, true)
        }
      } else {
        const j = await postJson(`${ROUTE}/unpin`, { sessionId, messageId })
        if (j?.ok !== true) {
          console.warn('[dsh-bite] 解钉失败:', j?.code ?? j)
          return
        }
        markPinned(sessionId, messageId, false)
      }
    } catch (error) {
      console.warn('[dsh-bite] 请求失败:', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      ref={btnRef}
      type="button"
      className="dsh-bite-btn"
      data-pinned={pinned ? 'true' : 'false'}
      disabled={busy}
      onClick={onClick}
      title={pinned ? 'bite：已钉住（压缩也带不走）。点击吐出来' : 'bite：钉住这一轮（压缩后自动找回）'}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          fill="currentColor"
          d="M9.5 1.5a.75.75 0 0 1 1.06 0l3.94 3.94a.75.75 0 1 1-1.06 1.06l-.72-.72-3.15 3.15a2.5 2.5 0 0 1-3.4 3.4l-.6-.6-2.4 2.4a.75.75 0 0 1-1.06-1.07l2.4-2.4-.6-.6a2.5 2.5 0 0 1 3.4-3.4l3.15-3.15-.72-.72a.75.75 0 0 1 0-1.06Z"
        />
      </svg>
      <span>{pinned ? '已钉' : '钉住'}</span>
    </button>
  )
}

// ── 样式（注入一次） ─────────────────────────────────────────────────────
const CSS = `
.dsh-bite-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border-radius:8px;
  border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  color:#5a6572;transition:color .15s ease,border-color .15s ease,background .15s ease}
.dsh-bite-btn:hover{background:rgba(127,127,127,.1)}
.dsh-bite-btn[data-pinned="false"]{color:#2ea043;border-color:rgba(46,160,67,.5)}
.dsh-bite-btn[data-pinned="false"]:hover{background:rgba(46,160,67,.12)}
.dsh-bite-btn[data-pinned="true"]{color:#d1242f;border-color:rgba(209,36,47,.5);background:rgba(209,36,47,.08)}
.dsh-bite-btn[data-pinned="true"]:hover{background:rgba(209,36,47,.16)}
.dsh-bite-btn:disabled{opacity:.55;cursor:default}
.dsh-bite-fish{position:fixed;left:0;top:0;width:360px;height:240px;pointer-events:none;
  z-index:2147483000;will-change:transform}
`

// ── 插件体 ───────────────────────────────────────────────────────────────
const inject = ['slots']

async function apply(ctx) {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.id = 'dsh-bite-style'
    tag.dataset.plugin = 'dsh-bite'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'dsh-bite: styles')

  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    const dispose = ctx.slots.register(
      {
        name: 'conversation.chat.assistant-actions',
        id: 'bite',
        order: 40,
        inject: (sessionId) => ({ biteSessionId: sessionId }),
      },
      BiteAction,
    )
    return () => {
      dispose()
    }
  })
}

export { apply, inject }

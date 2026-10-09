window.__ModuleLoader__.load({
	id: "dsh-bite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var ROUTE = "/dsh-bite";
var FISH = {
  url: `${ROUTE}/fish.webp`,
  height: 240,
  width: 360,
  // 素材 3:2
  mouthYRatio: 0.444,
  // 嘴心纵向比例
  mouthXRatio: 0.803,
  // 嘴心横向比例（翻转后）
  durationMs: 900
};
var pinCache = /* @__PURE__ */ new Map();
var listeners = /* @__PURE__ */ new Set();
var inflight = /* @__PURE__ */ new Map();
function bump() {
  for (const l of listeners) {
    try {
      l();
    } catch {
    }
  }
}
function isPinned(sessionId, messageId) {
  return pinCache.get(sessionId)?.has(messageId) === true;
}
function markPinned(sessionId, messageId, value) {
  const set = pinCache.get(sessionId) ?? /* @__PURE__ */ new Set();
  if (value) set.add(messageId);
  else set.delete(messageId);
  pinCache.set(sessionId, set);
  bump();
}
function ensurePins(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve();
  const running = inflight.get(sessionId);
  if (running !== void 0) return running;
  const p = fetch(`${ROUTE}/pins?session=${encodeURIComponent(sessionId)}`).then((r) => r.json()).then((j) => {
    if (j?.ok === true && Array.isArray(j.pins)) {
      pinCache.set(sessionId, new Set(j.pins.map((x) => x.assistantMessageId)));
      bump();
    }
  }).catch(() => {
  }).finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}
async function postJson(path, payload) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return r.json();
}
function playFish(buttonEl, onEaten) {
  try {
    const rect = buttonEl.getBoundingClientRect();
    const { height: h, width: w, mouthYRatio, mouthXRatio, durationMs } = FISH;
    const img = document.createElement("img");
    img.src = FISH.url;
    img.alt = "";
    img.className = "dsh-bite-fish";
    const ty = Math.max(4, rect.top + rect.height / 2 - h * mouthYRatio);
    const startX = -w - 8;
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 360;
    const endX = viewportW + 16;
    img.style.transform = `translateX(${startX}px) translateY(${ty}px) scaleX(-1)`;
    document.body.appendChild(img);
    void img.getBoundingClientRect();
    img.style.transition = `transform ${durationMs}ms linear`;
    img.style.transform = `translateX(${endX}px) translateY(${ty}px) scaleX(-1)`;
    const buttonCenterX = rect.left + rect.width / 2;
    const leftEdgeAtEat = buttonCenterX - w * mouthXRatio;
    const tEat = Math.max(0, Math.min(durationMs, durationMs * (leftEdgeAtEat - startX) / (endX - startX)));
    const eatTimer = setTimeout(() => {
      try {
        if (typeof onEaten === "function") onEaten();
      } catch {
      }
    }, tEat);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(eatTimer);
      img.remove();
    };
    img.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, durationMs + 500);
  } catch {
    try {
      if (typeof onEaten === "function") onEaten();
    } catch {
    }
  }
}
function BiteAction(props) {
  const sessionId = props.biteSessionId ?? props.sessionId;
  const messageId = props.messageId;
  const [pinned, setPinned] = (0, import_react.useState)(() => isPinned(sessionId, messageId));
  const [busy, setBusy] = (0, import_react.useState)(false);
  const btnRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    const l = () => setPinned(isPinned(sessionId, messageId));
    listeners.add(l);
    l();
    ensurePins(sessionId);
    return () => {
      listeners.delete(l);
    };
  }, [sessionId, messageId]);
  if (typeof sessionId !== "string" || typeof messageId !== "string") return null;
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!pinned) {
        const j = await postJson(`${ROUTE}/pin`, { sessionId, messageId });
        if (j?.ok !== true) {
          console.warn("[dsh-bite] 落钉失败:", j?.code ?? j);
          return;
        }
        if (btnRef.current !== null) {
          playFish(btnRef.current, () => markPinned(sessionId, messageId, true));
        } else {
          markPinned(sessionId, messageId, true);
        }
      } else {
        const j = await postJson(`${ROUTE}/unpin`, { sessionId, messageId });
        if (j?.ok !== true) {
          console.warn("[dsh-bite] 解钉失败:", j?.code ?? j);
          return;
        }
        markPinned(sessionId, messageId, false);
      }
    } catch (error) {
      console.warn("[dsh-bite] 请求失败:", error);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      ref: btnRef,
      type: "button",
      className: "dsh-bite-btn",
      "data-pinned": pinned ? "true" : "false",
      disabled: busy,
      onClick,
      title: pinned ? "bite：已钉住（压缩也带不走）。点击吐出来" : "bite：钉住这一轮（压缩后自动找回）",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", width: "12", height: "12", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "path",
          {
            fill: "currentColor",
            d: "M9.5 1.5a.75.75 0 0 1 1.06 0l3.94 3.94a.75.75 0 1 1-1.06 1.06l-.72-.72-3.15 3.15a2.5 2.5 0 0 1-3.4 3.4l-.6-.6-2.4 2.4a.75.75 0 0 1-1.06-1.07l2.4-2.4-.6-.6a2.5 2.5 0 0 1 3.4-3.4l3.15-3.15-.72-.72a.75.75 0 0 1 0-1.06Z"
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: pinned ? "已钉" : "钉住" })
      ]
    }
  );
}
var CSS = `
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
`;
var inject = ["slots"];
async function apply(ctx) {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "dsh-bite-style";
    tag.dataset.plugin = "dsh-bite";
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, "dsh-bite: styles");
  ctx.slots.inject("conversation.chat.assistant-actions", () => {
    const dispose = ctx.slots.register(
      {
        name: "conversation.chat.assistant-actions",
        id: "bite",
        order: 40,
        inject: (sessionId) => ({ biteSessionId: sessionId })
      },
      BiteAction
    );
    return () => {
      dispose();
    };
  });
}

		return module.exports;
	}
});

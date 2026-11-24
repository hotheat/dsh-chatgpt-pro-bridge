/** Reply completion and the single browser owner, independent of DSH. */
export function cancellationError(signal) {
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : '已取消')
  error.name = 'AbortError'
  error.cancelled = true
  return error
}

export async function waitForReply({ sample, wait, now = Date.now, timeoutMs, signal }) {
  const checkAborted = () => {
    if (signal?.aborted) throw cancellationError(signal)
  }
  checkAborted()
  const started = now()
  let text = ''
  let streaming = false
  let stableSince = started
  while (now() - started < timeoutMs) {
    checkAborted()
    await wait(Math.min(1200, timeoutMs - (now() - started)))
    checkAborted()
    const current = await sample()
    checkAborted()
    streaming = current.streaming
    if (current.text !== text) {
      text = current.text || text
      stableSince = now()
    }
    if (current.text && !streaming && now() - stableSince > 2500) return { text, complete: true, streaming }
  }
  checkAborted()
  return { text, complete: false, streaming }
}

export class BrowserBusyError extends Error {}

export function createDelegation(driver, { idleTimeoutMs = 0, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const idleMs = Number(idleTimeoutMs) > 0 ? Number(idleTimeoutMs) : 0
  const pending = new Set()
  let active = null
  let browserBusy = false
  let idleTimer = null
  let idleCloseAt = null
  let queue = Promise.resolve()
  const schedule = (task) => {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }
  const cancelIdleTimer = () => {
    if (idleTimer != null) clearTimer(idleTimer)
    idleTimer = null
    idleCloseAt = null
  }
  const runIdleClose = async () => {
    idleTimer = null
    idleCloseAt = null
    if (pending.size || browserBusy || typeof driver.close !== 'function') return
    if (typeof driver.connected === 'function' && !(await driver.connected().catch(() => false))) return
    if (pending.size || browserBusy || idleTimer != null) return
    browserBusy = true
    await schedule(async () => {
      try {
        if (pending.size === 0) await driver.close()
      } catch {} finally {
        browserBusy = false
      }
    })
  }
  const scheduleIdleClose = () => {
    cancelIdleTimer()
    if (idleMs > 0 && pending.size === 0 && !browserBusy) {
      idleCloseAt = now() + idleMs
      idleTimer = setTimer(runIdleClose, idleMs)
      idleTimer?.unref?.()
    }
  }
  const perform = async (options) => {
    const result = await driver.handoff(options)
    const ok = result.complete === true
    return {
      ...result,
      ok,
      characters: result.characters ?? result.answer.length,
      ...(!ok ? { error: '等待回复超时' + (result.streaming ? '，页面仍在生成' : '，未确认回复完成') } : {}),
    }
  }
  return {
    pending,
    get active() { return active },
    get idleTimeoutMs() { return idleMs },
    get idleCloseAt() { return idleCloseAt == null ? null : new Date(idleCloseAt).toISOString() },
    enqueue(identity, task) {
      cancelIdleTimer()
      const ticket = { ...identity }
      pending.add(ticket)
      return schedule(async () => {
        active = ticket
        try {
          return await task(ticket, perform)
        } finally {
          // Release at the end of this task, never from a later queue promise.
          pending.delete(ticket)
          active = null
          if (pending.size === 0 && !browserBusy) scheduleIdleClose()
        }
      })
    },
    browser(action) {
      if (pending.size || browserBusy) return Promise.reject(new BrowserBusyError('浏览器正被委托或其他浏览器操作占用，请稍后重试'))
      const hadTimer = idleTimer != null
      cancelIdleTimer()
      browserBusy = true
      return schedule(async () => {
        let result
        try {
          result = await driver[action]()
          return result
        } finally {
          browserBusy = false
          if (pending.size === 0 && (
            ['login', 'probe', 'debug'].includes(action) ||
            (action === 'status' && (hadTimer || result?.running === true)) ||
            (action === 'stop' && (hadTimer || result === true))
          )) scheduleIdleClose()
        }
      })
    },
    // This probe only reads the CDP endpoint and never connects or launches Chrome.
    connected: () => driver.connected(),
    browserInfo: () => typeof driver.info === 'function' ? driver.info() : {},
    dispose: cancelIdleTimer,
  }
}

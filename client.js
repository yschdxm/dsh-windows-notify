/**
 * dsh-windows-notify — browser half.
 *
 * The toast click cannot drive the app by itself, so the host stores a pending
 * "jump to this conversation" request and this module polls it while the GUI is
 * open (desktop app or browser). It then asks the UI to open that session.
 *
 * Activation order is declared in package.json (`dsh.client.inject`), so
 * `uiWorkspace` already exists when this module activates. The poll interval is
 * small because the request only exists after a deliberate click.
 */
window.__ModuleLoader__.load({
  id: '@yschdxm/dsh-windows-notify',
  factory() {
    const ROUTE = '/plugins/dsh-windows-notify'
    const POLL_MS = 1200

    return {
      inject: [],
      apply(ctx) {
        let disposed = false
        let busy = false

        const poll = async () => {
          if (disposed || busy) return
          busy = true
          try {
            const response = await fetch(`${ROUTE}/pending`, {
              credentials: 'same-origin',
              cache: 'no-store',
            })
            if (!response.ok) return
            const data = await response.json()
            const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : ''
            if (!sessionId) return
            try {
              ctx.get('uiWorkspace')?.openSession?.(sessionId)
            } catch {
              /* the session may have been archived; keep the plugin alive */
            }
            fetch(`${ROUTE}/ack?session=${encodeURIComponent(sessionId)}`, {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
            }).catch(() => {})
          } catch {
            /* host not reachable yet during boot; retry on the next tick */
          } finally {
            busy = false
          }
        }

        const timer = setInterval(poll, POLL_MS)
        void poll()
        ctx.effect(() => () => {
          disposed = true
          clearInterval(timer)
        })
      },
    }
  },
})

const backHandlers = []

// The most recently opened overlay owns Back until it releases its handler.
export function registerBackHandler(handler) {
  const entry = { handler }
  backHandlers.push(entry)
  return () => {
    const index = backHandlers.indexOf(entry)
    if (index !== -1) backHandlers.splice(index, 1)
  }
}

export function dismissActiveOverlay() {
  const entry = backHandlers.at(-1)
  if (!entry) return false
  entry.handler()
  return true
}

// Keep route parameters in memory; returning to a screen mounts it again.
export function createNavigation(render) {
  let history = []
  return {
    navigate(name, parameters = {}, { reset = false } = {}) {
      const route = { name, parameters: { ...parameters } }
      if (reset) history = [route]
      else if (history.at(-1)?.name === name) history[history.length - 1] = route
      else history.push(route)
      render(route.name, route.parameters)
    },
    goBack() {
      if (history.length < 2) return false
      history.pop()
      const route = history.at(-1)
      render(route.name, route.parameters)
      return true
    },
    clear() { history = [] },
  }
}

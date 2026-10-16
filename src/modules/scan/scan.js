import './scan.css'
import html from './scan.html?raw'
import { Capacitor } from '@capacitor/core'
import { BarcodeScanner, LensFacing } from '@capacitor-mlkit/barcode-scanning'

export function createScanner({ onScan, onError }) {
  let current
  let disposed = false

  function clearSelection(session) {
    clearTimeout(session.expiry)
    session.selected = undefined
    session.polygon.setAttribute('hidden', '')
    session.confirm.hidden = true
    session.status.textContent = 'Point the camera at a barcode'
  }

  function selectBarcode(session, barcodes) {
    if (session.closed) return
    const { width, height } = session.overlay.getBoundingClientRect()
    // Native corner points are screen pixels; the overlay uses CSS pixels
    const ratio = window.devicePixelRatio || 1
    let nearest
    let nearestDistance = Infinity
    for (const barcode of barcodes) {
      const value = barcode.rawValue ?? (barcode.bytes?.length
        ? new TextDecoder().decode(Uint8Array.from(barcode.bytes))
        : barcode.displayValue)
      if (typeof value !== 'string' || !value.length || barcode.cornerPoints?.length !== 4) continue
      const points = barcode.cornerPoints.map(([x, y]) => [x / ratio, y / ratio])
      if (!points.every(point => point.every(Number.isFinite))) continue
      const x = points.reduce((sum, point) => sum + point[0], 0) / 4
      const y = points.reduce((sum, point) => sum + point[1], 0) / 4
      if (x < 0 || x > width || y < 0 || y > height) continue
      const distance = (x - width / 2) ** 2 + (y - height / 2) ** 2
      if (distance < nearestDistance) {
        nearest = { value, points }
        nearestDistance = distance
      }
    }
    if (!nearest) {
      clearSelection(session)
      return
    }
    clearTimeout(session.expiry)
    session.selected = nearest.value
    session.polygon.setAttribute('points', nearest.points.map(point => point.join(',')).join(' '))
    session.polygon.removeAttribute('hidden')
    if (session.confirm.hidden) session.status.textContent = 'Barcode detected. Tap Scan to confirm.'
    session.confirm.hidden = false
    // The native plugin may not emit an empty result when the barcode leaves view
    session.expiry = setTimeout(() => clearSelection(session), 600)
  }

  function finish(session, value, error) {
    if (session.closed) return session.finished
    session.closed = true
    clearSelection(session)
    session.events.abort()
    session.finished = (async () => {
      // Wait for startup so a late camera callback cannot reopen a cancelled scan
      try { await session.ready } catch { /* Startup errors are reported below */ }
      try {
        if (session.startAttempted) await BarcodeScanner.stopScan()
      } catch (stopError) {
        console.error('Could not stop barcode scanner:', stopError)
        error ??= new Error('Could not stop the camera. Close and reopen the app.')
      } finally {
        const results = await Promise.allSettled(session.listeners.map(listener => listener.remove()))
        for (const result of results) {
          if (result.status === 'rejected') console.error('Could not remove scanner listener:', result.reason)
        }
        session.overlay.close()
        session.overlay.remove()
        document.documentElement.classList.remove('scan-active')
        current = undefined
      }
      if (disposed) return
      if (error) onError(error.message)
      else if (value !== undefined) onScan(value)
    })()
    return session.finished
  }

  async function start(session) {
    const { supported } = await BarcodeScanner.isSupported()
    if (session.closed) return
    if (!supported) throw new Error('No camera is available for barcode scanning.')
    let { camera } = await BarcodeScanner.checkPermissions()
    if (session.closed) return
    if (camera !== 'granted') {
      const permission = await BarcodeScanner.requestPermissions()
      camera = permission.camera
    }
    if (session.closed) return
    if (camera !== 'granted') throw new Error('Camera access is required to scan. Allow it in the app settings and try again.')

    session.listeners.push(await BarcodeScanner.addListener('barcodesScanned', ({ barcodes }) => selectBarcode(session, barcodes)))
    if (session.closed) return
    session.listeners.push(await BarcodeScanner.addListener('scanError', () => {
      void finish(session, undefined, new Error('Could not scan with the camera. Please try again.'))
    }))
    if (session.closed) return
    document.documentElement.classList.add('scan-active')
    session.startAttempted = true
    // Omitting formats enables every format supported by ML Kit
    await BarcodeScanner.startScan({ lensFacing: LensFacing.Back })
    if (!session.closed && session.selected === undefined) clearSelection(session)
  }

  function open() {
    if (disposed || current) return
    if (!Capacitor.isNativePlatform()) {
      onError('Open the Android app on your phone or emulator to scan barcodes.')
      return
    }
    const template = document.createElement('template')
    template.innerHTML = html
    const overlay = template.content.firstElementChild
    const session = {
      overlay,
      polygon: overlay.querySelector('polygon'),
      confirm: overlay.querySelector('.scan-confirm'),
      status: overlay.querySelector('.scan-status'),
      events: new AbortController(),
      listeners: [],
      closed: false,
      startAttempted: false,
    }
    current = session
    const options = { signal: session.events.signal }
    overlay.querySelector('.scan-close').addEventListener('click', () => void finish(session), options)
    overlay.addEventListener('cancel', event => {
      event.preventDefault()
      void finish(session)
    }, options)
    session.confirm.addEventListener('click', () => {
      if (session.selected !== undefined) void finish(session, session.selected)
    }, options)
    window.addEventListener('resize', () => clearSelection(session), options)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && session.startAttempted) void finish(session)
    }, options)
    document.body.append(overlay)
    overlay.showModal()
    session.ready = start(session)
    session.ready.catch(error => {
      if (!session.closed) void finish(session, undefined, new Error(error.message || 'Could not start the scanner. Please try again.'))
    })
  }

  return {
    open,
    destroy() {
      disposed = true
      if (current) return finish(current)
    },
  }
}

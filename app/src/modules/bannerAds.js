import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { AdMob, BannerAdPluginEvents, BannerAdPosition, BannerAdSize } from '@capacitor-community/admob'

// Keep test ads enabled until live ads and consent handling are configured.
const bannerOptions = {
  adId: 'ca-app-pub-8348138565431475/5548456015',
  isTesting: true,
  adSize: BannerAdSize.ADAPTIVE_BANNER,
  position: BannerAdPosition.TOP_CENTER,
  margin: 0,
}

export function createBannerAds({ capacitor = Capacitor, app = App, ads = AdMob,
  setHeight = height => document.documentElement.style.setProperty('--banner-height', `${height}px`),
  warn = (...args) => console.warn(...args) } = {}) {
  let started
  let initialized = false
  let loading = false
  let visible = false
  let enabled = false
  let pending = Promise.resolve()

  async function showBanner() {
    if (!enabled || loading || visible) return
    loading = true
    try {
      if (!initialized) {
        await ads.initialize()
        initialized = true
      }
      if (!enabled) return
      await ads.showBanner(bannerOptions)
    } catch (error) {
      visible = false
      setHeight(0)
      warn('Banner unavailable:', error)
    } finally {
      loading = false
    }
  }

  async function start() {
    if (capacitor.getPlatform() !== 'android') return
    const handles = []
    try {
      // Subscribe before loading so the initial banner height is not missed.
      handles.push(await ads.addListener(BannerAdPluginEvents.SizeChanged, ({ height }) => {
        const safeHeight = Number.isFinite(height) && height > 0 ? height : 0
        visible = enabled && safeHeight > 0
        setHeight(enabled ? safeHeight : 0)
      }))
      handles.push(await ads.addListener(BannerAdPluginEvents.FailedToLoad, error => {
        visible = false
        setHeight(0)
        warn('Banner failed to load:', error)
      }))
      // Retry an unavailable banner when the user returns to the app.
      handles.push(await app.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void showBanner()
      }))
    } catch (error) {
      await Promise.allSettled(handles.map(handle => handle.remove()))
      warn('Could not register banner listeners:', error)
      return
    }
    await showBanner()
  }

  // Serialize screen changes so an in-flight load is removed before hiding completes.
  function setEnabled(value) {
    if (capacitor.getPlatform() !== 'android' || enabled === value) return pending
    enabled = value
    if (!enabled) setHeight(0)
    pending = pending.then(async () => {
      if (value !== enabled) return
      if (enabled) {
        if (!started) started = start()
        else await showBanner()
        await started
      } else if (initialized) {
        await ads.removeBanner()
        visible = false
      }
    }).catch(error => warn('Could not update banner visibility:', error))
    return pending
  }

  return { setEnabled }
}

export const bannerAds = createBannerAds()

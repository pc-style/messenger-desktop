// @ts-nocheck
import { ipcRenderer } from "electron"

let settingsEntryObserver: MutationObserver | null = null
let settingsEntryInterval: ReturnType<typeof setInterval> | null = null
const SETTINGS_BUTTON_ID = "unleashed-settings-btn"

function ensureSettingsEntryStyles() {
  if (document.getElementById("unleashed-settings-entry-style")) return
  const style = document.createElement("style")
  style.id = "unleashed-settings-entry-style"
  style.textContent = `
    #${SETTINGS_BUTTON_ID} {
      all: unset;
      cursor: pointer;
      width: 40px;
      height: 40px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 6px auto;
      color: #c6c8d1;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      transition: background 0.2s ease, transform 0.2s ease, color 0.2s ease;
    }
    #${SETTINGS_BUTTON_ID}:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      transform: translateY(-1px);
    }
    #${SETTINGS_BUTTON_ID}[data-floating="true"] {
      position: fixed;
      left: 16px;
      bottom: 20px;
      z-index: 999999;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
    }
    @media (prefers-color-scheme: light) {
      #${SETTINGS_BUTTON_ID} {
        color: #4c4f59;
        background: rgba(0, 0, 0, 0.04);
        border: 1px solid rgba(0, 0, 0, 0.08);
      }
      #${SETTINGS_BUTTON_ID}:hover {
        background: rgba(0, 0, 0, 0.08);
        color: #111;
      }
    }
  `
  document.head.appendChild(style)
}

function createSettingsButton() {
  const btn = document.createElement("button")
  btn.id = SETTINGS_BUTTON_ID
  btn.type = "button"
  btn.setAttribute("aria-label", "Unleashed Settings")
  btn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z" stroke="currentColor" stroke-width="1.6"/>
      <path d="M19.4 12a7.4 7.4 0 0 0-.08-1.06l2.02-1.58-1.92-3.32-2.44.95a7.5 7.5 0 0 0-1.84-1.06l-.36-2.56h-3.84l-.36 2.56c-.66.24-1.28.6-1.84 1.06l-2.44-.95-1.92 3.32 2.02 1.58A7.4 7.4 0 0 0 4.6 12c0 .36.02.71.08 1.06l-2.02 1.58 1.92 3.32 2.44-.95c.56.46 1.18.82 1.84 1.06l.36 2.56h3.84l.36-2.56c.66-.24 1.28-.6 1.84-1.06l2.44.95 1.92-3.32-2.02-1.58c.06-.35.08-.7.08-1.06Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>
  `
  btn.onclick = () => ipcRenderer.send("open-settings")
  return btn
}

function findSettingsNavTarget() {
  const messengerRoot =
    document.querySelector('[aria-label="Messenger"]') ||
    document.querySelector('[data-pagelet*="LeftRail"]')
  const navs = Array.from(document.querySelectorAll('div[role="navigation"]'))

  const rootNav =
    messengerRoot?.querySelector('div[role="navigation"]') ||
    navs.find((nav) => nav.closest('[aria-label="Messenger"]'))

  const narrowNavs = navs
    .map((nav) => ({
      nav,
      width: nav.getBoundingClientRect().width,
      count: nav.querySelectorAll('a, button, [role="button"]').length,
    }))
    .filter((item) => item.width > 0 && item.width < 140)
    .sort((a, b) => b.count - a.count)

  const marketplaceSelector =
    '[aria-label*="Marketplace"], [aria-label*="marketplace"], a[href*="marketplace"], [data-testid*="marketplace"]'

  const targetNav = rootNav || narrowNavs[0]?.nav || navs[0] || null
  if (!targetNav) return null

  const marketplace = targetNav.querySelector(marketplaceSelector)
  return { nav: targetNav, after: marketplace || null }
}

function insertAfter(referenceNode, newNode) {
  if (!referenceNode || !referenceNode.parentNode) return false
  referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling)
  return true
}

function ensureSettingsEntry() {
  if (document.getElementById(SETTINGS_BUTTON_ID)) return
  ensureSettingsEntryStyles()

  const target = findSettingsNavTarget()
  const btn = createSettingsButton()
  if (target && target.nav) {
    btn.dataset.floating = "false"
    if (target.after) {
      insertAfter(target.after, btn)
    } else {
      target.nav.appendChild(btn)
    }
  } else {
    btn.dataset.floating = "true"
    document.body.appendChild(btn)
  }
}

export function setupSettingsEntry() {
  ensureSettingsEntry()
  if (settingsEntryObserver) return
  settingsEntryObserver = new MutationObserver(() => {
    if (!document.getElementById(SETTINGS_BUTTON_ID)) {
      ensureSettingsEntry()
    }
  })
  settingsEntryObserver.observe(document.body, { childList: true, subtree: true })

  if (!settingsEntryInterval) {
    settingsEntryInterval = setInterval(() => {
      if (document.getElementById(SETTINGS_BUTTON_ID)) {
        clearInterval(settingsEntryInterval)
        settingsEntryInterval = null
        return
      }
      ensureSettingsEntry()
    }, 2000)
  }
}

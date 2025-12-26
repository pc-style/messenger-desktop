// @ts-nocheck
import { ipcRenderer } from "electron"
import { ICONS } from "./icons.js"

export function setupSettingsModal() {
  ipcRenderer.on("open-settings-modal", (_, config) => {
    showSettingsModal(config)
  })
}

function showSettingsModal(config: any) {
  const existing = document.getElementById("unleashed-settings-overlay")
  if (existing) existing.remove()

  let modal: HTMLDivElement | null = null
  let style: HTMLStyleElement | null = null
  let mainTitle: HTMLHeadingElement | null = null
  let subTitle: HTMLDivElement | null = null
  let closeBtn: HTMLDivElement | null = null
  let footerHint: HTMLDivElement | null = null

  const updateTheme = () => {
    if (!modal || !style || !mainTitle || !subTitle || !closeBtn || !footerHint) return

    const isDarkMode =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    const bgColor = isDarkMode ? "rgba(28, 28, 30, 0.8)" : "rgba(255, 255, 255, 0.8)"
    const textColor = isDarkMode ? "#fff" : "#000"
    const subTextColor = isDarkMode ? "#aaa" : "#666"
    const borderColor = isDarkMode ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)"
    const sectionBorderColor = isDarkMode
      ? "rgba(255, 255, 255, 0.05)"
      : "rgba(0, 0, 0, 0.05)"
    const btnBg = isDarkMode ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)"
    const accentColor = "#0084ff"

    modal.style.background = bgColor
    modal.style.color = textColor
    modal.style.borderColor = borderColor

    // Update styles in head
    style.textContent = `
      @keyframes settingsFadeIn {
        from { opacity: 0; transform: scale(0.98) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .settings-body { min-height: 0; }
      .settings-tabs {
        width: 170px; padding: 12px;
        border-right: 1px solid ${sectionBorderColor};
        display: flex; flex-direction: column; gap: 6px;
      }
      .settings-tab {
        border: none; background: transparent; color: ${subTextColor};
        text-align: left; padding: 10px 12px; border-radius: 10px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: background 0.2s, color 0.2s;
      }
      .settings-tab.active {
        background: ${isDarkMode ? "rgba(0,132,255,0.18)" : "rgba(0,132,255,0.12)"};
        color: ${textColor};
      }
      .settings-panels { flex: 1; overflow: hidden; }
      .settings-panel {
        display: none; height: 100%; overflow-y: auto; padding: 4px 0;
      }
      .settings-panel.active { display: block; }
      .settings-panel-title {
        padding: 16px 24px 6px;
        color: ${subTextColor};
        text-transform: uppercase;
        font-size: 11px;
        letter-spacing: 0.6px;
        font-weight: 700;
      }
      .settings-section { padding: 12px 24px 20px; border-bottom: 1px solid ${sectionBorderColor}; }
      .settings-section h4 { display: none; }
      .settings-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .settings-row:last-child { margin-bottom: 0; }
      .settings-label { font-size: 14px; font-weight: 500; }
      .settings-desc { font-size: 12px; color: ${subTextColor}; margin-top: 2px; }
      .toggle { 
        position: relative; width: 44px; height: 24px; 
        background: ${isDarkMode ? "#3a3a3c" : "#e9e9ea"}; border-radius: 12px; cursor: pointer;
        transition: background 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .toggle.active { background: #30d158; }
      .toggle-knob {
        position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
        background: #fff; border-radius: 50%; transition: left 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }
      .toggle.active .toggle-knob { left: 22px; }
      .settings-btn {
        background: ${btnBg}; border: none; color: ${textColor};
        padding: 8px 14px; border-radius: 10px; font-size: 13px; cursor: pointer;
        transition: all 0.2s; font-weight: 500;
      }
      .settings-btn:hover { background: ${isDarkMode ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}; }
      .settings-btn.primary { background: ${accentColor}; color: white; }
      .settings-btn.primary:hover { background: #0077e6; }
      .close-area { padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); }
      
      /* Scrollbar styling */
      .settings-panel::-webkit-scrollbar { width: 8px; }
      .settings-panel::-webkit-scrollbar-track { background: transparent; }
      .settings-panel::-webkit-scrollbar-thumb { background: ${isDarkMode ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}; border-radius: 4px; }
    `

    mainTitle.style.color = textColor
    subTitle.style.color = subTextColor
    closeBtn.style.color = subTextColor
    footerHint.style.color = subTextColor
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
  mediaQuery.addEventListener("change", updateTheme)

  const isDarkMode = mediaQuery.matches
  const bgColor = isDarkMode ? "rgba(28, 28, 30, 0.8)" : "rgba(255, 255, 255, 0.8)"
  const textColor = isDarkMode ? "#fff" : "#000"
  const subTextColor = isDarkMode ? "#aaa" : "#666"
  const borderColor = isDarkMode ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)"
  const sectionBorderColor = isDarkMode
    ? "rgba(255, 255, 255, 0.05)"
    : "rgba(0, 0, 0, 0.05)"
  const btnBg = isDarkMode ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)"
  const accentColor = "#0084ff"

  const overlay = document.createElement("div")
  overlay.id = "unleashed-settings-overlay"
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.4); z-index: 1000000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(20px) saturate(180%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  `

  modal = document.createElement("div")
  modal.style.cssText = `
    background: ${bgColor};
    width: 600px; max-height: 85vh;
    border-radius: 24px;
    border: 1px solid ${borderColor};
    box-shadow: 0 30px 60px rgba(0,0,0,0.3);
    display: flex; flex-direction: column;
    overflow: hidden; color: ${textColor};
    animation: settingsFadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  `

  style = document.createElement("style")
  document.head.appendChild(style)

  const header = document.createElement("div")
  header.style.cssText =
    `padding: 24px 24px 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid ${sectionBorderColor};`

  const titleGroup = document.createElement("div")
  mainTitle = document.createElement("h2")
  mainTitle.textContent = "Messenger Unleashed"
  mainTitle.style.cssText = `margin: 0; font-size: 20px; font-weight: 700; color: ${textColor};`

  subTitle = document.createElement("div")
  subTitle.textContent = `v${config.version || "2.0.0"} — Settings`
  subTitle.style.cssText = `font-size: 12px; color: ${subTextColor}; font-weight: 500; margin-top: 2px;`

  titleGroup.append(mainTitle, subTitle)

  closeBtn = document.createElement("div")
  closeBtn.innerHTML = ICONS.close
  closeBtn.style.cssText =
    `font-size: 24px; cursor: pointer; color: ${subTextColor}; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;`
  closeBtn.onmouseenter = () => (closeBtn.style.background = btnBg)
  closeBtn.onmouseleave = () => (closeBtn.style.background = "transparent")
  closeBtn.onclick = () => {
    mediaQuery.removeEventListener("change", updateTheme)
    overlay.remove()
  }

  header.append(titleGroup, closeBtn)

  const body = document.createElement("div")
  body.className = "settings-body"
  body.style.cssText = "flex: 1; min-height: 0; display: flex;"

  const tabs = document.createElement("div")
  tabs.className = "settings-tabs"

  const panels = document.createElement("div")
  panels.className = "settings-panels"

  const createToggleRow = (label, desc, key, initialValue) => {
    const row = document.createElement("div")
    row.className = "settings-row"

    const info = document.createElement("div")
    const l = document.createElement("div")
    l.className = "settings-label"
    l.textContent = label
    const d = document.createElement("div")
    d.className = "settings-desc"
    d.textContent = desc
    info.append(l, d)

    const toggle = document.createElement("div")
    toggle.className = `toggle ${initialValue ? "active" : ""}`
    const knob = document.createElement("div")
    knob.className = "toggle-knob"
    toggle.appendChild(knob)

    toggle.onclick = () => {
      const active = toggle.classList.toggle("active")
      ipcRenderer.send("update-setting", { key, value: active })
    }

    row.append(info, toggle)
    return row
  }

  const createActionRow = (label, desc, buttonLabel, onClick) => {
    const row = document.createElement("div")
    row.className = "settings-row"

    const info = document.createElement("div")
    const l = document.createElement("div")
    l.className = "settings-label"
    l.textContent = label
    const d = document.createElement("div")
    d.className = "settings-desc"
    d.textContent = desc
    info.append(l, d)

    const btn = document.createElement("button")
    btn.className = "settings-btn"
    btn.textContent = buttonLabel
    btn.onclick = onClick

    row.append(info, btn)
    return row
  }

  const formatThemeLabel = (theme) => {
    const map = {
      default: "Default",
      oled: "OLED Dark",
      nord: "Nord",
      dracula: "Dracula",
      solarized: "Solarized Dark",
      highcontrast: "High Contrast",
      alternative: "[EXP] Alternative Look",
      crimson: "Crimson",
      electriccrimson: "Electric Crimson",
      neoncoral: "Neon Coral",
      infernoorange: "Inferno Orange",
      solargold: "Solar Gold",
      acidlime: "Acid Lime",
      emeraldflash: "Emerald Flash",
      cyberteal: "Cyber Teal",
      electricblue: "Electric Blue",
      ultraviolet: "Ultraviolet",
      hotmagenta: "Hot Magenta",
      compact: "Compact Mode",
    }
    return map[theme] || "Default"
  }

  // Privacy Section
  const privacySection = document.createElement("div")
  privacySection.className = "settings-section"
  const privacyTitle = document.createElement("h4")
  privacyTitle.innerHTML = `${ICONS.lock} Privacy & Stealth`
  privacySection.append(privacyTitle)
  privacySection.append(
    createToggleRow(
      "Block Read Receipts",
      "Others won't know when you read messages.",
      "blockReadReceipts",
      config.blockReadReceipts
    )
  )
  privacySection.append(
    createToggleRow(
      "Block Active Status",
      "Appear offline but still see others.",
      "blockActiveStatus",
      config.blockActiveStatus
    )
  )
  privacySection.append(
    createToggleRow(
      "Block Typing Indicator",
      'Hide "typing..." while you compose.',
      "blockTypingIndicator",
      config.blockTypingIndicator
    )
  )
  privacySection.append(
    createToggleRow(
      "[EXP] Typing Overlay (Better Typing Block)",
      "Experimental: hides typing by using a proxy input overlay.",
      "expTypingOverlay",
      config.expTypingOverlay
    )
  )
  privacySection.append(
    createToggleRow(
      "Clipboard Sanitizer",
      "Remove tracking data from pasted URLs.",
      "clipboardSanitize",
      config.clipboardSanitize
    )
  )
  privacySection.append(
    createToggleRow(
      "Keyword Alerts",
      "Notify you when keywords appear.",
      "keywordAlertsEnabled",
      config.keywordAlertsEnabled
    )
  )
  privacySection.append(
    createActionRow("Edit Keywords", "Add or remove keyword triggers.", "Edit", () => {
      overlay.remove()
      ipcRenderer.send("edit-keywords")
    })
  )

  // Appearance Section
  const appearanceSection = document.createElement("div")
  appearanceSection.className = "settings-section"
  const appearanceTitle = document.createElement("h4")
  appearanceTitle.innerHTML = `${ICONS.ghost} Appearance`
  appearanceSection.append(appearanceTitle)
  appearanceSection.append(
    createToggleRow(
      "Modern Look (Floating)",
      "A lighter, floating UI design.",
      "modernLook",
      config.modernLook
    )
  )
  appearanceSection.append(
    createToggleRow(
      "Floating Glass (Theme Override)",
      "Premium glassmorphism aesthetics.",
      "floatingGlass",
      config.floatingGlass
    )
  )
  appearanceSection.append(
    createToggleRow(
      "[EXP] Android Bubbles",
      "Rounded Android-style chat bubbles.",
      "androidBubbles",
      config.androidBubbles
    )
  )
  appearanceSection.append(
    createActionRow(
      "Theme",
      `Current: ${formatThemeLabel(config.theme)}`,
      "Choose",
      () => {
        overlay.remove()
        ipcRenderer.send("pick-theme")
      }
    )
  )

  // Customization controls
  const customRow = document.createElement("div")
  customRow.className = "settings-row"
  customRow.style.marginTop = "12px"

  const cssBtn = document.createElement("button")
  cssBtn.className = "settings-btn"
  cssBtn.textContent = "Edit Custom CSS"
  cssBtn.onclick = () => {
    overlay.remove()
    ipcRenderer.send("edit-custom-css")
  }

  const themeBtn = document.createElement("button")
  themeBtn.className = "settings-btn primary"
  themeBtn.textContent = "Theme Creator"
  themeBtn.onclick = () => window.open("https://mstheme.pcstyle.dev", "_blank")

  customRow.append(cssBtn, themeBtn)
  appearanceSection.append(customRow)

  // System Section
  const systemSection = document.createElement("div")
  systemSection.className = "settings-section"
  const systemTitle = document.createElement("h4")
  systemTitle.textContent = "System & Tools"
  systemSection.append(systemTitle)
  systemSection.append(
    createToggleRow(
      "Do Not Disturb",
      "Mute notifications from Messenger.",
      "doNotDisturb",
      config.doNotDisturb
    )
  )
  systemSection.append(
    createToggleRow(
      "Always on Top",
      "Keep Messenger above other windows.",
      "alwaysOnTop",
      config.alwaysOnTop
    )
  )
  systemSection.append(
    createToggleRow(
      "Launch at Login",
      "Start the app automatically.",
      "launchAtLogin",
      config.launchAtLogin
    )
  )
  systemSection.append(
    createToggleRow(
      "Spell Check",
      "Check spelling as you type.",
      "spellCheck",
      config.spellCheck
    )
  )

  // Power Tools Section
  const powerSection = document.createElement("div")
  powerSection.className = "settings-section"
  const powerTitle = document.createElement("h4")
  powerTitle.textContent = "Power Tools"
  powerSection.append(powerTitle)
  powerSection.append(
    createToggleRow(
      "Quiet Hours",
      "Auto-enable Do Not Disturb on a schedule.",
      "quietHoursEnabled",
      config.quietHoursEnabled
    )
  )
  powerSection.append(
    createActionRow(
      "Quiet Hours Schedule",
      `Current: ${config.quietHoursLabel || "Not set"}`,
      "Set Hours",
      () => {
        overlay.remove()
        ipcRenderer.send("edit-quiet-hours")
      }
    )
  )
  powerSection.append(
    createActionRow(
      "Quick Replies",
      `Configure ${config.quickReplies ? config.quickReplies.length : 0} shortcuts.`,
      "Edit",
      () => {
        overlay.remove()
        ipcRenderer.send("edit-quick-replies")
      }
    )
  )

  // Shortcuts Section
  const shortcutSection = document.createElement("div")
  shortcutSection.className = "settings-section"
  const shortcutTitle = document.createElement("h4")
  shortcutTitle.textContent = "Keyboard Shortcuts"
  shortcutSection.append(shortcutTitle)

  const shortcutsDesc = document.createElement("div")
  shortcutsDesc.textContent = "Click on a shortcut to record a new one. Press Escape to cancel."
  shortcutsDesc.style.cssText = `font-size: 12px; color: ${subTextColor}; margin-bottom: 12px;`
  shortcutSection.append(shortcutsDesc)

  const shortcutList = document.createElement("div")

  const friendlyNames = {
    toggleAlwaysOnTop: "Always on Top",
    toggleDoNotDisturb: "Do Not Disturb",
    toggleFocusMode: "Focus Mode",
    createPipWindow: "Picture-in-Picture",
    focusSearch: "Search",
    scheduleSendNow: "Send Scheduled",
    bossKey: "Boss Key (Chameleon)",
  }

  const renderShortcuts = () => {
    shortcutList.innerHTML = ""
    const currentShortcuts = config.shortcuts || {}
    Object.entries(currentShortcuts).forEach(([action, accelerator]) => {
      const row = document.createElement("div")
      row.className = "settings-row"

      const label = document.createElement("div")
      label.className = "settings-label"
      label.textContent = friendlyNames[action] || action

      const keyDisplay = document.createElement("button")
      keyDisplay.className = "settings-btn"
      keyDisplay.textContent = accelerator || "Not Set"
      keyDisplay.style.fontFamily = "Menlo, Monaco, monospace"
      keyDisplay.style.minWidth = "80px"

      keyDisplay.onclick = () => {
        keyDisplay.textContent = "Recording..."
        keyDisplay.classList.add("primary")

        const handler = (e) => {
          e.preventDefault()
          if (e.key === "Escape") {
            keyDisplay.textContent = accelerator
            keyDisplay.classList.remove("primary")
            document.removeEventListener("keydown", handler)
            return
          }

          const keys = []
          if (e.metaKey) keys.push("CmdOrCtrl")
          if (e.ctrlKey && !e.metaKey) keys.push("CmdOrCtrl")
          if (e.altKey) keys.push("Alt")
          if (e.shiftKey) keys.push("Shift")

          if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return

          let char = e.key.toUpperCase()
          if (char === " ") char = "Space"
          if (char === "ENTER") char = "Enter"
          if (char === "ARROWUP") char = "Up"
          if (char === "ARROWDOWN") char = "Down"

          keys.push(char)
          const newAccelerator = keys.join("+")

          ipcRenderer.send("update-shortcut", { action, accelerator: newAccelerator })

          config.shortcuts[action] = newAccelerator
          renderShortcuts()

          document.removeEventListener("keydown", handler)
        }
        document.addEventListener("keydown", handler)
      }

      row.append(label, keyDisplay)
      shortcutList.append(row)
    })
  }

  renderShortcuts()
  shortcutSection.append(shortcutList)

  const makePanel = (id, titleText, sectionEl) => {
    const panel = document.createElement("div")
    panel.className = "settings-panel"
    panel.dataset.tab = id
    const panelTitle = document.createElement("div")
    panelTitle.className = "settings-panel-title"
    panelTitle.textContent = titleText
    panel.append(panelTitle, sectionEl)
    return panel
  }

  const privacyPanel = makePanel("privacy", "Privacy & Stealth", privacySection)
  const appearancePanel = makePanel("appearance", "Appearance", appearanceSection)
  const systemPanel = makePanel("system", "System & Tools", systemSection)
  const powerPanel = makePanel("power", "Power Tools", powerSection)
  const shortcutsPanel = makePanel("shortcuts", "Keyboard Shortcuts", shortcutSection)

  panels.append(appearancePanel, privacyPanel, systemPanel, powerPanel, shortcutsPanel)

  const tabItems = [
    { id: "appearance", label: "Appearance" },
    { id: "privacy", label: "Privacy" },
    { id: "system", label: "System" },
    { id: "power", label: "Power Tools" },
    { id: "shortcuts", label: "Shortcuts" },
  ]

  const setActiveTab = (id) => {
    tabs.querySelectorAll(".settings-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === id)
    })
    panels.querySelectorAll(".settings-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tab === id)
    })
  }

  tabItems.forEach((tab) => {
    const btn = document.createElement("button")
    btn.className = "settings-tab"
    btn.type = "button"
    btn.dataset.tab = tab.id
    btn.textContent = tab.label
    btn.onclick = () => setActiveTab(tab.id)
    tabs.appendChild(btn)
  })

  setActiveTab("appearance")

  const footer = document.createElement("div")
  footer.className = "close-area"

  footerHint = document.createElement("div")
  footerHint.textContent = "Some changes may require a reload."
  footerHint.style.cssText = `font-size: 11px; color: ${subTextColor};`

  const doneBtn = document.createElement("button")
  doneBtn.textContent = "Done"
  doneBtn.className = "settings-btn primary"
  doneBtn.style.padding = "10px 24px"
  doneBtn.onclick = () => overlay.remove()

  footer.append(footerHint, doneBtn)

  body.append(tabs, panels)
  modal.append(header, body, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  updateTheme()

  overlay.onclick = (e) => {
    if (e.target === overlay) {
      mediaQuery.removeEventListener("change", updateTheme)
      overlay.remove()
    }
  }
}

'use strict'

const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, screen, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')

function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'synaptic.config.json'), 'utf8'))
    return cfg.port || 3777
  } catch {
    return parseInt(process.env.SYNAPTIC_PORT || '3777', 10)
  }
}
const PORT = readPort()
let hudWindow = null
let serverProcess = null
let tray = null
let forceQuit = false

// ── Server ────────────────────────────────────────────────────────────────────

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${port} "') do taskkill /F /PID %a`,
        { stdio: 'ignore', shell: true }
      )
    } else {
      require('child_process').execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' })
    }
  } catch {}
}

function startServer() {
  killPort(PORT)
  const cwd = path.join(__dirname, '..')
  const hasDist = fs.existsSync(path.join(cwd, 'dist', 'index.js'))
  // process.execPath in Electron points to the Electron binary, not node.
  // Use 'node' from PATH (always available in dev); tsx for source mode.
  const cmd = hasDist ? 'node' : path.join(cwd, 'node_modules', '.bin', 'tsx')
  const args = hasDist ? ['dist/index.js'] : ['src/index.ts']
  serverProcess = spawn(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '1' } })
  serverProcess.on('error', (e) => console.error('[Electron] Server error:', e.message))
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`http://localhost:${PORT}/api/stats`, (res) => {
        if (res.statusCode === 200) { res.resume(); resolve() } else retry()
      })
      req.on('error', retry)
      req.setTimeout(800, () => { req.destroy(); retry() })
    }
    const retry = () => retries-- > 0 ? setTimeout(attempt, 1000) : reject(new Error('Server timeout'))
    attempt()
  })
}

// ── HUD ───────────────────────────────────────────────────────────────────────

function createHUD() {
  const { workArea } = screen.getPrimaryDisplay()
  const w = 380, h = 540
  hudWindow = new BrowserWindow({
    width: w, height: h,
    x: workArea.x + workArea.width - w - 20,
    y: workArea.y + workArea.height - h - 20,
    alwaysOnTop: true, frame: false, skipTaskbar: true,
    resizable: false, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  hudWindow.on('close', (e) => { if (!forceQuit) { e.preventDefault(); hudWindow.hide() } })
  hudWindow.on('destroyed', () => { hudWindow = null })
  waitForServer()
    .then(() => { if (hudWindow && !hudWindow.isDestroyed()) hudWindow.loadURL(`http://localhost:${PORT}/hud`) })
    .catch(() => { if (hudWindow && !hudWindow.isDestroyed()) hudWindow.loadURL(`data:text/html,<body style="background:#0a0d11;color:#ff6b6b;font-family:monospace;padding:20px">Server failed to start.</body>`) })
}

function toggleHUD() {
  try {
    if (!hudWindow || hudWindow.isDestroyed()) { createHUD(); return }
    if (hudWindow.isVisible()) hudWindow.hide()
    else { hudWindow.show(); hudWindow.focus() }
  } catch { hudWindow = null; createHUD() }
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function buildTrayMenu() {
  const launchAtLogin = app.getLoginItemSettings().openAtLogin
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide HUD   ⌘⇧S', click: toggleHUD },
    { label: 'Open dashboard', click: () => shell.openExternal(`http://localhost:${PORT}`) },
    { type: 'separator' },
    { label: 'Launch at Login', type: 'checkbox', checked: launchAtLogin,
      click: () => { app.setLoginItemSettings({ openAtLogin: !launchAtLogin }); buildTrayMenu() } },
    { type: 'separator' },
    { label: 'Quit', click: () => { forceQuit = true; app.quit() } },
  ]))
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide()
  startServer()
  createHUD()
  globalShortcut.register('CommandOrControl+Shift+S', toggleHUD)

  // Push-to-talk: Cmd+Shift+V
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (!hudWindow || hudWindow.isDestroyed()) { createHUD(); return }
    if (!hudWindow.isVisible()) { hudWindow.show(); hudWindow.focus() }
    hudWindow.webContents.executeJavaScript('typeof toggleVoice !== "undefined" && toggleVoice()').catch(() => {})
  })

  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Synaptic  (⌘⇧S)')
  tray.on('click', toggleHUD)
  buildTrayMenu()
})

app.on('before-quit', () => { forceQuit = true })
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (serverProcess) serverProcess.kill() })
app.on('window-all-closed', (e) => e.preventDefault())

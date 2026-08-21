import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import readline from "node:readline"

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function resolvePaths(env = process.env, home = os.homedir()) {
  const codexHome = env.CODEX_HOME || path.join(home, ".codex")
  const managerHome = env.CODEX_ACCOUNT_HOME || path.join(home, ".codex-account")
  return { codexHome, auth: path.join(codexHome, "auth.json"), sessions: path.join(codexHome, "sessions"), managerHome, accounts: path.join(managerHome, "accounts") }
}

function resolveOpenCodePaths(env = process.env, home = os.homedir()) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return {
    auth: env.OPENCODE_AUTH_FILE || path.join(dataHome, "opencode", "auth.json"),
    accounts: env.OPENCODE_ACCOUNT_HOME || path.join(dataHome, "opencode", "accounts"),
  }
}

async function privateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await fsp.lstat(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} must be a regular directory`)
  await fsp.chmod(dir, 0o700).catch(() => {})
}

async function readJson(file, fallback) {
  try {
    const stat = await fsp.lstat(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${file} must be a regular file`)
    return JSON.parse(await fsp.readFile(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}`)
    throw error
  }
}

async function atomicJson(file, value) {
  await privateDir(path.dirname(file))
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  await fsp.chmod(tmp, 0o600).catch(() => {})
  try { await fsp.rename(tmp, file) }
  catch (error) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw error }
  await fsp.chmod(file, 0o600).catch(() => {})
}

function accountDir(root, name) {
  if (!NAME.test(name || "")) throw new Error("Account name must use 1-64 letters, numbers, dots, dashes, or underscores")
  return path.join(root, name)
}

function validateAuth(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error(`Missing Codex credentials in ${source}`)
  return value
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function jwtClaims(token) {
  if (typeof token !== "string" || token.split(".").length !== 3) return null
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) } catch { return null }
}

function stableIdentity(value) {
  const candidates = []
  function visit(item) {
    if (!item || typeof item !== "object") return
    for (const [key, child] of Object.entries(item)) {
      if (typeof child === "string") {
        const normalized = key.toLowerCase()
        if (["account_id", "accountid", "chatgpt_account_id", "email"].includes(normalized)) candidates.push(`${normalized}:${child}`)
        const claims = jwtClaims(child)
        if (claims) {
          for (const claim of ["chatgpt_account_id", "account_id", "email", "sub"]) if (typeof claims[claim] === "string") candidates.push(`${claim}:${claims[claim]}`)
        }
      } else visit(child)
    }
  }
  visit(value)
  return candidates.length ? fingerprint([...new Set(candidates)].sort()) : null
}

function findString(value, wanted) {
  if (!value || typeof value !== "object") return null
  for (const [key, child] of Object.entries(value)) {
    if (wanted.includes(key.toLowerCase()) && typeof child === "string") return child
    const nested = findString(child, wanted)
    if (nested) return nested
  }
  return null
}

function findClaim(value, wanted) {
  if (!value || typeof value !== "object") return null
  for (const child of Object.values(value)) {
    if (typeof child === "string") {
      const claims = jwtClaims(child)
      const match = claims ? findString(claims, wanted) : null
      if (match) return match
    } else {
      const nested = findClaim(child, wanted)
      if (nested) return nested
    }
  }
  return null
}

export async function fetchAccountLimits(auth, fetchImpl = globalThis.fetch) {
  const token = findString(auth, ["access_token", "accesstoken"])
  if (!token) throw new Error("No Codex OAuth access token; run 'codex login' and save this account again")
  const accountId = findString(auth, ["account_id", "accountid", "chatgpt_account_id"]) || findClaim(auth, ["account_id", "accountid", "chatgpt_account_id"])
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "codex-account-switcher-local/0.1" }
  if (accountId) headers["ChatGPT-Account-Id"] = accountId
  const response = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error(`Codex login expired or unauthorized (${response.status}); run 'codex login' and save again with --force`)
    throw new Error(`Codex usage service returned HTTP ${response.status}`)
  }
  const data = await response.json()
  if (!data || typeof data !== "object") throw new Error("Codex usage service returned an invalid response")
  return { observedAt: Date.now(), limits: data }
}

function sameAccount(a, b) {
  const left = stableIdentity(a); const right = stableIdentity(b)
  return left && right ? left === right : fingerprint(a) === fingerprint(b)
}

async function jsonlFiles(root) {
  const found = []
  async function walk(dir) {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (error) { if (error.code === "ENOENT") return; throw error }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push({ file, mtime: (await fsp.stat(file)).mtimeMs })
    }
  }
  await walk(root)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 50)
}

function findRateLimits(value) {
  if (!value || typeof value !== "object") return null
  if (Object.hasOwn(value, "rate_limits") && value.rate_limits && typeof value.rate_limits === "object") return value.rate_limits
  for (const child of Object.values(value)) {
    const result = findRateLimits(child)
    if (result) return result
  }
  return null
}

export async function latestLocalLimits(sessions) {
  const files = await jsonlFiles(sessions)
  let latest = null
  for (const { file, mtime } of files) {
    const input = fs.createReadStream(file, { encoding: "utf8" })
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    for await (const line of lines) {
      try {
        const record = JSON.parse(line)
        const limits = findRateLimits(record)
        if (limits) {
          const stamp = Date.parse(record.timestamp || record.time || "")
          const observedAt = Number.isFinite(stamp) ? stamp : mtime
          if (!latest || observedAt >= latest.observedAt) latest = { observedAt, limits }
        }
      } catch {}
    }
  }
  return latest
}

function usagePercent(window) {
  const used = window?.used_percent ?? window?.usedPercent ?? window?.utilization
  if (typeof used !== "number" || !Number.isFinite(used)) return null
  const normalized = used <= 1 && window?.utilization === used ? used * 100 : used
  return Math.max(0, Math.min(100, normalized))
}

function bar(used, width = 24) {
  if (used === null) return `[${"?".repeat(width)}]`
  const filled = Math.round((used / 100) * width)
  return `[${"\u2588".repeat(filled)}${"\u2591".repeat(width - filled)}]`
}

function windowLabel(fallback, window) {
  const minutes = window?.window_minutes ?? window?.windowMinutes ?? (typeof window?.limit_window_seconds === "number" ? window.limit_window_seconds / 60 : undefined)
  if (minutes === 300) return "5-hour"
  if (minutes === 10080) return "Weekly"
  if (typeof minutes === "number") {
    if (minutes % 10080 === 0) return `${minutes / 10080}-week`
    if (minutes % 1440 === 0) return `${minutes / 1440}-day`
    if (minutes % 60 === 0) return `${minutes / 60}-hour`
  }
  return fallback
}

function reset(window) {
  const raw = window?.reset_at ?? window?.resets_at ?? window?.resetAt
  if (raw === undefined || raw === null) return ""
  const date = new Date(typeof raw === "number" && raw < 1e12 ? raw * 1000 : raw)
  return Number.isNaN(date.valueOf()) ? "" : `, resets ${date.toLocaleString()}`
}

function resetCountdown(window) {
  const raw = window?.reset_at ?? window?.resets_at ?? window?.resetAt
  if (raw === undefined || raw === null) return ""
  const target = new Date(typeof raw === "number" && raw < 1e12 ? raw * 1000 : raw)
  if (Number.isNaN(target.valueOf())) return ""
  const remaining = Math.max(0, target.valueOf() - Date.now())
  if (remaining === 0) return "reset due now"
  const totalMinutes = Math.ceil(remaining / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days) return `resets in ${days}d${hours ? ` ${hours}h` : ""}`
  if (hours) return `resets in ${hours}h${minutes ? ` ${minutes}m` : ""}`
  return `resets in ${minutes}m`
}

export function formatLimits(snapshot) {
  if (!snapshot) return ["Limits unavailable: Codex has not recorded a usable local snapshot yet."]
  const age = Math.max(0, Date.now() - snapshot.observedAt)
  const mins = Math.floor(age / 60000)
  const lines = [`Recorded ${new Date(snapshot.observedAt).toLocaleString()} (${mins < 1 ? "less than a minute" : `${mins} minute(s)`} ago)`]
  const source = snapshot.limits?.rate_limit ?? snapshot.limits
  const windows = []
  const primary = source.primary_window ?? source.primary
  const secondary = source.secondary_window ?? source.secondary
  if (primary) windows.push([windowLabel("Primary", primary), primary])
  if (secondary) windows.push([windowLabel("Secondary", secondary), secondary])
  const additional = snapshot.limits?.additional_rate_limits ?? source.additional_rate_limits
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const name = item.display_name || item.name || item.limit_name || "Additional"
      if (item.primary) windows.push([`${name} ${windowLabel("primary", item.primary)}`, item.primary])
      if (item.secondary) windows.push([`${name} ${windowLabel("secondary", item.secondary)}`, item.secondary])
      if (!item.primary && !item.secondary) windows.push([name, item])
    }
  }
  if (!windows.length) windows.push(["Usage", source])
  for (const [label, window] of windows) {
    const used = usagePercent(window)
    const detail = used === null ? "usage unknown" : `${Math.round(100 - used)}% left \u00b7 ${Math.round(used)}% used`
    lines.push(`${label.padEnd(12)} ${bar(used)} ${detail}${reset(window)}`)
  }
  return lines
}

function ansi(code, text) { return `\x1b[${code}m${text}\x1b[0m` }
function visibleLength(text) { return text.replace(/\x1b\[[0-9;]*m/g, "").length }
function pad(text, width) { return text + " ".repeat(Math.max(0, width - visibleLength(text))) }
function clip(text, width) { return visibleLength(text) <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…` }

function quotaWindows(snapshot) {
  if (!snapshot) return []
  const source = snapshot.limits?.rate_limit ?? snapshot.limits
  const result = []
  const primary = source.primary_window ?? source.primary
  const secondary = source.secondary_window ?? source.secondary
  if (primary) result.push([windowLabel("Primary", primary), primary])
  if (secondary) result.push([windowLabel("Secondary", secondary), secondary])
  return result
}

function tuiQuotaLines(snapshot, width, selected) {
  const available = Math.max(30, width - 4)
  const barWidth = Math.max(8, Math.min(20, available - (available >= 58 ? 36 : 25)))
  const windows = quotaWindows(snapshot)
  if (!windows.length) return [ansi("2", "usage unavailable")]
  const lines = []
  for (const [label, window] of windows) {
    const used = usagePercent(window)
    if (used === null) lines.push(`${label.padEnd(9)} ${ansi("2", "usage unknown")}`)
    else {
      const left = Math.round(100 - used)
      const filled = Math.round((used / 100) * barWidth)
      const meter = `[${"\u2588".repeat(filled)}${"\u2591".repeat(barWidth - filled)}]`
      const color = left <= 15 ? "31" : left <= 50 ? "33" : "32"
      const detail = available >= 58 ? `${left}% left · ${Math.round(used)}% used` : `${left}% left`
      lines.push(clip(`${label.padEnd(9)} ${ansi(color, meter)}  ${selected ? ansi("37", detail) : ansi("2", detail)}`, available))
    }
    const countdown = resetCountdown(window)
    if (countdown) lines.push(`${" ".repeat(10)}${ansi("2", countdown)}`)
  }
  return lines
}

function quotaHealth(row) {
  if (row.error) return ["33", "Usage unavailable"]
  if (row.loading) return ["2", "Refreshing…"]
  const window = quotaWindows(row.snapshot)[0]?.[1]
  const used = usagePercent(window)
  if (used === null || used === undefined) return ["2", "status unavailable"]
  const left = Math.round(100 - used)
  if (left <= 15) return ["31", `${left}% left`]
  if (left <= 50) return ["33", `${left}% left`]
  return ["32", `${left}% left`]
}

function detailsFor(row, provider, width) {
  if (!row) return [ansi("2", "Select an account to view details.")]
  if (provider === "opencode") {
    return [
      ansi("1;37", row.name),
      "",
      row.active ? ansi("32", "● Active in OpenCode") : ansi("2", "○ Saved OpenCode profile"),
      "",
      ansi("2", "Enter switches the active credential."),
      ansi("2", "Restart OpenCode after switching."),
    ]
  }
  if (row.error) return [ansi("1;37", row.name), "", ansi("33", "Usage unavailable"), ansi("2", clip(row.error, width))]
  const windows = quotaWindows(row.snapshot)
  if (!windows.length) return [ansi("1;37", row.name), "", ansi("2", "No quota information returned.")]
  const [label, primary] = windows[0]
  const used = usagePercent(primary)
  const left = used === null ? null : Math.round(100 - used)
  const barWidth = Math.max(10, Math.min(24, width - 16))
  const filled = used === null ? 0 : Math.round((used / 100) * barWidth)
  const meter = `[${"\u2588".repeat(filled)}${"\u2591".repeat(barWidth - filled)}]`
  const color = left === null ? "2" : left <= 15 ? "31" : left <= 50 ? "33" : "32"
  const lines = [
    ansi("1;37", row.name),
    row.active ? ansi("32", "● Active Codex login") : ansi("2", "○ Saved Codex profile"),
    "",
    ansi("2", label.toUpperCase()),
    left === null ? ansi("2", "Usage unknown") : ansi(`1;${color}`, `${left}% remaining`),
    ansi(color, meter),
  ]
  const reset = resetCountdown(primary)
  if (reset) lines.push(ansi("2", reset))
  if (windows.length > 1) lines.push("", ansi("2", `+ ${windows.length - 1} additional limit${windows.length === 2 ? "" : "s"} available`))
  return lines
}

function buildStackedDashboard(rows, selected, message, width, provider, tabs, summary) {
  const lines = [
    width < 55 ? tabs : `${tabs}   ${ansi("2", summary)}`,
    ...(width < 55 ? [ansi("2", summary)] : []),
    ansi("2", provider === "codex" ? "fresh quota · no tokens shown or stored" : "local switching · credentials remain in OpenCode storage"),
    "",
  ]
  if (!rows.length) lines.push(ansi("2", "  No saved accounts. Press a to save the current login."), "")
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]; const isSelected = index === selected
    const marker = isSelected ? ansi("1;36", "›") : " "
    const name = ansi(isSelected ? "1;37" : "37", row.name)
    const active = row.active ? `  ${ansi("32", "● active")}` : ""
    lines.push(`${marker} ${name}${active}`)
    if (provider === "codex") {
      if (row.loading) lines.push(`    ${ansi("2", "refreshing usage…")}`)
      else if (row.error) lines.push(`    ${ansi("33", "Usage unavailable")}`)
      else for (const line of tuiQuotaLines(row.snapshot, width, isSelected)) lines.push(`    ${line}`)
    }
    else lines.push(`    ${ansi("2", row.active ? "currently selected in OpenCode" : "saved local profile")}`)
    lines.push("")
  }
  lines.push(ansi("2", "←→ tabs   ↑↓ move   enter switch"), ansi("2", "r refresh  a add     d delete   q quit"))
  if (message) lines.push("", ansi("36", `  ${clip(message, width - 2)}`))
  return lines.join("\n")
}

export function buildDashboard(rows, selected = 0, message = "", terminalWidth = 80, provider = "codex") {
  const width = Math.max(38, Math.min(112, terminalWidth - 1))
  const activeCount = rows.filter((row) => row.active).length
  const codexTab = provider === "codex" ? ansi("30;46", " CODEX ") : ansi("2", " Codex ")
  const openCodeTab = provider === "opencode" ? ansi("30;46", " OPENCODE ") : ansi("2", " OpenCode ")
  const tabs = `${codexTab}  ${openCodeTab}`
  const summary = `${rows.length} saved · ${activeCount ? "active login found" : "no active login"}`
  return buildStackedDashboard(rows, selected, message, width, provider, tabs, summary)

  /* Wide split-pane layout retained below temporarily for easy recovery.
  const leftWidth = Math.max(24, Math.min(32, Math.floor(width * 0.34)))
  const rightWidth = width - leftWidth - 3
  const selectedRow = rows[selected]
  const left = [ansi("1;36", "ACCOUNTS")]
  if (!rows.length) left.push(ansi("2", "No saved accounts."))
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]; const active = row.active ? " ●" : ""
    const health = provider === "codex" ? quotaHealth(row) : [row.active ? "32" : "2", row.active ? "active" : "saved"]
    const prefix = index === selected ? ansi("1;36", "›") : " "
    const account = clip(`${prefix} ${row.name}${active}`, leftWidth - 1)
    left.push(index === selected ? ansi("46;30", pad(account, leftWidth)) : pad(account, leftWidth))
    left.push(`  ${ansi(health[0], health[1])}`)
  }
  const right = [ansi("1;36", provider === "codex" ? "QUOTA & STATUS" : "OPEN CODE STATUS"), "", ...detailsFor(selectedRow, provider, rightWidth - 2)]
  const height = Math.max(left.length, right.length, 8)
  const lines = [
    `${tabs}   ${ansi("2", summary)}`,
    ansi("2", provider === "codex" ? "fresh quota · no tokens shown or stored" : "local switching · credentials remain in OpenCode storage"),
    ansi("2;36", `${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}`),
  ]
  for (let index = 0; index < height; index++) lines.push(`${pad(left[index] || "", leftWidth)}${ansi("2;36", "│")}${pad(right[index] || "", rightWidth)}`)
  lines.push(ansi("2;36", `${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}`))
  lines.push(ansi("2", "←→ tabs   ↑↓ navigate   enter switch   r refresh   a add   d delete   q quit"))
  if (message) lines.push("", ansi("36", `  ${clip(message, width - 2)}`))
  return lines.join("\n") */
}

async function promptLine(question, stdin, stdout) {
  if (stdin.isTTY) stdin.setRawMode(false)
  stdout.write(`\x1b[?25h\n${question}`)
  const reader = readline.createInterface({ input: stdin, output: stdout })
  const answer = await new Promise((resolve) => reader.question("", resolve))
  reader.close()
  if (stdin.isTTY) stdin.setRawMode(true)
  stdout.write("\x1b[?25l")
  return answer.trim()
}

export async function runTui(paths, fetchImpl = globalThis.fetch, stdin = process.stdin, stdout = process.stdout) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("The terminal UI requires an interactive terminal")
  readline.emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write("\x1b[?1049h\x1b[?25l")
  const openCodePaths = resolveOpenCodePaths(process.env, os.homedir())
  let selected = 0; let rows = []; let message = ""; let provider = "codex"
  const draw = () => stdout.write(`\x1b[H\x1b[2J${buildDashboard(rows, selected, message, stdout.columns || 80, provider)}`)
  const load = async () => {
    if (provider === "opencode") rows = await loadOpenCodeRows(openCodePaths)
    else {
      const activeAuth = await readJson(paths.auth, null)
      const all = await names(paths.accounts)
      rows = await Promise.all(all.map(async (name) => {
        const auth = validateAuth(await readJson(path.join(accountDir(paths.accounts, name), "auth.json")), `account '${name}'`)
        const active = activeAuth ? sameAccount(auth, activeAuth) : false
        try { return { name, active, snapshot: await fetchAccountLimits(auth, fetchImpl), provider: "codex" } }
        catch (error) { return { name, active, error: error.message, provider: "codex" } }
      }))
    }
    selected = Math.min(selected, Math.max(0, rows.length - 1))
    draw()
  }
  const cleanup = () => {
    stdin.setRawMode(false); stdin.pause(); stdout.write("\x1b[?25h\x1b[?1049l")
  }
  try {
    draw(); await load()
    await new Promise((resolve, reject) => {
      let busy = false
      const handle = async (_text, key) => {
        if (busy) return
        try {
          if (key.name === "q" || (key.ctrl && key.name === "c")) { stdin.off("keypress", handle); resolve(); return }
          if (key.name === "tab" || key.name === "left" || key.name === "right") { busy = true; provider = provider === "codex" ? "opencode" : "codex"; selected = 0; message = ""; await load(); busy = false }
          else if (key.name === "up" || key.name === "k") selected = Math.max(0, selected - 1)
          else if (key.name === "down" || key.name === "j") selected = Math.min(rows.length - 1, selected + 1)
          else if (key.name === "r") { busy = true; message = "Refreshing every saved account…"; draw(); await load(); message = "Usage refreshed."; busy = false }
          else if (key.name === "return" && rows[selected]) {
            busy = true
            const name = rows[selected].name
            if (provider === "opencode") { await switchOpenCode(openCodePaths, name); message = `OpenCode switched to ${name}. Restart OpenCode.` }
            else {
              const auth = validateAuth(await readJson(path.join(accountDir(paths.accounts, name), "auth.json")), `account '${name}'`)
              await atomicJson(paths.auth, auth); await activate(paths, name); message = `Codex switched to ${name}. Completely restart Codex.`
            }
            await load(); busy = false
          } else if (key.name === "a") {
            busy = true
            const name = await promptLine(`Save current ${provider === "codex" ? "Codex" : "OpenCode"} login as: `, stdin, stdout)
            if (name) {
              if (provider === "opencode") await saveOpenCodeCurrent(openCodePaths, name)
              else {
                const dir = accountDir(paths.accounts, name); const file = path.join(dir, "auth.json")
                try { await fsp.lstat(file); throw new Error(`Account '${name}' already exists`) }
                catch (error) {
                  if (error.code !== "ENOENT") throw error
                  const auth = validateAuth(await readJson(paths.auth), paths.auth)
                  await privateDir(dir); await atomicJson(file, auth); await activate(paths, name)
                }
              }
              message = `Saved '${name}'.`
              await load()
            }
            busy = false
          } else if (key.name === "d" && rows[selected]) {
            busy = true
            const name = rows[selected].name
            const answer = await promptLine(`Type DELETE ${name} to confirm: `, stdin, stdout)
            if (answer === `DELETE ${name}`) {
              if (provider === "opencode") await fsp.unlink(path.join(openCodePaths.accounts, `${name}.json`))
              else await fsp.rm(accountDir(paths.accounts, name), { recursive: true })
              message = `Deleted saved profile '${name}'. Active login unchanged.`; await load()
            }
            else message = "Delete cancelled."
            busy = false
          }
          draw()
        } catch (error) { busy = false; message = `Error: ${error.message}`; draw() }
      }
      stdin.on("keypress", handle)
    })
  } finally { cleanup() }
}

async function activationTime(paths, name) {
  if (!name) return null
  const meta = await readJson(path.join(accountDir(paths.accounts, name), "meta.json"), null)
  return typeof meta?.activatedAt === "number" ? meta.activatedAt : null
}

async function eligibleLimits(paths, name) {
  const activatedAt = await activationTime(paths, name)
  if (activatedAt === null) return null
  const snapshot = await latestLocalLimits(paths.sessions)
  return snapshot && snapshot.observedAt >= activatedAt ? snapshot : null
}

async function activate(paths, name) {
  const dir = accountDir(paths.accounts, name)
  const metaFile = path.join(dir, "meta.json")
  const previous = await readJson(metaFile, {})
  if (previous.attributionVersion !== 2) await fsp.rm(path.join(dir, "limits.json"), { force: true })
  await atomicJson(metaFile, { attributionVersion: 2, activatedAt: Date.now() })
}

async function capture(paths, name) {
  if (!name) return
  const snapshot = await eligibleLimits(paths, name)
  if (snapshot) await atomicJson(path.join(accountDir(paths.accounts, name), "limits.json"), snapshot)
}

async function names(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort()
}

async function openCodeNames(root) {
  let entries
  try { entries = await fsp.readdir(root, { withFileTypes: true }) }
  catch (error) { if (error.code === "ENOENT") return []; throw error }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5)).filter((name) => NAME.test(name)).sort()
}

async function loadOpenCodeRows(paths) {
  const auth = await readJson(paths.auth, {})
  const active = auth.openai
  return Promise.all((await openCodeNames(paths.accounts)).map(async (name) => {
    const credential = await readJson(path.join(paths.accounts, `${name}.json`))
    return { name, active: Boolean(active && sameAccount(credential, active)), provider: "opencode" }
  }))
}

async function switchOpenCode(paths, name) {
  const credential = validateAuth(await readJson(path.join(paths.accounts, `${name}.json`)), `OpenCode account '${name}'`)
  const auth = await readJson(paths.auth, {})
  await atomicJson(paths.auth, { ...auth, openai: credential })
}

async function saveOpenCodeCurrent(paths, name) {
  accountDir(paths.accounts, name)
  const auth = await readJson(paths.auth)
  const credential = validateAuth(auth.openai, paths.auth)
  await privateDir(paths.accounts)
  const file = path.join(paths.accounts, `${name}.json`)
  try { await fsp.lstat(file); throw new Error(`Account '${name}' already exists`) }
  catch (error) { if (error.code !== "ENOENT") throw error }
  await atomicJson(file, credential)
}

async function currentName(paths, auth) {
  for (const name of await names(paths.accounts)) {
    const saved = await readJson(path.join(accountDir(paths.accounts, name), "auth.json"), null)
    if (saved && sameAccount(saved, auth)) return name
  }
  return null
}

export async function run(argv, io = console, env = process.env, home = os.homedir(), fetchImpl = globalThis.fetch) {
  const [command, name, ...flags] = argv
  const paths = resolvePaths(env, home)
  if (!command || ["help", "--help", "-h"].includes(command)) {
    io.log("Usage: codex-account <ui|list|save|switch|delete|limits|paths> [name] [--force]")
    return 0
  }
  if (command === "paths") {
    io.log(`Codex auth: ${paths.auth}`); io.log(`Saved accounts: ${paths.accounts}`); return 0
  }
  await privateDir(paths.accounts)
  if (command === "ui") return runTui(paths, fetchImpl)
  if (command === "save") {
    const dir = accountDir(paths.accounts, name); const file = path.join(dir, "auth.json")
    if (!flags.includes("--force")) {
      try { await fsp.lstat(file); throw new Error(`Account '${name}' already exists; use --force to replace it`) }
      catch (error) { if (error.code !== "ENOENT") throw error }
    }
    const auth = validateAuth(await readJson(paths.auth), paths.auth)
    await privateDir(dir); await atomicJson(file, auth)
    await activate(paths, name)
    io.log(`Saved Codex account '${name}' locally.`); return 0
  }
  if (command === "switch") {
    validateAuth(await readJson(paths.auth), paths.auth)
    const selected = validateAuth(await readJson(path.join(accountDir(paths.accounts, name), "auth.json")), `account '${name}'`)
    await atomicJson(paths.auth, selected)
    await activate(paths, name)
    io.log(`Switched Codex login to '${name}'. Completely restart Codex before using it.`); return 0
  }
  if (command === "delete") {
    if (!flags.includes("--force")) throw new Error("Delete requires --force")
    await fsp.rm(accountDir(paths.accounts, name), { recursive: true })
    io.log(`Deleted saved Codex account '${name}'. The active Codex login was not changed.`); return 0
  }
  if (command === "list") {
    const auth = await readJson(paths.auth, null); const active = auth ? await currentName(paths, auth) : null
    const all = await names(paths.accounts)
    if (!all.length) io.log("No saved Codex accounts.")
    for (const item of all) io.log(`${item === active ? "*" : " "} ${item}`)
    return 0
  }
  if (command === "limits") {
    if (name && name !== "--all") {
      const savedAuth = validateAuth(await readJson(path.join(accountDir(paths.accounts, name), "auth.json")), `account '${name}'`)
      io.log(`Account: ${name} (fresh reading)`)
      try { for (const line of formatLimits(await fetchAccountLimits(savedAuth, fetchImpl))) io.log(line) }
      catch (error) { io.log(`Limits unavailable: ${error.message}`) }
      return 0
    }
    const all = await names(paths.accounts)
    if (!all.length) {
      io.log("No saved Codex accounts.")
      return 0
    }
    for (let index = 0; index < all.length; index++) {
      const account = all[index]
      if (index) io.log("")
      io.log(`Account: ${account} (fresh reading)`)
      const savedAuth = validateAuth(await readJson(path.join(accountDir(paths.accounts, account), "auth.json")), `account '${account}'`)
      try { for (const line of formatLimits(await fetchAccountLimits(savedAuth, fetchImpl))) io.log(line) }
      catch (error) { io.log(`Limits unavailable: ${error.message}`) }
    }
    io.log("")
    io.log("Fresh read-only results from Codex's usage service; credentials were not logged or cached.")
    return 0
  }
  throw new Error(`Unknown command '${command}'`)
}

export async function main(argv) { process.exitCode = await run(argv.length ? argv : ["ui"]) }

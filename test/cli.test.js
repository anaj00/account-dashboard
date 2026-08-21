import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildDashboard, fetchAccountLimits, formatLimits, latestLocalLimits, run } from "../src/cli.js"

async function fixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-account-test-"))
  const env = { CODEX_HOME: path.join(home, "codex"), CODEX_ACCOUNT_HOME: path.join(home, "manager") }
  await fsp.mkdir(path.join(env.CODEX_HOME, "sessions"), { recursive: true })
  return { home, env, auth: path.join(env.CODEX_HOME, "auth.json"), sessions: path.join(env.CODEX_HOME, "sessions") }
}
const output = () => { const lines = []; return { lines, log: (x) => lines.push(x) } }
const jwt = (claims, suffix = "sig") => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${suffix}`

test("save, switch, list and delete use isolated synthetic credentials", async () => {
  const f = await fixture(); const io = output()
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { access_token: "personal" } }))
  await run(["save", "personal"], io, f.env, f.home)
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { access_token: "work" } }))
  await run(["save", "work"], io, f.env, f.home)
  await run(["switch", "personal"], io, f.env, f.home)
  assert.equal(JSON.parse(await fsp.readFile(f.auth, "utf8")).tokens.access_token, "personal")
  await run(["list"], io, f.env, f.home)
  assert(io.lines.includes("* personal"))
  await assert.rejects(run(["delete", "work"], io, f.env, f.home), /--force/)
  await run(["delete", "work", "--force"], io, f.env, f.home)
})

test("reads newest non-null nested rate limit snapshot", async () => {
  const f = await fixture()
  const file = path.join(f.sessions, "rollout.jsonl")
  await fsp.writeFile(file, [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", payload: { rate_limits: null } }),
    JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", payload: { token_count: { rate_limits: { primary: { used_percent: 25, window_minutes: 300, reset_at: 1768000000 } } } } })
  ].join("\n"))
  const result = await latestLocalLimits(f.sessions)
  assert.equal(result.limits.primary.used_percent, 25)
  const lines = formatLimits(result)
  assert(lines.some((line) => line.includes("5-hour")))
  assert(lines.some((line) => line.includes("75% left · 25% used")))
  assert(lines.some((line) => line.includes("██████░░░░░░░░░░░░░░░░░░")))
})

test("renders unknown usage without inventing percentages", () => {
  const lines = formatLimits({ observedAt: Date.now(), limits: { primary: { window_minutes: 10080 } } })
  assert(lines.some((line) => line.includes("Weekly")))
  assert(lines.some((line) => line.includes("usage unknown")))
})

test("rejects traversal names and accidental overwrite", async () => {
  const f = await fixture(); const io = output()
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { access_token: "x" } }))
  await assert.rejects(run(["save", "../bad"], io, f.env, f.home), /Account name/)
  await run(["save", "one"], io, f.env, f.home)
  await assert.rejects(run(["save", "one"], io, f.env, f.home), /already exists/)
})

test("recognizes an account after its token bytes refresh", async () => {
  const f = await fixture(); const io = output()
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { id_token: jwt({ sub: "stable-user", email: "me@example.test" }, "old") } }))
  await run(["save", "personal"], io, f.env, f.home)
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { id_token: jwt({ sub: "stable-user", email: "me@example.test" }, "new") } }))
  await run(["list"], io, f.env, f.home)
  assert(io.lines.includes("* personal"))
})

test("default limits view fetches every saved account independently", async () => {
  const f = await fixture(); const io = output()
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { access_token: "personal" } }))
  await run(["save", "personal"], io, f.env, f.home)
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { access_token: "work" } }))
  await run(["save", "work"], io, f.env, f.home)
  io.lines.length = 0
  const seen = []
  const fakeFetch = async (_url, options) => {
    seen.push(options.headers.Authorization)
    const used = options.headers.Authorization.includes("personal") ? 10 : 20
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } } }) }
  }
  await run(["limits"], io, f.env, f.home, fakeFetch)
  assert(io.lines.includes("Account: personal (fresh reading)"))
  assert(io.lines.includes("Account: work (fresh reading)"))
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
})

test("does not attribute an older account's quota after switching", async () => {
  const f = await fixture(); const io = output()
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { access_token: "personal" } }))
  await run(["save", "personal"], io, f.env, f.home)
  const old = new Date(Date.now() - 60_000).toISOString()
  await fsp.writeFile(path.join(f.sessions, "old.jsonl"), JSON.stringify({ timestamp: old, payload: { rate_limits: { primary: { used_percent: 7 } } } }))
  await fsp.writeFile(f.auth, JSON.stringify({ tokens: { access_token: "work" } }))
  await run(["save", "work"], io, f.env, f.home)
  io.lines.length = 0
  const fakeFetch = async () => ({ ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 0 } } }) })
  await run(["limits"], io, f.env, f.home, fakeFetch)
  const workIndex = io.lines.indexOf("Account: work (fresh reading)")
  assert(workIndex >= 0)
  assert(io.lines.slice(workIndex).some((line) => line.includes("100% left")))
  assert(!io.lines.slice(workIndex).some((line) => line.includes("93% left")))
})

test("usage request sends only the selected bearer token", async () => {
  const secret = "secret-access-token"
  let request
  const fakeFetch = async (url, options) => {
    request = { url, options }
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 4 } } }) }
  }
  const result = await fetchAccountLimits({ tokens: { access_token: secret } }, fakeFetch)
  assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage")
  assert.equal(request.options.headers.Authorization, `Bearer ${secret}`)
  assert.equal(request.options.redirect, "error")
  assert.equal(result.limits.rate_limit.primary_window.used_percent, 4)
  assert(!JSON.stringify(result).includes(secret))
})

test("terminal dashboard renders accounts, state, bars, and controls", () => {
  const view = buildDashboard([
    { name: "personal", active: true, snapshot: { observedAt: Date.now(), limits: { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } } } },
    { name: "work", active: false, error: "login expired" },
  ], 0, "Ready")
  assert(view.includes("CODEX"))
  assert(view.includes("OpenCode"))
  assert(view.includes("personal"))
  assert(view.includes("active"))
  assert(view.includes("75% left"))
  assert(view.includes("work"))
  assert(view.includes("Usage unavailable"))
  assert(view.includes("switch"))
  assert(!view.includes("access_token"))
})

test("terminal dashboard keeps the compact layout on wide terminals", () => {
  const view = buildDashboard([
    { name: "personal", active: true, snapshot: { limits: { rate_limit: { primary_window: { used_percent: 25, reset_at: Math.floor(Date.now() / 1000) + 3600 } } } } },
    { name: "work", active: false, error: "login expired" },
  ], 0, "", 100)
  const plain = view.replace(/\x1b\[[0-9;]*m/g, "")
  assert(plain.includes("personal"))
  assert(plain.includes("75% left"))
  assert.match(plain, /resets in (59m|1h)/)
  assert(plain.includes("Usage unavailable"))
})

test("wide OpenCode dashboard keeps status separate from quota", () => {
  const view = buildDashboard([{ name: "work", active: true }], 0, "", 100, "opencode")
  const plain = view.replace(/\x1b\[[0-9;]*m/g, "")
  assert(plain.includes("OPENCODE"))
  assert(plain.includes("currently selected in OpenCode"))
  assert(!plain.includes("fresh quota"))
})

test("terminal dashboard fits a narrow terminal", () => {
  const view = buildDashboard([
    { name: "personal-account-with-a-long-name", active: true, snapshot: { observedAt: Date.now(), limits: { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } } } },
  ], 0, "A deliberately long status message that should be clipped", 50)
  const plain = view.replace(/\x1b\[[0-9;]*m/g, "")
  for (const line of plain.split("\n")) assert(line.length <= 49, `line too wide: ${line}`)
  assert(plain.includes("75% left"))
})

test("terminal dashboard shows quota reset countdown", () => {
  const resetAt = Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000)
  const view = buildDashboard([
    { name: "personal", active: true, snapshot: { observedAt: Date.now(), limits: { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: resetAt } } } } },
  ])
  const plain = view.replace(/\x1b\[[0-9;]*m/g, "")
  assert.match(plain, /resets in (1h 59m|2h)/)
})

test("terminal dashboard renders the separate OpenCode tab without quota claims", () => {
  const view = buildDashboard([{ name: "work", active: true, provider: "opencode" }], 0, "", 70, "opencode")
  const plain = view.replace(/\x1b\[[0-9;]*m/g, "")
  assert(plain.includes("OPENCODE"))
  assert(plain.includes("currently selected in OpenCode"))
  assert(!plain.includes("fresh quota"))
})

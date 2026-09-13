#!/usr/bin/env node
import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const env = {
  ...process.env,
  CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex-dashboard"),
  CODEX_ACCOUNT_HOME: process.env.CODEX_ACCOUNT_HOME || path.join(os.homedir(), ".codex-account-dashboard"),
}
const command = process.platform === "win32" ? "codex.cmd" : "codex"
await fsp.mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 })
await fsp.chmod(env.CODEX_HOME, 0o700).catch(() => {})
const child = spawn(command, process.argv.slice(2), { stdio: "inherit", env })
child.once("error", (error) => {
  console.error(error.code === "ENOENT" ? "Error: Codex is not installed or is not on PATH" : `Error: ${error.message}`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })

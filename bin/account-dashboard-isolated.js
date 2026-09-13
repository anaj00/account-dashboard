#!/usr/bin/env node
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { main } from "../src/cli.js"

// Keep dashboard profiles out of the default Codex home used by other apps.
process.env.CODEX_HOME ||= path.join(os.homedir(), ".codex-dashboard")
process.env.CODEX_ACCOUNT_HOME ||= path.join(os.homedir(), ".codex-account-dashboard")

main(process.argv.slice(2)).catch((error) => {
  console.error(`Error: ${error.message}`)
  process.exitCode = 1
})

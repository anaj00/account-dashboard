# Account Dashboard

A small, local terminal dashboard for switching between your own Codex and OpenCode logins.

It does not implement OAuth, send telemetry, run in the background, rotate accounts automatically, or print tokens. It simply saves local copies of credentials created by the official CLIs, then makes one chosen copy active when you ask it to.

## What you need

- Node.js 18 or newer
- Codex CLI, already installed
- An OpenAI account you are permitted to use with Codex
- Optional: OpenCode, if you want the second dashboard tab

## Install

From the project folder:

```powershell
npm install -g .
```

Open the dashboard:

```powershell
account-dashboard
```

`codex-account` is an equivalent command name.

## First-time Codex setup

Codex needs to keep its credentials in a file so this tool can safely save and switch local copies.

1. Open `%USERPROFILE%\.codex\config.toml`.
2. Add this line anywhere outside a `[section]` block:

   ```toml
   cli_auth_credentials_store = "file"
   ```

3. Log in normally:

   ```powershell
   codex login
   ```

4. Save that login under a short name:

   ```powershell
   codex-account save personal
   ```

5. Log in to the next account, then save it too:

   ```powershell
   codex login
   codex-account save work
   ```

Use names containing only letters, numbers, dots, dashes, and underscores.

## Everyday use

Start the dashboard with `account-dashboard`.

| Key | Action |
| --- | --- |
| Up/Down or J/K | Select an account |
| Left/Right or Tab | Switch between Codex and OpenCode |
| Enter | Make the selected account active |
| R | Refresh Codex usage (Codex tab) |
| O | Start OpenCode's normal login flow (OpenCode tab) |
| A | Save the currently active login under a new name |
| D | Delete a saved profile after confirmation |
| Q | Quit |

After switching a Codex account, completely quit and reopen Codex. After switching an OpenCode account, restart OpenCode. Both programs can retain the previous login in memory while they are running.

You can also use the Codex commands directly:

```powershell
codex-account list
codex-account switch personal
codex-account limits
codex-account limits work
codex-account delete work --force
codex-account paths
```

## Usage limits

The Codex tab can show each saved account's remaining usage, meter, and reset time. Refreshing limits makes a read-only request to Codex's usage service for that specific saved account.

Results are fresh, shown only in the terminal, and never written to disk. If an account is signed out or expired, sign in again with `codex login`, then replace the saved profile:

```powershell
codex-account save personal --force
```

The usage endpoint is internal and may change. The dashboard never guesses quota data when the service does not return it.

## OpenCode tab

The OpenCode tab is optional. It reads the active OpenCode credential file and any profiles saved in OpenCode's local account folder. It shows only saved/active state—never made-up quota data.

Use the dashboard's OpenCode tab to set up, save, switch, and delete those profiles. Press `O` to start OpenCode's own `auth login` flow; after it finishes, press `A` to save the new login under an account name. OpenCode must be restarted after a switch.

## Where credentials are stored

On Windows, `~` means `%USERPROFILE%`.

| Purpose | Default location |
| --- | --- |
| Active Codex login | `~/.codex/auth.json` |
| Saved Codex profiles | `~/.codex-account/accounts/<name>/auth.json` |
| Active OpenCode login | `~/.local/share/opencode/auth.json` |
| Saved OpenCode profiles | `~/.local/share/opencode/accounts/<name>.json` |

The exact paths can differ if you use environment variables such as `CODEX_HOME`, `CODEX_ACCOUNT_HOME`, `XDG_DATA_HOME`, `OPENCODE_AUTH_FILE`, or `OPENCODE_ACCOUNT_HOME`. Run this to check Codex paths:

```powershell
codex-account paths
```

These files contain plaintext credentials, just like Codex's file-backed login. Do not commit, share, upload, or sync them. Keep them outside this repository.

## Safety notes

- Codex and OpenCode authentication remain separate.
- The tool does not create or handle OAuth flows; `codex login` does that.
- No credentials are logged or cached during a limits refresh.
- Existing profiles require `--force` to overwrite; deletion requires `--force` in the command-line interface.
- Account names are restricted to prevent path traversal.

## Development

```powershell
npm test
```

The test suite uses synthetic credentials in a temporary directory and does not inspect your real login files.

## License

MIT

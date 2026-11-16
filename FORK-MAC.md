# Installing Zak's T3 Code fork on a Mac (instructions for an agent)

You are an agent on Zak's Apple Silicon Mac. Zak wants the fork of T3 Code built here and installed
next to the official T3 Code (Nightly), optionally with fork PR #1's MCP plugin. Follow these steps in
order. Run each check, and stop and report to Zak when one fails. Zak prefers short, blunt replies.

## This build

The `integration` branch of github.com/zrm625/t3code, as pushed on 2026-11-09T14:21Z:

- Base: T3 Code Nightly `0.1.8-nightly.20261109.4399`, upstream commit `357fb754fa9dae4111f0945fb8a13d30b012a62a`
- Merged on top: #1 (`pyre/installable-mcp-plugin`), #2 (`pyre/ghes-stack-fields`)
- The top commit only adds this file. The app is built from the commit before it.

## Rules

- **You probably run inside T3 Code (Nightly).** Quitting or updating Nightly, or opening the fork
  app, ends your session. Never do these yourself. Prepare everything, then hand those steps to Zak
  and say exactly what to do.
- **`~/.t3/userdata` is Zak's live data, shared by both apps.** Only copy it for the backup in step 3.
  Don't edit, move or delete anything in it, and don't run a T3 Code server against it.
- **Change T3 Code settings through Zak**, in the app's Settings, not by editing `settings.json`.
- **Never kill processes by name or pattern.**
- **Admin policy files** (`/etc/codex/…`, `/Library/Application Support/ClaudeCode/…`) belong to
  Zak's admin. Don't create or change them.

## Facts behind these steps

These are checked against this build's source, but nothing here has run on a Mac before. Report
anything that turns out different.

- **App and data.** The fork app is called **T3 Code (Beta)** and installs beside T3 Code (Nightly).
  Both use `~/.t3` and `~/Library/Application Support/t3code-v2`, so threads and settings carry over.
- **One app at a time.** If one app is running, opening the other only brings the running one to the
  front.
- **Same version.** An older build does not refuse a database that a newer build has upgraded. It
  runs with a warning, so a mismatch fails quietly. Keep Nightly at exactly the version above.
- **Missing from a local build:** auto-updates, T3 Connect, T3 account sign-in and passkeys. It is
  also unsigned, which is fine on the Mac that built it.
- **Saved remote connections** probably won't load in the Beta app, because macOS stores each app's
  encryption key under the app's name. Nightly keeps them. This is expected.
- **`t3code://` links** can open in either app, because both share the same app ID.

## 1. Check the machine

```sh
uname -m                     # must print arm64
xcode-select -p              # must print a path; else ask Zak to run: xcode-select --install
cargo --version              # Rust; if missing: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
vp --version                 # Vite+; if missing: curl -fsSL https://vite.plus | bash
defaults read "/Applications/T3 Code (Nightly).app/Contents/Info" CFBundleShortVersionString
```

The last command must print `0.1.8-nightly.20261109.4399`.

- **Older:** stop. Ask Zak to update Nightly, start it once, and tell you when it's done.
- **Newer:** stop. Tell Zak to run `t3-fork-build` on forge (or ask the agent there to), which
  refreshes this branch. Then start again from the top of the new copy of this file.

## 2. Build the app

Use a checkout outside `~/.t3`, for example `~/src/t3code-fork`:

```sh
git clone https://github.com/pingdotgg/t3code.git ~/src/t3code-fork   # skip if it already exists
cd ~/src/t3code-fork
git fetch https://github.com/zrm625/t3code.git integration
git switch --detach FETCH_HEAD
git merge-base --is-ancestor 357fb754fa9dae4111f0945fb8a13d30b012a62a HEAD && echo base-ok
vp i
vp run dist:desktop:dmg
ls release/*.dmg
```

Check: `base-ok` is printed, and a file `release/T3-Code-<version>-arm64.dmg` exists. The build stops
early with a clear message if `cargo`, `clang`, `make`, `sips` or `iconutil` is missing. Pass that
message on to Zak.

## 3. Back up Zak's data

This needs both apps closed. If you're running inside Nightly, ask Zak to make the copy, or to quit
Nightly and run it from Terminal:

```sh
cp -c -R ~/.t3/userdata ~/t3-userdata-backup-$(date +%Y%m%d)
```

`cp -c` makes an APFS clone: instant, and it takes no extra space until files change. Don't skip this
step.

## 4. Install the app

```sh
hdiutil attach release/T3-Code-*-arm64.dmg -nobrowse -mountpoint /tmp/t3-fork-dmg
ditto "/tmp/t3-fork-dmg/T3 Code (Beta).app" "/Applications/T3 Code (Beta).app"
hdiutil detach /tmp/t3-fork-dmg
```

Check: `/Applications/T3 Code (Beta).app` exists, and `/Applications/T3 Code (Nightly).app` is still
there.

## 5. PR #1 plugin (only if Zak wants it)

This is for Macs whose admin policy allows MCP servers only from approved plugins. It has never run on
macOS, so step 7 is the real test.

```sh
cd ~/src/t3code-fork
cargo build --locked --release --manifest-path native/t3-mcp-plugin/Cargo.toml
mkdir -p ~/.local/share/t3-mcp/bin
install -m755 native/t3-mcp-plugin/target/release/t3-codex native/t3-mcp-plugin/target/release/t3-claude ~/.local/share/t3-mcp/bin/
rm -rf ~/.local/share/t3-mcp/plugin
cp -R native/t3-mcp-plugin/plugin ~/.local/share/t3-mcp/plugin

codex plugin marketplace add ~/.local/share/t3-mcp/plugin
codex plugin add t3-code@t3
claude plugin marketplace add ~/.local/share/t3-mcp/plugin
claude plugin install t3-code@t3
```

If a `plugin` command is refused by policy (for example, only approved marketplaces are allowed),
stop. Tell Zak the plugin's source has to be approved by their admin.

Checks:

```sh
codex --version; claude --version   # need codex >= 0.167.0, claude >= 2.1.319
~/.local/share/t3-mcp/bin/t3-codex --version    # runs the real codex; must print its version
~/.local/share/t3-mcp/bin/t3-claude --version   # runs the real claude; must print its version
jq '.providerInstances // {} | map_values({driver, setupMode: .config.setupMode, binaryPath: .config.binaryPath})' ~/.t3/userdata/settings.json
```

- **Wrappers:** each finds the first real `codex` or `claude` on `PATH` that isn't itself. T3 Code
  gives them the PATH of Zak's login shell.
- **Codex setup mode:** if the Codex instance shows `setupMode: "managed"`, tell Zak to switch Codex
  to their own install. A managed Codex ignores the binary path and is older than 0.167.0.

Then give Zak the values to enter in **Settings → Providers** (a leading `~` works):

- **Codex binary path:** `~/.local/share/t3-mcp/bin/t3-codex`
- **Claude binary path:** `~/.local/share/t3-mcp/bin/t3-claude`

The wrappers also work under Nightly, as long as Nightly is the same version as this build.

### Optional: the Unix socket

Only if Zak's Mac blocks MCP over local TCP. Ask Zak before doing this:

```sh
mkdir -m700 -p ~/.t3/mcp
launchctl setenv T3CODE_MCP_SOCKET "$HOME/.t3/mcp/mcp.sock"
```

- **Setting it:** use `launchctl`, not `.zshrc`. T3 Code doesn't take this variable from the login
  shell. The setting is lost when the Mac restarts.
- **Only the Beta app** has the socket feature. Under Nightly, the wrappers use TCP.
- **If T3 Code (Beta) won't start after this** (missing folder, path over about 103 characters,
  socket in use), run `launchctl unsetenv T3CODE_MCP_SOCKET` and have Zak open it again.

## 6. Hand over to Zak

Tell Zak, in this order:

1. Quit T3 Code (Nightly).
2. Open T3 Code (Beta) from Applications.
3. If you did step 5, set the two binary paths in Settings → Providers.
4. To go back: quit T3 Code (Beta), open T3 Code (Nightly).
5. If something breaks: quit both, move `~/.t3/userdata` aside, and copy the backup from step 3 back
   to `~/.t3/userdata`. Anything that changed since the backup is lost.

## 7. Check it works (Zak, or an agent inside the Beta app)

- **The right app is running.** In T3 Code (Beta), About shows the upstream commit above.
- **The plugin works (if you did step 5).** Start a new thread on Claude Haiku or Codex Luna and
  send: "Call the T3 Code tool t3_project_list once and reply with the number of projects."
  - A number: the plugin works.
  - No T3 Code tools: check the plugin install and the binary paths.
  - Claude not found on the very first launch: quit and reopen the app so it picks up the shell's
    PATH.

## Report back

Send Zak a short report:

- each step: done, skipped, or failed (with the error)
- the Nightly version, and the path of the backup
- anything that differed from "Facts behind these steps" above

## Updating later

When Nightly updates:

1. Have `t3-fork-build` rerun on forge. That refreshes this branch and this file.
2. Repeat steps 1–4, and step 5's build and install lines if the plugin is in use.
3. Never run the Beta app on a database Nightly has upgraded past the Beta's version.

# Installing Zak's T3 Code fork on a Mac (instructions for an agent)

You are an agent on Zak's Apple Silicon Mac. Zak wants the fork of T3 Code built here and installed
next to the official T3 Code (Nightly), optionally with fork PR #1's MCP plugin. Follow these steps in
order. Run each check, and stop and report to Zak when one fails. Zak prefers short, blunt replies.

## This build

The `integration` branch of github.com/zrm625/t3code, refreshed on 2026-11-25:

- Base Nightly is `0.1.13-nightly.20261125.5245` at upstream commit `1c3f0ee88fc75440e173704cf45eae4d15f2cf95`.
- Fork PR #1 uses the bundled `t3 mcp-bridge` command for the marketplace plugin.
- Fork PR #2 fixes GitHub Enterprise Server pull request reads. Nightly includes the Codex Full Access approval fix.
- Fork PR #4 adds Quick Composer. Enable its shortcut in **Settings → Quick Composer**.
- The build commands pin commit `04b0164b415fe3df03a0e511fe1d74f478762af9`.
- The local version is `0.1.13-preview.20261125.1`. This preview keeps the Beta app name and has no update feed.

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
- **Same source base.** The fork uses the source of the Nightly release above, with no fork database
  migrations. An older build can run against a newer database with only a warning. Keep Nightly at
  exactly that release while both apps share data; the fork's preview version is deliberately different.
- **Local build.** This guide produces an unsigned preview without auto-updates. Account sign-in and
  T3 Connect depend on build configuration; this guide does not configure them or macOS passkey signing.
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

The last command must print `0.1.13-nightly.20261125.5245`.

- **Older:** stop. Ask Zak to update Nightly, start it once, and tell you when it's done.
- **Newer:** stop. Refresh the fork's integration branch against that Nightly's source and update
  this guide before building. Then start again from the top of the new copy of this file.

## 2. Build the app

Use a checkout outside `~/.t3`, for example `~/src/t3code-fork`:

```sh
git clone https://github.com/pingdotgg/t3code.git ~/src/t3code-fork   # skip if it already exists
cd ~/src/t3code-fork
git fetch https://github.com/zrm625/t3code.git integration
git switch --detach 04b0164b415fe3df03a0e511fe1d74f478762af9
git merge-base --is-ancestor 1c3f0ee88fc75440e173704cf45eae4d15f2cf95 HEAD && echo base-ok
vp i
vp run dist:desktop:dmg --arch arm64 --build-version 0.1.13-preview.20261125.1
ls release/T3-Code-0.1.13-preview.20261125.1-arm64.dmg
```

Check: `base-ok` is printed, and the named DMG exists. The build stops
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
hdiutil attach release/T3-Code-0.1.13-preview.20261125.1-arm64.dmg -nobrowse -mountpoint /tmp/t3-fork-dmg
ditto "/tmp/t3-fork-dmg/T3 Code (Beta).app" "/Applications/T3 Code (Beta).app"
hdiutil detach /tmp/t3-fork-dmg
```

Check: `/Applications/T3 Code (Beta).app` exists, and `/Applications/T3 Code (Nightly).app` is still
there.

## 5. Add the MCP plugin (optional)

Use the plugin when Zak wants T3 tools on a Mac that allows MCP servers only from approved plugins.
The plugin uses Beta’s bundled `t3 mcp-bridge` command. If the `t3` marketplace points to the earlier
wrapper-based install, remove that plugin and marketplace registration in the affected provider
before adding the current marketplace.

Run the commands for the providers Zak wants from the pinned build checkout.

```sh
cd ~/src/t3code-fork
codex plugin marketplace add "$PWD/packaging/mcp-plugin/plugin"
codex plugin add t3-code@t3
claude plugin marketplace add "$PWD/packaging/mcp-plugin/plugin"
claude plugin install t3-code@t3
```

If the CLI refuses the marketplace, report the policy error to Zak. Use the
[plugin README](packaging/mcp-plugin/README.md) for the approved marketplace layout.

## 6. Hand over to Zak

Tell Zak, in this order:

1. Quit T3 Code (Nightly).
2. Open T3 Code (Beta) from Applications.
3. If you did step 5, open **Settings → About** in Beta and select **Install** next to **t3 command**.
   Open a new terminal and check that `t3 --version` prints `0.1.13-preview.20261125.1`.
   If a provider still points to the older `t3-codex` or `t3-claude` wrapper, restore its usual binary path in **Settings → Providers**.
4. To go back: quit T3 Code (Beta), open T3 Code (Nightly).
5. If something breaks: quit both, move `~/.t3/userdata` aside, and copy the backup from step 3 back
   to `~/.t3/userdata`. Anything that changed since the backup is lost.

## 7. Check it works (Zak, or an agent inside the Beta app)

- **The right app is running.** In T3 Code (Beta), About shows version
  `0.1.13-preview.20261125.1` and build commit `04b0164b415f`.
- **The plugin works (if you did step 5).** Start a new thread on Claude Haiku or Codex Luna and
  send: "Call the T3 Code tool t3_project_list once and reply with the number of projects."
  - A number: the plugin works.
  - No T3 Code tools: check the plugin install and confirm `t3 --version` matches Beta.
  - Claude not found on the very first launch: quit and reopen the app so it picks up the shell's
    PATH.

## Report back

Send Zak a short report:

- each step: done, skipped, or failed (with the error)
- the Nightly version, and the path of the backup
- anything that differed from "Facts behind these steps" above

## Updating later

When Nightly updates:

1. Sync the fork's integration branch with the new Nightly's source, retain the PR changes that are
   still needed, and refresh this file's source commit, Nightly release, and preview version together.
2. Repeat steps 1–4. Refresh the marketplace plugin if its files changed and reinstall Beta’s `t3` command after switching.
3. Never run the Beta app on a database Nightly has upgraded past the fork's source base.

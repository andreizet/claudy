<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Claudy" width="128" />
</p>

<h1 align="center">Claudy</h1>

<p align="center">
  A cross-platform desktop GUI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>
</p>

<p align="center">
  <a href="https://github.com/andreizet/claudy/releases/latest"><img src="https://img.shields.io/github/v/release/andreizet/claudy?style=flat-square" alt="Latest Release" /></a>
  <a href="https://github.com/andreizet/claudy/blob/main/LICENSE"><img src="https://img.shields.io/github/license/andreizet/claudy?style=flat-square" alt="License" /></a>
  <a href="https://github.com/andreizet/claudy/actions"><img src="https://img.shields.io/github/actions/workflow/status/andreizet/claudy/release.yml?style=flat-square" alt="Build Status" /></a>
  <a href="https://github.com/andreizet/claudy/releases"><img src="https://img.shields.io/github/downloads/andreizet/claudy/total?style=flat-square" alt="Downloads" /></a>
</p>

---

Claudy is a local-first desktop application that wraps [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in a modern graphical interface. It lets you manage multiple projects, track sessions, monitor usage, and interact with Claude through a rich chat UI — all without leaving your desktop.

## Features

### Multi-Project Workspace

- Open multiple projects in tabs, each with independent state
- Star/favorite projects for quick access
- Search, sort, and filter your project list
- Auto-discovered from your existing Claude Code sessions

### Chat Interface

- Real-time message streaming with thinking blocks, tool use, and tool results
- Markdown rendering with syntax-highlighted code blocks
- File reference badges with inline diffs
- Autocomplete for slash commands (`/compact`, `/model`, `/review`, etc.) and file references (`@file`)
- Interactive terminal sessions via integrated xterm.js
- Session pinning, renaming, and management

### Skills Ecosystem

- Browse and install skills from a built-in catalog
- Install community skills from GitHub repositories or local folders
- Includes pre-configured skills: algorithmic art, frontend design, MCP builder, web artifacts, webapp testing, and more

### Settings & Configuration

- Model selection
- Per-session and global tool permission management
- MCP (Model Context Protocol) server configuration
- YOLO mode for rapid execution
- Persistent tab state across sessions
- Built-in auto-updater

### Usage Dashboard

- Track token usage and costs across sessions, models, and projects
- Daily usage charts (sessions, messages, tokens, cost)
- Model breakdown (input/output tokens, cost per model)
- Project breakdown (sessions, messages, file modifications, last activity)
- Filter by interval: 7 days, 30 days, 90 days, or all-time

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) must be installed and authenticated on your machine
- An active Anthropic account with a Claude Code subscription

## Download & Install

Download the latest release for your platform from the [Releases page](https://github.com/andreizet/claudy/releases/latest).

| Platform            | File                              |
| ------------------- | --------------------------------- |
| Windows x64         | `.msi` or `.exe` (NSIS installer) |
| macOS Apple Silicon | `.dmg` (aarch64)                  |
| macOS Intel         | `.dmg` (x64)                      |
| Linux x64           | `.deb` or `.AppImage`             |

### Windows

1. Download the `.msi` or `.exe` installer
2. Run the installer. Windows may show a **SmartScreen** warning since the app is unsigned
3. Click **"More info"** then **"Run anyway"** to proceed

### macOS

Since Claudy is not signed with an Apple Developer certificate, macOS will block it by default. To install:

1. Download the `.dmg` for your architecture (Apple Silicon or Intel)

2. Open the `.dmg` and drag **Claudy** to your **Applications** folder

3. **Do not** double-click to open it yet. Instead, open **Terminal** and run:
   
   ```bash
   xattr -cr /Applications/Claudy.app
   ```

4. Now open Claudy from your Applications folder normally

> **Why?** macOS quarantines apps downloaded from the internet. The `xattr -cr` command removes the quarantine flag so Gatekeeper won't block the unsigned app.

If you skipped step 3 and see *"Claudy is damaged and can't be opened"* or *"Apple cannot verify this app"*, run the `xattr` command above and try again.

### Linux

#### Debian / Ubuntu (.deb)

```bash
sudo dpkg -i claudy_*.deb
```

#### AppImage

```bash
chmod +x Claudy_*.AppImage
./Claudy_*.AppImage
```

## Building from Source

### Requirements

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

### Steps

```bash
# Clone the repository
git clone https://github.com/andreizet/claudy.git
cd claudy

# Install dependencies
npm ci

# Run in development mode (with hot reload)
npm run tauri dev

# Build for production
npm run tauri build
```

Build artifacts will be in `src-tauri/target/release/bundle/`.

### Running Tests

```bash
npm test
```

## Tech Stack

- **Frontend**: React 18, TypeScript, [Mantine](https://mantine.dev/) UI, Vite
- **Backend**: Rust, [Tauri 2](https://v2.tauri.app/)
- **Terminal**: xterm.js with PTY support
- **State**: TanStack React Query, localStorage persistence

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes and add tests where appropriate
4. Run `npm test` and ensure everything passes
5. Commit your changes and push to your fork
6. Open a Pull Request

Please open an issue first to discuss significant changes before submitting a PR.

## Roadmap

See [open issues](https://github.com/andreizet/claudy/issues) for planned features and known bugs.

## License

[MIT](LICENSE) &copy; andreizet

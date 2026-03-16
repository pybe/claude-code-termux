# Claude Code on Termux

Getting [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic's CLI) running natively on Android via [Termux](https://termux.dev/).

## Tested With

| Component | Version |
|-----------|---------|
| Claude Code | 2.1.76 |
| Bun (embedded) | 1.3.11 |
| Termux | Latest from F-Droid |
| Android | arm64 |

These instructions may work with newer versions but have been specifically tested with the above.

## The Problem

Claude Code is distributed as a native binary — a Bun-compiled executable linked against glibc. Termux uses Android's Bionic libc, so:

```
$ claude
cannot execute: required file not found
```

The standard `grun` (glibc-runner) workaround partially works — the binary executes, but Bun falls back to plain CLI mode instead of running Claude Code. This is because `grun` uses `execve()` to launch via `ld.so`, which updates `/proc/self/exe` to point at the linker. Bun reads `/proc/self/exe` to find its embedded JavaScript payload — when it points at `ld.so`, it finds nothing.

Additionally, Claude Code hardcodes `/tmp` for sandbox directories, which is unwritable on Android.

## Solution

Three layers of workarounds:

1. **[bun-termux-loader](https://github.com/kaan-escober/bun-termux-loader)** — userland exec wrapper that preserves `/proc/self/exe` so Bun can find its embedded payload
2. **proot** — redirects `/tmp` to Termux's writable tmp directory and provides `/bin/sh`
3. **Bun environment fix** — patches a bug where Bun on glibc/Termux can't read the `environ` pointer

## Quick Start

### Prerequisites

```bash
pkg update && pkg upgrade
pkg install clang glibc-repo glibc-runner python git proot
echo 'export TMPDIR=$PREFIX/tmp' >> ~/.bashrc
source ~/.bashrc
```

### 1. Build bun-termux-loader

```bash
cd ~
git clone https://github.com/kaan-escober/bun-termux-loader.git
cd bun-termux-loader
make
```

### 2. Download and wrap the Claude Code binary

```bash
VERSION=$(curl -fsSL https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest)
mkdir -p ~/.claude/downloads
curl -fsSL -o ~/.claude/downloads/claude \
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/$VERSION/linux-arm64/claude"
chmod +x ~/.claude/downloads/claude

cd ~/bun-termux-loader
python3 build.py ~/.claude/downloads/claude ~/.local/bin/claude
echo "Built Claude Code $VERSION"
```

This creates a ~229MB self-contained binary at `~/.local/bin/claude` that embeds the C wrapper, Bun runtime, Claude Code JS payload, native `.node` libraries, and the BunFS shim.

### 3. Install the proot wrapper

The proot wrapper redirects `/tmp` and `/bin/sh` so Claude Code's Bash tool and hooks work:

```bash
cat > ~/.local/bin/claude-termux << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exec proot --bind=$PREFIX/tmp:/tmp --bind=$PREFIX/bin/bash:/bin/sh ~/.local/bin/claude "$@"
EOF
chmod +x ~/.local/bin/claude-termux
```

**Important naming convention:** `claude` is the real binary. `claude-termux` is the proot wrapper. This matters because hooks and sub-processes inside Claude Code call `claude` directly — if `claude` were the proot wrapper, those calls would nest proot (ptrace inside ptrace), which deadlocks on Android. See [Avoiding nested proot](#avoiding-nested-proot).

### 4. Install the self-healing launcher

```bash
cp wrappers/cl ~/.local/bin/cl
chmod +x ~/.local/bin/cl
```

Always launch Claude Code via `cl`:

```bash
cl              # interactive mode
cl -p "hello"   # print mode
cl --version    # version check
```

`cl` automatically detects if the binary has been overwritten by an auto-update, rebuilds it, and launches Claude via `claude-termux` — so you never have to think about it.

### 5. Verify

```bash
cl --version
# Should output: X.X.X (Claude Code)

cl -p "say hello"
# Should respond with a greeting

# Verify Bash tool works:
cl -p "run echo hello"
# Should execute the command and show output
```

## Bun Environment Fix (for PAI / hooks that use Bun)

If you run custom hooks or tools that use Bun directly (outside of Claude Code), Bun on glibc/Termux has a bug where `process.env` returns zero entries. This section is only needed if you use standalone Bun scripts.

### Install the preload fix

```bash
mkdir -p ~/.local/share/bun-termux
cp fix-env.js ~/.local/share/bun-termux/fix-env.js
```

### Install the Bun wrapper

```bash
cp wrappers/bun ~/.local/bin/bun
chmod +x ~/.local/bin/bun
```

The wrapper uses `grun` to run the Bun binary extracted by bun-termux-loader, applies the env fix preload, and filters harmless Android stderr noise.

## Updating

Claude Code auto-updates can replace the bun-termux-loader wrapper with a raw native binary. If you use `cl`, this is handled automatically. For manual rebuilds:

```bash
cp wrappers/rebuild-claude-wrapper ~/.local/bin/rebuild-claude-wrapper
chmod +x ~/.local/bin/rebuild-claude-wrapper
```

After an auto-update breaks things, run:

```bash
rebuild-claude-wrapper
```

## How It Works

### Why grun alone fails

1. `grun ./claude` calls `execve("/path/to/ld-linux-aarch64.so.1", ["ld.so", "./claude", ...], envp)`
2. Kernel updates `/proc/self/exe` to point at `ld-linux-aarch64.so.1`
3. Bun starts, reads `/proc/self/exe`, opens `ld-linux-aarch64.so.1`
4. Scans last 4096 bytes for `---- Bun! ----` magic trailer — **not found**
5. Falls back to plain Bun CLI mode

### Why bun-termux-loader works

1. Wrapper extracts Bun ELF to `$TMPDIR/bun-termux-cache/` (cached after first run)
2. Wrapper calls `mmap()` on glibc's `ld.so` and jumps to its entry point directly — **no `execve()`**
3. Kernel does NOT update `/proc/self/exe` (only happens on `execve`)
4. Bun starts, reads `/proc/self/exe`, finds the original wrapper binary
5. Scans for `---- Bun! ----` trailer — **found**
6. Loads embedded JavaScript, runs Claude Code

### Why Bun can't read environment variables

Bun on glibc/Termux doesn't read the `environ` pointer correctly — `process.env` and `Bun.env` return zero entries even though the kernel provides the full environment. The environment IS accessible via `/proc/self/environ` (43+ vars), so the `fix-env.js` preload reads it and populates `process.env`.

This is a Bun bug specific to the glibc-on-Termux configuration. `AT_SECURE` is 0, so glibc isn't sanitizing — Bun simply doesn't pick up the vars.

### Why /tmp needs proot

Claude Code hardcodes `/tmp/claude-{PID}` for its Bash sandbox directories. On Android, `/tmp` either doesn't exist or isn't writable. `proot` intercepts filesystem calls via `ptrace` and transparently redirects `/tmp` to `$PREFIX/tmp` (which is writable).

The `--bind=$PREFIX/bin/bash:/bin/sh` is also needed because Claude Code's hooks spawn processes via `/bin/sh`, which doesn't exist on Termux.

### Avoiding nested proot

This is the most important naming decision in the setup. Claude Code's internal processes (hooks, inference calls, sub-agents) call `claude` by name. If `claude` is a proot wrapper, those internal calls create **nested proot** — ptrace inside ptrace — which deadlocks on Android.

The solution:
- `claude` = the real bun-termux-loader binary (no proot)
- `claude-termux` = the proot wrapper (only used as the entry point)
- `cl` = self-healing launcher that calls `claude-termux`

This way, the outer `claude-termux` call sets up proot once. Everything inside — hooks, sub-processes, inference calls — calls `claude` directly and gets the real binary, already running inside the proot environment.

## File Layout

```
~/.local/bin/
├── claude            # The real binary (bun-termux-loader wrapped)
├── claude-termux     # proot wrapper (entry point)
├── cl                # Self-healing launcher → claude-termux
├── bun               # Standalone Bun wrapper (for PAI hooks)
└── rebuild-claude-wrapper  # Manual rebuild after auto-updates
```

## Known Issues

- **First run is slow** — cache extraction takes a few seconds on initial launch
- **`Cannot read directory "/data/data/"` stderr** — harmless Bun warning, filtered by the bun wrapper
- **Auto-updates break the binary** — use `cl` which handles this automatically, or run `rebuild-claude-wrapper`
- **Sharp not available** — image paste may not work (SELinux blocks sharp's native binaries)

## PAI (Personal AI Infrastructure)

If you run [PAI](https://github.com/pybe) on top of Claude Code, there are additional Termux-specific considerations.

### Bun wrapper (required)

PAI hooks are TypeScript files executed by Bun. On Termux, Bun needs the glibc-runner (`grun`) and the environment fix preload to work. Install the Bun wrapper as described in [Bun Environment Fix](#bun-environment-fix-for-pai--hooks-that-use-bun).

### Hook execution under proot

PAI hooks run inside the proot environment (inherited from `claude-termux`). This means:

- `/tmp` is already redirected — hooks can write to `/tmp` normally
- `/bin/sh` is already available — child process spawning works
- `claude` resolves to the real binary — hooks that call `claude` (e.g. for inference) work without nesting proot

### Hooks that spawn sub-processes

Some PAI hooks spawn `claude --print` as a subprocess for inference (e.g. `SessionAutoName` for AI-powered session naming, `RatingCapture` for sentiment analysis). These work correctly because `claude` is the real binary, not the proot wrapper. If you see hooks hanging or leaving zombie processes, check that `claude` is not a script — it must be the actual bun-termux-loader binary.

### Tested PAI version

These instructions were tested with PAI 4.0.3.

## Upstream Issues

- [anthropics/claude-code#15637](https://github.com/anthropics/claude-code/issues/15637) — hardcoded `/tmp` paths
- [oven-sh/bun#8685](https://github.com/oven-sh/bun/issues/8685) — Bun on Termux

## Files

| File | Purpose |
|------|---------|
| [`install.sh`](install.sh) | Patched installer that uses grun for the initial `claude install` step |
| [`fix-env.js`](fix-env.js) | Preload script that fixes Bun's empty `process.env` on Termux |
| [`wrappers/cl`](wrappers/cl) | Self-healing launcher — auto-detects and fixes broken binaries |
| [`wrappers/claude-termux`](wrappers/claude-termux) | proot wrapper for the entry point |
| [`wrappers/bun`](wrappers/bun) | grun + env fix wrapper for standalone Bun |
| [`wrappers/rebuild-claude-wrapper`](wrappers/rebuild-claude-wrapper) | Manual rebuild script for after auto-updates |

## Credits

- [bun-termux-loader](https://github.com/kaan-escober/bun-termux-loader) by [@kaan-escober](https://github.com/kaan-escober) — the core userland exec technique
- Anthropic for Claude Code

## License

MIT

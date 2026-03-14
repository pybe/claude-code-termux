# Claude Code on Termux

Getting [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic's CLI) running natively on Android via [Termux](https://termux.dev/).

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
python3 build.py ~/.claude/downloads/claude ~/.local/bin/claude-bin
echo "Built Claude Code $VERSION"
```

This creates a ~229MB self-contained binary that embeds the C wrapper, Bun runtime, Claude Code JS payload, native `.node` libraries, and the BunFS shim.

### 3. Install the proot wrapper

The proot wrapper redirects `/tmp` and `/bin/sh` so Claude Code's Bash tool works:

```bash
cat > ~/.local/bin/claude << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Claude Code wrapper - proot redirects /tmp and /bin/sh for Termux
exec proot --bind=$PREFIX/tmp:/tmp --bind=$PREFIX/bin/bash:/bin/sh ~/.local/bin/claude-bin "$@"
EOF
chmod +x ~/.local/bin/claude
```

### 4. Install the Bun environment fix

Bun on glibc/Termux has a bug where `process.env` returns zero entries. This preload script reads `/proc/self/environ` to populate the environment:

```bash
mkdir -p ~/.local/share/bun-termux
cat > ~/.local/share/bun-termux/fix-env.js << 'EOF'
const fs = require("fs");
try {
    const raw = fs.readFileSync("/proc/self/environ", "utf8");
    const vars = raw.split("\0").filter(Boolean);
    for (const v of vars) {
        const eq = v.indexOf("=");
        if (eq > 0) {
            const key = v.substring(0, eq);
            const val = v.substring(eq + 1);
            if (!(key in process.env)) {
                process.env[key] = val;
            }
        }
    }
} catch (e) {}
EOF
```

Then install the `bun` wrapper that uses it:

```bash
cat > ~/.local/bin/bun << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Bun wrapper - uses grun + env fix preload
# Filters harmless Android /data/data/ AccessDenied stderr noise
CACHE_DIR="${TMPDIR:-/data/data/com.termux/files/usr/tmp}/bun-termux-cache"
BUN_BIN=$(ls "$CACHE_DIR"/bun-* 2>/dev/null | head -1)
if [ -z "$BUN_BIN" ]; then
    echo "Error: No cached bun in $CACHE_DIR" >&2
    exit 1
fi
FIX_ENV="$HOME/.local/share/bun-termux/fix-env.js"
if [ -f "$FIX_ENV" ]; then
    ARGS=(--preload "$FIX_ENV" "$@")
else
    ARGS=("$@")
fi
grun "$BUN_BIN" "${ARGS[@]}" 2> >(grep -v "Cannot read directory.*AccessDenied" >&2)
EOF
chmod +x ~/.local/bin/bun
```

### 5. Verify

```bash
claude --version
# Should output: X.X.X (Claude Code)

claude -p "say hello"
# Should respond with a greeting

# Verify Bash tool works:
claude -p "run echo hello"
# Should execute the command and show output
```

## Updating

Claude Code auto-updates can replace the bun-termux-loader wrapper with a raw native binary. Install this rebuild script:

```bash
cat > ~/.local/bin/rebuild-claude-wrapper << 'EOF'
#!/bin/bash
set -e
VERSIONS_DIR="$HOME/.local/share/claude/versions"
LOADER_DIR="$HOME/bun-termux-loader"
TARGET="$HOME/.local/bin/claude-bin"
LATEST=$(ls -t "$VERSIONS_DIR"/ 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then echo "No versions found"; exit 1; fi
echo "Rebuilding wrapper for Claude $LATEST..."
cd "$LOADER_DIR"
python3 build.py "$VERSIONS_DIR/$LATEST" "$TARGET"
echo "Done. $(claude --version 2>&1)"
EOF
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

## Known Issues

- **First run is slow** — cache extraction takes a few seconds on initial launch
- **`Cannot read directory "/data/data/"` stderr** — harmless Bun warning, filtered by the wrapper
- **Auto-updates break the wrapper** — run `rebuild-claude-wrapper` to fix
- **Agent spawning may fail** — some internal Claude Code paths still hardcode `/tmp`
- **Sharp not available** — image paste may not work (SELinux blocks sharp's native binaries)

## Upstream Issues

- [anthropics/claude-code#15637](https://github.com/anthropics/claude-code/issues/15637) — hardcoded `/tmp` paths
- [oven-sh/bun#8685](https://github.com/oven-sh/bun/issues/8685) — Bun on Termux

## Files

| File | Purpose |
|------|---------|
| [`install.sh`](install.sh) | Patched installer that uses grun for the initial `claude install` step |
| [`fix-env.js`](fix-env.js) | Preload script that fixes Bun's empty `process.env` on Termux |
| [`wrappers/claude`](wrappers/claude) | proot wrapper for the Claude binary |
| [`wrappers/bun`](wrappers/bun) | grun + env fix wrapper for standalone Bun |
| [`wrappers/rebuild-claude-wrapper`](wrappers/rebuild-claude-wrapper) | Rebuild script for after auto-updates |

## Credits

- [bun-termux-loader](https://github.com/kaan-escober/bun-termux-loader) by [@kaan-escober](https://github.com/kaan-escober) — the core userland exec technique
- Anthropic for Claude Code

## License

MIT

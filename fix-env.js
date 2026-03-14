/**
 * Bun environment fix for Termux
 *
 * Bun on glibc/Termux has a bug where process.env and Bun.env return zero
 * entries even though the kernel provides the full environment. This preload
 * script reads /proc/self/environ and populates process.env.
 *
 * Usage: bun --preload /path/to/fix-env.js your-script.ts
 */
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
} catch (e) {
    // Silently fail if /proc/self/environ is not readable
}

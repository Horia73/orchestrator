import { spawn } from "child_process"
import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { activeRuntimePaths } from "@/lib/runtime-paths"
import { resolveExistingUploadPath } from "@/lib/uploads"

/**
 * Server-side PowerPoint → PDF conversion for the in-app preview.
 *
 * No pure-JS renderer reaches "looks like the slides" fidelity, so PPTX is the
 * one format we convert inside our own container (LibreOffice Impress) and feed
 * to the existing pdf.js viewer. Converted PDFs are cached by upload id (uploads
 * are immutable UUID files) under the bounded preview cache — deliberately NOT
 * /tmp, which fills the host eMMC.
 *
 * Conversion runs `soffice --headless` directly (~2 s) with a private, writable
 * UserInstallation profile per call — the container user has no /etc/passwd entry
 * so LibreOffice can't create its default profile. Results are cached per deck,
 * so the cold start is paid once. If a warm `unoconvert`/`unoserver` daemon is
 * ever present it's preferred, but it is not required.
 */

const CACHE_CAP_BYTES = 512 * 1024 * 1024
const CONVERT_TIMEOUT_MS = 90_000

const inflight = new Map<string, Promise<string>>()
const inflightWorkspace = new Map<string, Promise<string>>()
let availabilityCache: Promise<boolean> | null = null

export const PPTX_EXTENSIONS = new Set([".pptx", ".ppt"])

export function isPptxId(id: string): boolean {
    return PPTX_EXTENSIONS.has(path.extname(id).toLowerCase())
}

function commandExists(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
        const p = spawn("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" })
        p.on("error", () => resolve(false))
        p.on("close", (code) => resolve(code === 0))
    })
}

/** Whether the host can convert PowerPoint at all (cached). Lets the route
 *  return a clean 503 in dev/local where LibreOffice isn't installed. */
export function pptxPreviewAvailable(): Promise<boolean> {
    if (!availabilityCache) {
        availabilityCache = (async () => {
            if (await commandExists("unoconvert")) return true
            if (await commandExists("soffice")) return true
            if (await commandExists("libreoffice")) return true
            return false
        })()
    }
    return availabilityCache
}

function run(bin: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: "ignore" })
        const timer = setTimeout(() => {
            child.kill("SIGKILL")
            reject(new Error(`${bin} timed out`))
        }, CONVERT_TIMEOUT_MS)
        child.on("error", (err) => {
            clearTimeout(timer)
            reject(err)
        })
        child.on("close", (code) => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(`${bin} exited ${code}`))
        })
    })
}

/** A real (non-truncated) PDF starts with the "%PDF-" magic. Used to reject a
 *  partial file left behind by a killed/OOM'd converter so it never becomes a
 *  sticky poisoned cache entry. */
async function isValidPdf(p: string): Promise<boolean> {
    let fh: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
        const st = await fs.stat(p)
        if (st.size < 100) return false
        fh = await fs.open(p, "r")
        const buf = Buffer.alloc(5)
        await fh.read(buf, 0, 5, 0)
        return buf.toString("latin1") === "%PDF-"
    } catch {
        return false
    } finally {
        await fh?.close().catch(() => {})
    }
}

/**
 * Best-effort LRU eviction. NOTE: the cap is PER-PROFILE (previewCacheDir lives
 * under each profile's state dir), so the aggregate eMMC budget is N×cap.
 *
 * Never evicts `keepPath` (the file the current request just produced/served) or
 * files written within the last few seconds (likely in-flight for another
 * request), so a single oversized deck can't wipe the whole cache.
 */
async function enforceCacheCap(dir: string, keepPath?: string): Promise<void> {
    try {
        const keep = keepPath ? path.resolve(keepPath) : null
        const cutoff = Date.now() - 5000
        const names = await fs.readdir(dir)
        const entries = await Promise.all(
            names.map(async (name) => {
                const full = path.join(dir, name)
                try {
                    const st = await fs.stat(full)
                    return st.isFile() ? { full, size: st.size, mtime: st.mtimeMs } : null
                } catch {
                    return null
                }
            })
        )
        const files = entries.filter((e): e is { full: string; size: number; mtime: number } => e !== null)
        let total = files.reduce((sum, f) => sum + f.size, 0)
        if (total <= CACHE_CAP_BYTES) return
        const evictable = files
            .filter((f) => path.resolve(f.full) !== keep && f.mtime < cutoff)
            .sort((a, b) => a.mtime - b.mtime) // oldest first
        for (const f of evictable) {
            if (total <= CACHE_CAP_BYTES) break
            try {
                await fs.unlink(f.full)
                total -= f.size
            } catch {
                // ignore — another request may be streaming it
            }
        }
    } catch {
        // cache dir may not exist yet — nothing to evict
    }
}

async function doConvert(uploadId: string, input: string, cacheDir: string, out: string): Promise<string> {
    await fs.mkdir(cacheDir, { recursive: true })

    const hasUno = await commandExists("unoconvert")
    const sofficeBin = (await commandExists("soffice"))
        ? "soffice"
        : (await commandExists("libreoffice"))
          ? "libreoffice"
          : null
    if (!hasUno && !sofficeBin) throw new Error("no PowerPoint converter available")

    // Commit the converted PDF to its final cache path only via an atomic rename
    // after a complete, valid conversion — so a killed/OOM'd converter never
    // leaves a partial file that the cache-hit check would serve forever.
    const finish = async (producedPath: string): Promise<string> => {
        await fs.rename(producedPath, out)
        void enforceCacheCap(cacheDir, out)
        return out
    }

    let lastErr: unknown = null

    if (hasUno) {
        const tmp = `${out}.${randomUUID()}.part`
        try {
            await run("unoconvert", ["--convert-to", "pdf", input, tmp])
            if (await isValidPdf(tmp)) return await finish(tmp)
            lastErr = new Error("unoconvert produced no valid output")
        } catch (err) {
            lastErr = err
        } finally {
            await fs.rm(tmp, { force: true }).catch(() => {})
        }
    }

    if (sofficeBin) {
        // soffice forces its output name from the input basename, so convert into
        // a private temp dir and rename the result out. A unique writable
        // UserInstallation profile (inside that dir) is required — the container
        // user has no passwd entry, so the default ~/.config profile creation
        // fails ("User installation could not be completed"). Per-call profiles
        // also avoid the single-instance profile lock under concurrency.
        const tmpDir = await fs.mkdtemp(path.join(cacheDir, ".conv-"))
        const profileUri = `file://${path.join(tmpDir, "profile")}`
        try {
            await run(sofficeBin, [
                "--headless",
                `-env:UserInstallation=${profileUri}`,
                "--convert-to",
                "pdf",
                "--outdir",
                tmpDir,
                input,
            ])
            const produced = path.join(tmpDir, `${path.parse(input).name}.pdf`)
            if (await isValidPdf(produced)) return await finish(produced)
            lastErr = new Error(`${sofficeBin} produced no valid output`)
        } catch (err) {
            lastErr = err
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        }
    }

    throw lastErr ?? new Error("conversion failed")
}

/**
 * Convert a stored PPTX/PPT upload to PDF, returning the cached PDF path.
 * Concurrent requests for the same upload share one conversion.
 */
export async function convertPptxToPdf(uploadId: string): Promise<string> {
    const input = resolveExistingUploadPath(uploadId)
    if (!input) throw new Error("upload not found")

    const { previewCacheDir } = activeRuntimePaths()
    const out = path.join(previewCacheDir, `${path.parse(uploadId).name}.pdf`)

    // Cache hit: immutable uploads, so existence is enough — but require a valid
    // (non-truncated) PDF newer than the source, so a partial file left by a
    // killed converter self-heals (re-converts) instead of being served forever.
    try {
        const [outStat, inStat] = await Promise.all([fs.stat(out), fs.stat(input)])
        if (outStat.mtimeMs >= inStat.mtimeMs && (await isValidPdf(out))) {
            // LRU-on-access: keep actively-served decks from looking "oldest".
            const now = new Date()
            void fs.utimes(out, now, now).catch(() => {})
            return out
        }
    } catch {
        // no cache yet
    }

    const existing = inflight.get(uploadId)
    if (existing) return existing

    const job = doConvert(uploadId, input, previewCacheDir, out).finally(() => {
        inflight.delete(uploadId)
    })
    inflight.set(uploadId, job)
    return job
}

/**
 * Convert a PPTX/PPT that lives in the agent workspace (a resolved absolute
 * path, NOT an upload id) to PDF for the in-app preview, returning the cached
 * PDF path. Unlike immutable uploads, workspace files are mutable, so the cache
 * entry is keyed by a hash of the absolute path and only reused when it is newer
 * than the source — an edited deck self-heals (re-converts) on next open.
 */
export async function convertWorkspacePptxToPdf(absInputPath: string): Promise<string> {
    const input = path.resolve(absInputPath)

    const { previewCacheDir } = activeRuntimePaths()
    const key = createHash("sha1").update(input).digest("hex").slice(0, 24)
    const out = path.join(previewCacheDir, `ws-${key}.pdf`)

    try {
        const [outStat, inStat] = await Promise.all([fs.stat(out), fs.stat(input)])
        if (outStat.mtimeMs >= inStat.mtimeMs && (await isValidPdf(out))) {
            const now = new Date()
            void fs.utimes(out, now, now).catch(() => {})
            return out
        }
    } catch {
        // no cache yet, or source vanished — fall through to (re)convert
    }

    const existing = inflightWorkspace.get(key)
    if (existing) return existing

    const job = doConvert(key, input, previewCacheDir, out).finally(() => {
        inflightWorkspace.delete(key)
    })
    inflightWorkspace.set(key, job)
    return job
}

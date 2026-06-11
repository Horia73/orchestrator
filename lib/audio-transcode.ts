import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

const TRANSCODE_TIMEOUT_MS = 30_000

export async function transcodeAudioBufferToWav(
  input: Buffer,
  inputExtension = ".webm"
): Promise<Buffer> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-audio-"))
  const safeExtension = sanitizeExtension(inputExtension)
  const inputPath = path.join(tempDir, `input${safeExtension}`)
  const outputPath = path.join(tempDir, "output.wav")

  try {
    fs.writeFileSync(inputPath, input)
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        outputPath,
      ],
      { timeout: TRANSCODE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    )
    return fs.readFileSync(outputPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Audio conversion to WAV failed: ${message}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function sanitizeExtension(extension: string): string {
  const value = extension.startsWith(".") ? extension : `.${extension}`
  return /^\.[a-z0-9][a-z0-9-]{0,15}$/i.test(value) ? value.toLowerCase() : ".bin"
}

const PROBE_TIMEOUT_MS = 10_000

/**
 * True when the file has at least one audio stream and no video stream.
 *
 * Magic-byte sniffing types every ISO base-media container as video/mp4, but
 * "audio message" exports are routinely audio-only MP4s (brand mp42/isom with
 * a single AAC track) — those should be treated as audio, not rejected as
 * video. Fail-closed: any ffprobe error returns false and callers keep the
 * container type they already had.
 */
export async function probeIsAudioOnly(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0",
        filePath,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    )
    const codecTypes = stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    return codecTypes.includes("audio") && !codecTypes.includes("video")
  } catch {
    return false
  }
}

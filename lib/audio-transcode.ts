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

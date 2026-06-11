/**
 * Content-based file type detection ("magic byte" sniffing).
 *
 * Used as a fallback when an ingested file arrives without a usable MIME type
 * or extension — most importantly WhatsApp voice notes, which whatsapp-web.js
 * frequently hands back with an empty `mimetype` and no filename, so they would
 * otherwise be saved as an opaque `.bin` with no in-app player. Sniffing the
 * leading bytes recovers the real type (an Opus-in-Ogg voice note → audio/ogg)
 * so the upload pipeline can give it the right extension and renderer.
 *
 * Every extension returned here is guaranteed to exist in UPLOAD_MIME_MAP, so
 * the file both classifies into the right viewer bucket (image/audio/video/…)
 * and serves with a real Content-Type from /api/uploads/[id] (which derives the
 * header purely from the on-disk extension).
 */

export interface SniffedType {
    mime: string
    ext: string
}

const TEXT_SAMPLE_BYTES = 4096

export function sniffContentType(buf: Buffer): SniffedType | null {
    try {
        return detect(buf)
    } catch {
        return null
    }
}

function detect(b: Buffer): SniffedType | null {
    if (!b || b.length < 4) return null

    const has = (sig: number[], offset = 0): boolean => {
        if (b.length < offset + sig.length) return false
        for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false
        return true
    }
    const ascii = (start: number, end: number): string => b.toString('latin1', start, Math.min(end, b.length))

    // ---- Containers first (their inner magic is more specific) --------------

    // ISO base media (MP4 / MOV / M4A / HEIC / AVIF / 3GP): "ftyp" at offset 4.
    if (ascii(4, 8) === 'ftyp') {
        const brand = ascii(8, 12)
        if (brand.trim() === 'qt') return { mime: 'video/quicktime', ext: '.mov' }
        if (brand.startsWith('M4A') || brand.startsWith('M4B') || brand.startsWith('M4P')) return { mime: 'audio/mp4', ext: '.m4a' }
        if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('hevc') || brand.startsWith('hevx')) return { mime: 'image/heic', ext: '.heic' }
        if (brand.startsWith('mif1') || brand.startsWith('msf1') || brand.startsWith('heif')) return { mime: 'image/heif', ext: '.heif' }
        if (brand.startsWith('avif') || brand.startsWith('avis')) return { mime: 'image/avif', ext: '.avif' }
        if (brand.startsWith('3g')) return { mime: 'video/3gpp', ext: '.3gp' }
        return { mime: 'video/mp4', ext: '.mp4' }
    }

    // RIFF container: WAV (audio), AVI (video), WebP (image).
    if (has([0x52, 0x49, 0x46, 0x46])) {
        const form = ascii(8, 12)
        if (form === 'WAVE') return { mime: 'audio/wav', ext: '.wav' }
        if (form === 'AVI ') return { mime: 'video/x-msvideo', ext: '.avi' }
        if (form === 'WEBP') return { mime: 'image/webp', ext: '.webp' }
    }

    // Ogg: Opus/Vorbis audio (WhatsApp voice notes), or Theora video.
    if (has([0x4f, 0x67, 0x67, 0x53])) {
        if (ascii(0, 128).includes('theora')) return { mime: 'video/ogg', ext: '.ogv' }
        return { mime: 'audio/ogg', ext: '.ogg' }
    }

    // EBML — Matroska / WebM. DocType lives a few bytes in.
    if (has([0x1a, 0x45, 0xdf, 0xa3])) {
        if (ascii(0, 64).includes('webm')) return { mime: 'video/webm', ext: '.webm' }
        return { mime: 'video/x-matroska', ext: '.mkv' }
    }

    // ---- Images -------------------------------------------------------------
    if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: '.png' }
    if (has([0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: '.jpg' }
    if (has([0x47, 0x49, 0x46, 0x38])) return { mime: 'image/gif', ext: '.gif' }
    if (has([0x42, 0x4d])) return { mime: 'image/bmp', ext: '.bmp' }
    if (has([0x49, 0x49, 0x2a, 0x00]) || has([0x4d, 0x4d, 0x00, 0x2a])) return { mime: 'image/tiff', ext: '.tif' }
    if (has([0x00, 0x00, 0x01, 0x00])) return { mime: 'image/x-icon', ext: '.ico' }

    // ---- Audio --------------------------------------------------------------
    if (has([0x66, 0x4c, 0x61, 0x43])) return { mime: 'audio/flac', ext: '.flac' }       // "fLaC"
    if (has([0x23, 0x21, 0x41, 0x4d, 0x52])) return { mime: 'audio/amr', ext: '.amr' }    // "#!AMR"
    if (has([0x49, 0x44, 0x33])) return { mime: 'audio/mpeg', ext: '.mp3' }               // ID3 tag
    if (b[0] === 0xff) {
        // 12-bit frame sync. ADTS AAC has layer bits 00; MPEG audio (MP3) doesn't.
        if ((b[1] & 0xf6) === 0xf0) return { mime: 'audio/aac', ext: '.aac' }
        if ((b[1] & 0xe0) === 0xe0) return { mime: 'audio/mpeg', ext: '.mp3' }
    }

    // ---- Documents ----------------------------------------------------------
    if (has([0x25, 0x50, 0x44, 0x46])) return { mime: 'application/pdf', ext: '.pdf' }        // "%PDF"
    if (has([0x25, 0x21, 0x50, 0x53])) return { mime: 'application/postscript', ext: '.ps' }  // "%!PS"
    // OLE / Compound File Binary — legacy Office (.doc/.xls/.ppt). These almost
    // always arrive with a real filename, so this fallback rarely fires; default
    // to .doc so the file at least routes to a document viewer.
    if (has([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { mime: 'application/msword', ext: '.doc' }

    // ---- Zip family (plain zip, OOXML, OpenDocument, EPUB) -------------------
    if (has([0x50, 0x4b, 0x03, 0x04]) || has([0x50, 0x4b, 0x05, 0x06]) || has([0x50, 0x4b, 0x07, 0x08])) {
        return sniffZip(ascii)
    }

    // ---- Other archives -----------------------------------------------------
    if (has([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { mime: 'application/vnd.rar', ext: '.rar' }
    if (has([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mime: 'application/x-7z-compressed', ext: '.7z' }
    if (has([0x1f, 0x8b])) return { mime: 'application/gzip', ext: '.gz' }
    if (has([0x42, 0x5a, 0x68])) return { mime: 'application/x-bzip2', ext: '.bz2' }
    if (has([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { mime: 'application/x-xz', ext: '.xz' }
    if (has([0x28, 0xb5, 0x2f, 0xfd])) return { mime: 'application/zstd', ext: '.zst' }
    if (b.length > 262 && ascii(257, 262) === 'ustar') return { mime: 'application/x-tar', ext: '.tar' }

    // ---- Text-based (SVG, plain text) — last resort -------------------------
    return sniffText(b)
}

function sniffZip(ascii: (start: number, end: number) => string): SniffedType {
    // EPUB / OpenDocument store an uncompressed "mimetype" entry first; its
    // contents are the exact media type. The local file header is 30 bytes,
    // then the filename ("mimetype"), then the stored data.
    if (ascii(30, 38) === 'mimetype') {
        const declared = ascii(38, 118)
        if (declared.startsWith('application/epub+zip')) return { mime: 'application/epub+zip', ext: '.epub' }
        if (declared.startsWith('application/vnd.oasis.opendocument.text')) return { mime: 'application/vnd.oasis.opendocument.text', ext: '.odt' }
        if (declared.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return { mime: 'application/vnd.oasis.opendocument.spreadsheet', ext: '.ods' }
        if (declared.startsWith('application/vnd.oasis.opendocument.presentation')) return { mime: 'application/vnd.oasis.opendocument.presentation', ext: '.odp' }
    }
    // OOXML: the part directory names appear among the local file headers.
    const head = ascii(0, 4096)
    if (head.includes('word/')) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' }
    if (head.includes('xl/')) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' }
    if (head.includes('ppt/')) return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' }
    return { mime: 'application/zip', ext: '.zip' }
}

function sniffText(b: Buffer): SniffedType | null {
    const sample = b.subarray(0, TEXT_SAMPLE_BYTES)
    if (sample.length === 0) return null
    // Must decode as UTF-8 and be overwhelmingly printable — otherwise treat it
    // as opaque binary and let it stay .bin rather than mislabel it as text.
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample)
    } catch {
        return null
    }
    let printable = 0
    for (let i = 0; i < sample.length; i++) {
        const c = sample[i]
        if (c === 0) return null
        if (c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) printable++
    }
    if (printable / sample.length < 0.95) return null

    const start = b.toString('utf-8', 0, Math.min(512, b.length)).trimStart().toLowerCase()
    if (start.startsWith('<?xml') && start.includes('<svg')) return { mime: 'image/svg+xml', ext: '.svg' }
    if (start.startsWith('<svg')) return { mime: 'image/svg+xml', ext: '.svg' }
    return { mime: 'text/plain', ext: '.txt' }
}

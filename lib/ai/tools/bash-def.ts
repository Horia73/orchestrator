import type { ToolDef } from '@/lib/ai/agents/types'

export const bashTool: ToolDef = {
    id: 'Bash',
    name: 'Bash',
    description: [
        'Runs a shell command. Commands start in the agent workspace by default and may use any host command/path permitted by the runtime user. Foreground commands are timed out and output-limited; background commands return a log path.',
        'Runtime environment: a Debian-based container with node, git, curl, jq, sqlite3, ripgrep (rg), grep, poppler-utils (pdftotext/pdftoppm/pdfimages), qpdf, tesseract, pandoc, LibreOffice, ffmpeg, imagemagick, and python3 (with pip; pandas, openpyxl, python-docx, python-pptx, pypdf, pdfplumber, pillow, pdf2image, pytesseract, markitdown preinstalled) available. Use ffmpeg to transcode/repackage audio or video and python3 for ad-hoc file or data conversion — e.g. an odd or unplayable attachment (a WhatsApp voice note saved as .bin is Opus-in-Ogg) can be converted with `ffmpeg -i in.bin out.mp3`. For searching file contents prefer the dedicated Grep tool over shelling out to rg/grep.',
        'The agent workspace is a data directory, NOT a git repository — do not run git there; the app source lives elsewhere and is only relevant during a self-development run.',
        'If a command fails with "command not found", that binary is not installed: do not retry the same command — switch to an available equivalent (e.g. grep for rg, node for sqlite3), and if the missing tool is genuinely needed call ReportAgentNeed once so it gets added to the image.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command to run.',
            },
            description: {
                type: 'string',
                description: 'Short human-readable purpose for the command.',
            },
            timeout: {
                type: 'integer',
                description: 'Timeout in milliseconds. Defaults to 120000 and is capped at 600000.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'When true, start the command and return immediately with a log path.',
            },
            cwd: {
                type: 'string',
                description: 'Optional working directory. Relative paths resolve from the workspace root; absolute host paths are accepted. Defaults to the workspace root.',
            },
        },
        required: ['command'],
    },
    tags: ['execute', 'shell'],
}

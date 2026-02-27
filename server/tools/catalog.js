const SHARED_FUNCTION_DECLARATIONS = [
    {
        name: 'list_dir',
        description: 'List the contents of a directory, i.e. all files and subdirectories that are children of the directory.',
        parameters: {
            type: 'OBJECT',
            properties: {
                DirectoryPath: {
                    type: 'STRING',
                    description: 'Path to list contents of, should be absolute path to a directory',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['DirectoryPath'],
        },
    },
    {
        name: 'view_file',
        description: 'View the contents of a file from the local filesystem.',
        parameters: {
            type: 'OBJECT',
            properties: {
                AbsolutePath: {
                    type: 'STRING',
                    description: 'Path to file to view. Must be an absolute path.',
                },
                StartLine: {
                    type: 'INTEGER',
                    description: 'Optional start line to view (1-indexed, inclusive).',
                },
                EndLine: {
                    type: 'INTEGER',
                    description: 'Optional end line to view (1-indexed, inclusive).',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['AbsolutePath'],
        },
    },
    {
        name: 'view_file_outline',
        description: 'View a lightweight outline of classes/functions in a file.',
        parameters: {
            type: 'OBJECT',
            properties: {
                AbsolutePath: {
                    type: 'STRING',
                    description: 'Path to file to inspect. Must be an absolute path.',
                },
                ItemOffset: {
                    type: 'INTEGER',
                    description: 'Optional pagination offset for outline items.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['AbsolutePath'],
        },
    },
    {
        name: 'view_code_item',
        description: 'View code items (functions/classes) from a file by node path.',
        parameters: {
            type: 'OBJECT',
            properties: {
                File: {
                    type: 'STRING',
                    description: 'Absolute path to file.',
                },
                NodePaths: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'List of node paths to inspect (max 5).',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['File', 'NodePaths'],
        },
    },
    {
        name: 'find_by_name',
        description: 'Search for files and subdirectories within a specified directory using a glob pattern.',
        parameters: {
            type: 'OBJECT',
            properties: {
                SearchDirectory: {
                    type: 'STRING',
                    description: 'The absolute directory path to search within.',
                },
                Pattern: {
                    type: 'STRING',
                    description: 'Glob pattern to match against file or directory names.',
                },
                Type: {
                    type: 'STRING',
                    description: 'Optional type filter: file, directory, or any.',
                },
                Extensions: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional list of file extensions to include (without leading dot).',
                },
                Excludes: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional list of glob patterns to exclude.',
                },
                FullPath: {
                    type: 'BOOLEAN',
                    description: 'If true, match Pattern against full absolute path instead of only filename.',
                },
                MaxDepth: {
                    type: 'INTEGER',
                    description: 'Optional maximum recursion depth.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['SearchDirectory', 'Pattern'],
        },
    },
    {
        name: 'grep_search',
        description: 'Search text inside files using ripgrep.',
        parameters: {
            type: 'OBJECT',
            properties: {
                Query: {
                    type: 'STRING',
                    description: 'The search text or regex pattern.',
                },
                SearchPath: {
                    type: 'STRING',
                    description: 'Absolute path to a file or directory to search.',
                },
                Includes: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional glob filters for file paths.',
                },
                IsRegex: {
                    type: 'BOOLEAN',
                    description: 'If true, treat Query as regex. If false, literal search.',
                },
                MatchPerLine: {
                    type: 'BOOLEAN',
                    description: 'If true, return line-level matches. If false, return only file names.',
                },
                CaseInsensitive: {
                    type: 'BOOLEAN',
                    description: 'If true, search is case-insensitive.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['Query', 'SearchPath'],
        },
    },
    {
        name: 'read_url_content',
        description: 'Fetch the content of a URL via HTTP request.',
        parameters: {
            type: 'OBJECT',
            properties: {
                Url: {
                    type: 'STRING',
                    description: 'HTTP or HTTPS URL to fetch.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['Url'],
        },
    },
    {
        name: 'view_content_chunk',
        description: 'View a specific chunk from a previously fetched URL document.',
        parameters: {
            type: 'OBJECT',
            properties: {
                document_id: {
                    type: 'STRING',
                    description: 'Document ID returned by read_url_content.',
                },
                position: {
                    type: 'INTEGER',
                    description: '0-indexed chunk position to view.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['document_id', 'position'],
        },
    },
    {
        name: 'search_web',
        description: 'Perform a grounded web search and return concise findings with citations.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'Search query to run on the web.',
                },
                domain: {
                    type: 'STRING',
                    description: 'Optional domain hint to prioritize (e.g. docs.example.com).',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'generate_image',
        description: 'Generate or edit images by delegating to the Image agent.',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'Image generation/edit instruction.',
                },
                model: {
                    type: 'STRING',
                    description: 'Optional image-capable model override.',
                },
                aspectRatio: {
                    type: 'STRING',
                    description: 'Optional aspect ratio. Allowed values: 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9.',
                },
                imageSize: {
                    type: 'STRING',
                    description: 'Optional output size. Allowed values: 512px, 1K, 2K, 4K.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'run_command',
        description: 'Run a shell command in the workspace and return a live command session snapshot.',
        parameters: {
            type: 'OBJECT',
            properties: {
                CommandLine: {
                    type: 'STRING',
                    description: 'Command to execute in a shell.',
                },
                Cwd: {
                    type: 'STRING',
                    description: 'Optional working directory (absolute or relative to workspace).',
                },
                WaitMsBeforeAsync: {
                    type: 'INTEGER',
                    description: 'Optional milliseconds to wait before returning while command may continue in background.',
                },
                SafeToAutoRun: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['CommandLine'],
        },
    },
    {
        name: 'command_status',
        description: 'Poll the status/output of a previously started command session.',
        parameters: {
            type: 'OBJECT',
            properties: {
                CommandId: {
                    type: 'STRING',
                    description: 'Command session id returned by run_command.',
                },
                WaitDurationSeconds: {
                    type: 'NUMBER',
                    description: 'Optional long-poll duration in seconds.',
                },
                OutputCharacterCount: {
                    type: 'INTEGER',
                    description: 'Optional number of output characters to return from the tail.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['CommandId'],
        },
    },
    {
        name: 'send_command_input',
        description: 'Send stdin input to a running command session or request termination.',
        parameters: {
            type: 'OBJECT',
            properties: {
                CommandId: {
                    type: 'STRING',
                    description: 'Command session id returned by run_command.',
                },
                Input: {
                    type: 'STRING',
                    description: 'Optional input text to write to stdin.',
                },
                Terminate: {
                    type: 'BOOLEAN',
                    description: 'If true, send SIGINT to the command process.',
                },
                WaitMs: {
                    type: 'INTEGER',
                    description: 'Optional wait in milliseconds before returning updated status.',
                },
                SafeToAutoRun: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['CommandId'],
        },
    },
    {
        name: 'read_terminal',
        description: 'Read terminal state by command name or process id.',
        parameters: {
            type: 'OBJECT',
            properties: {
                Name: {
                    type: 'STRING',
                    description: 'Optional command name hint (e.g. npm, node, pytest).',
                },
                ProcessID: {
                    type: 'INTEGER',
                    description: 'Optional process id to lookup.',
                },
                OutputCharacterCount: {
                    type: 'INTEGER',
                    description: 'Optional number of output characters to return from the tail.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
        },
    },
    {
        name: 'write_to_file',
        description: 'Create or overwrite a file on disk.',
        parameters: {
            type: 'OBJECT',
            properties: {
                TargetFile: {
                    type: 'STRING',
                    description: 'Absolute path to target file.',
                },
                CodeContent: {
                    type: 'STRING',
                    description: 'Content to write to file.',
                },
                Overwrite: {
                    type: 'BOOLEAN',
                    description: 'Whether to overwrite existing file content.',
                },
                EmptyFile: {
                    type: 'BOOLEAN',
                    description: 'If true, create an empty file.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['TargetFile', 'Overwrite'],
        },
    },
    {
        name: 'replace_file_content',
        description: 'Replace a target snippet within a specific line range of a file.',
        parameters: {
            type: 'OBJECT',
            properties: {
                TargetFile: {
                    type: 'STRING',
                    description: 'Absolute path to target file.',
                },
                StartLine: {
                    type: 'INTEGER',
                    description: '1-indexed start line of search range (inclusive).',
                },
                EndLine: {
                    type: 'INTEGER',
                    description: '1-indexed end line of search range (inclusive).',
                },
                TargetContent: {
                    type: 'STRING',
                    description: 'Exact text to find inside the provided line range.',
                },
                ReplacementContent: {
                    type: 'STRING',
                    description: 'Replacement text.',
                },
                AllowMultiple: {
                    type: 'BOOLEAN',
                    description: 'If true, replaces all occurrences in range.',
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['TargetFile', 'StartLine', 'EndLine', 'TargetContent', 'ReplacementContent', 'AllowMultiple'],
        },
    },
    {
        name: 'multi_replace_file_content',
        description: 'Apply multiple replacement chunks in one pass on the same file.',
        parameters: {
            type: 'OBJECT',
            properties: {
                TargetFile: {
                    type: 'STRING',
                    description: 'Absolute path to target file.',
                },
                ReplacementChunks: {
                    type: 'ARRAY',
                    description: 'Array of replacement chunks.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            StartLine: { type: 'INTEGER' },
                            EndLine: { type: 'INTEGER' },
                            TargetContent: { type: 'STRING' },
                            ReplacementContent: { type: 'STRING' },
                            AllowMultiple: { type: 'BOOLEAN' },
                        },
                        required: ['StartLine', 'EndLine', 'TargetContent', 'ReplacementContent', 'AllowMultiple'],
                    },
                },
                waitForPreviousTools: {
                    type: 'BOOLEAN',
                    description: 'Optional scheduling hint. Ignored by local tool implementation.',
                },
            },
            required: ['TargetFile', 'ReplacementChunks'],
        },
    },
    {
        name: 'call_coding_agent',
        description: 'Delegates a complex coding task to a specialized Coding Agent. Use this for heavy logic, deep refactoring, or complex debugging. You can provide specific file paths if the task requires analyzing or modifying existing code, and images (base64) for visual/UI issues.',
        parameters: {
            type: 'OBJECT',
            properties: {
                task: {
                    type: 'STRING',
                    description: 'The specific coding task or problem to solve.',
                },
                context: {
                    type: 'STRING',
                    description: 'Optional textual context or instructions.',
                },
                file_paths: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional absolute paths to files the agent should read and analyze.',
                },
                attachments: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            mimeType: { type: 'STRING', description: 'e.g., image/png, application/pdf, audio/mp3, video/mp4, etc.' },
                            data: { type: 'STRING', description: 'Base64 encoded file data.' },
                        },
                        required: ['mimeType', 'data'],
                    },
                    description: 'Optional file attachments (images, PDFs, audio recordings, or any other media supported by Gemini) to help the agent understand the task.',
                },
            },
            required: ['task'],
        },
    },
];

const FUNCTION_DECLARATION_BY_NAME = new Map(
    SHARED_FUNCTION_DECLARATIONS.map((declaration) => [declaration.name, declaration]),
);

export const ALL_SHARED_TOOL_NAMES = SHARED_FUNCTION_DECLARATIONS.map((declaration) => declaration.name);

export function buildFunctionTools(toolNames = []) {
    const requestedNames = Array.isArray(toolNames) ? toolNames : [];
    const selectedDeclarations = [];
    const used = new Set();

    for (const rawName of requestedNames) {
        const name = String(rawName ?? '').trim();
        if (!name || used.has(name)) {
            continue;
        }

        const declaration = FUNCTION_DECLARATION_BY_NAME.get(name);
        if (!declaration) {
            continue;
        }

        selectedDeclarations.push(declaration);
        used.add(name);
    }

    if (selectedDeclarations.length === 0) {
        return undefined;
    }

    return [
        {
            functionDeclarations: selectedDeclarations,
        },
    ];
}

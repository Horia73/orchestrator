import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const declaration = {
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
};

export async function execute({ DirectoryPath }) {
    try {
        const files = await readdir(DirectoryPath);
        const result = [];

        for (const file of files) {
            const fullPath = join(DirectoryPath, file);
            const s = await stat(fullPath);

            if (s.isDirectory()) {
                result.push({
                    name: file,
                    type: 'directory',
                    path: relative(process.cwd(), fullPath),
                });
            } else {
                result.push({
                    name: file,
                    type: 'file',
                    size: s.size,
                    path: relative(process.cwd(), fullPath),
                });
            }
        }

        return {
            directory: DirectoryPath,
            contents: result,
        };
    } catch (error) {
        return {
            error: `Failed to list directory ${DirectoryPath}: ${error.message}`,
        };
    }
}

#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const templatesDir = path.join(projectRoot, 'orchestrator', 'templates');
const knowledgeDir = path.join(projectRoot, 'orchestrator', 'knowledge');

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function main() {
  const templateEntries = await fs.readdir(templatesDir, { withFileTypes: true });
  const templateFiles = templateEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  if (templateFiles.length === 0) {
    throw new Error(`No template markdown files found in ${templatesDir}`);
  }

  await fs.mkdir(knowledgeDir, { recursive: true });

  const outOfSync = [];

  for (const fileName of templateFiles) {
    const sourcePath = path.join(templatesDir, fileName);
    const targetPath = path.join(knowledgeDir, fileName);

    const [sourceContent, targetContent] = await Promise.all([
      fs.readFile(sourcePath, 'utf8'),
      readFileIfExists(targetPath),
    ]);

    if (sourceContent !== targetContent) {
      outOfSync.push(fileName);

      if (!checkOnly) {
        await fs.writeFile(targetPath, sourceContent, 'utf8');
      }
    }
  }

  if (checkOnly) {
    if (outOfSync.length > 0) {
      console.error('Knowledge files are out of sync with templates:');
      for (const fileName of outOfSync) {
        console.error(`- ${fileName}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log('Knowledge files are in sync with templates.');
    return;
  }

  if (outOfSync.length === 0) {
    console.log('Nothing to update. Knowledge files are already in sync.');
    return;
  }

  console.log(`Synced ${outOfSync.length} file(s) from templates to knowledge:`);
  for (const fileName of outOfSync) {
    console.log(`- ${fileName}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

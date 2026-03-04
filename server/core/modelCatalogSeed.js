import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS_CONFIG_PATH } from './dataPaths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MODEL_CATALOG_PATH = path.join(PROJECT_ROOT, 'server', 'assets', 'default-model-catalog.json');

export function getDefaultModelCatalogPath() {
    return DEFAULT_MODEL_CATALOG_PATH;
}

export function ensureModelCatalogExists() {
    if (fs.existsSync(MODELS_CONFIG_PATH)) {
        return {
            created: false,
            path: MODELS_CONFIG_PATH,
            sourcePath: DEFAULT_MODEL_CATALOG_PATH,
            exists: true,
        };
    }

    if (!fs.existsSync(DEFAULT_MODEL_CATALOG_PATH)) {
        return {
            created: false,
            path: MODELS_CONFIG_PATH,
            sourcePath: DEFAULT_MODEL_CATALOG_PATH,
            exists: false,
        };
    }

    fs.mkdirSync(path.dirname(MODELS_CONFIG_PATH), { recursive: true });
    fs.copyFileSync(DEFAULT_MODEL_CATALOG_PATH, MODELS_CONFIG_PATH);

    return {
        created: true,
        path: MODELS_CONFIG_PATH,
        sourcePath: DEFAULT_MODEL_CATALOG_PATH,
        exists: true,
    };
}

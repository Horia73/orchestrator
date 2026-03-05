import fs from 'node:fs';

export function watchModelsConfig({
    watchDir,
    modelsConfigPath,
    onModelsUpdated,
    fileName = 'models.json',
    logger = console,
} = {}) {
    let debounceTimer = null;

    try {
        fs.watch(watchDir, { persistent: false }, (_eventType, changedFileName) => {
            if (String(changedFileName ?? '').trim() !== fileName) {
                return;
            }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                onModelsUpdated?.({
                    path: modelsConfigPath,
                    exists: fs.existsSync(modelsConfigPath),
                });
            }, 100);
        });
    } catch (error) {
        logger.warn?.(`[models] Failed to watch ${modelsConfigPath}: ${error.message}`);
    }
}

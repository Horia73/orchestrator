/**
 * Skills loader for agent capabilities.
 *
 * Skills are markdown files (SKILL.md) that teach agents specific capabilities.
 * Two locations:
 *   - Builtin: server/skills/<name>/SKILL.md (shipped with repo)
 *   - Workspace: ~/.orchestrator/data/skills/<name>/SKILL.md (user-created, higher priority)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILLS_WORKSPACE_DIR } from '../core/dataPaths.js';
import { reloadConfigJson, updateConfigSection } from '../core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

function stripFrontmatter(content) {
    if (content.startsWith('---')) {
        const match = content.match(/^---\n[\s\S]*?\n---\n?/);
        if (match) {
            return content.slice(match[0].length).trim();
        }
    }
    return content;
}

export function parseFrontmatter(content) {
    if (!content.startsWith('---')) return {};

    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const metadata = {};
    for (const line of match[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        // Strip quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        // Parse booleans
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        metadata[key] = value;
    }
    return metadata;
}

export function parseRequires(metadata) {
    // requires can be inline YAML-like: `requires_bins: gh,docker`
    // or a JSON metadata field
    const requires = { bins: [], env: [] };

    if (metadata.requires_bins) {
        requires.bins = String(metadata.requires_bins).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (metadata.requires_env) {
        requires.env = String(metadata.requires_env).split(',').map((s) => s.trim()).filter(Boolean);
    }

    // Also check `metadata` JSON field (nanobot-style)
    if (typeof metadata.metadata === 'string') {
        try {
            const parsed = JSON.parse(metadata.metadata);
            const nano = parsed?.nanobot ?? parsed ?? {};
            if (nano.requires?.bins) {
                requires.bins = [...requires.bins, ...nano.requires.bins];
            }
            if (nano.requires?.env) {
                requires.env = [...requires.env, ...nano.requires.env];
            }
        } catch {
            // ignore
        }
    }

    return requires;
}

function checkBinaryExists(name) {
    try {
        execSync(`which ${name}`, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

export function checkRequirements(requires) {
    for (const bin of requires.bins) {
        if (!checkBinaryExists(bin)) return false;
    }
    for (const env of requires.env) {
        if (!process.env[env]) return false;
    }
    return true;
}

function getMissingRequirements(requires) {
    const missing = [];
    for (const bin of requires.bins) {
        if (!checkBinaryExists(bin)) missing.push(`CLI: ${bin}`);
    }
    for (const env of requires.env) {
        if (!process.env[env]) missing.push(`ENV: ${env}`);
    }
    return missing.join(', ');
}

class SkillsLoader {
    constructor() {
        this.builtinDir = BUILTIN_SKILLS_DIR;
        this.workspaceDir = SKILLS_WORKSPACE_DIR;
    }

    /**
     * Resolve the directory for a skill (workspace takes priority over builtin).
     */
    _resolveSkillDir(name) {
        const workspacePath = path.join(this.workspaceDir, name);
        if (fs.existsSync(path.join(workspacePath, 'SKILL.md'))) return workspacePath;

        const builtinPath = path.join(this.builtinDir, name);
        if (fs.existsSync(path.join(builtinPath, 'SKILL.md'))) return builtinPath;

        return null;
    }

    listSkills(filterUnavailable = true) {
        const skills = [];

        // Workspace skills (highest priority)
        if (fs.existsSync(this.workspaceDir)) {
            for (const entry of fs.readdirSync(this.workspaceDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const skillFile = path.join(this.workspaceDir, entry.name, 'SKILL.md');
                if (fs.existsSync(skillFile)) {
                    skills.push({ name: entry.name, path: skillFile, source: 'workspace' });
                }
            }
        }

        // Builtin skills
        if (fs.existsSync(this.builtinDir)) {
            for (const entry of fs.readdirSync(this.builtinDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const skillFile = path.join(this.builtinDir, entry.name, 'SKILL.md');
                if (fs.existsSync(skillFile) && !skills.some((s) => s.name === entry.name)) {
                    skills.push({ name: entry.name, path: skillFile, source: 'builtin' });
                }
            }
        }

        if (filterUnavailable) {
            return skills.filter((s) => {
                const content = this._readSkillFile(s.path);
                if (!content) return false;
                const meta = parseFrontmatter(content);
                const requires = parseRequires(meta);
                return checkRequirements(requires);
            });
        }

        return skills;
    }

    loadSkill(name) {
        // Workspace first
        const workspacePath = path.join(this.workspaceDir, name, 'SKILL.md');
        if (fs.existsSync(workspacePath)) {
            return this._readSkillFile(workspacePath);
        }

        const builtinPath = path.join(this.builtinDir, name, 'SKILL.md');
        if (fs.existsSync(builtinPath)) {
            return this._readSkillFile(builtinPath);
        }

        return null;
    }

    getSkillMetadata(name) {
        const content = this.loadSkill(name);
        if (!content) return null;
        return parseFrontmatter(content);
    }

    getAlwaysSkills() {
        return this.listSkills(true)
            .filter((s) => {
                const meta = this.getSkillMetadata(s.name);
                return meta?.always === true;
            })
            .map((s) => s.name);
    }

    loadSkillContent(name) {
        const content = this.loadSkill(name);
        if (!content) return null;
        return stripFrontmatter(content);
    }

    /**
     * List all resource files in a skill directory (everything except SKILL.md).
     */
    listSkillResources(name) {
        const skillDir = this._resolveSkillDir(name);
        if (!skillDir) return [];

        const results = [];
        const walk = (dir, prefix = '') => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), relPath);
                } else if (entry.name !== 'SKILL.md') {
                    try {
                        const stat = fs.statSync(path.join(dir, entry.name));
                        results.push({ path: relPath, size: stat.size });
                    } catch {
                        results.push({ path: relPath, size: 0 });
                    }
                }
            }
        };
        walk(skillDir);
        return results;
    }

    /**
     * Load a specific resource file from a skill directory.
     * Returns null if not found or path is invalid.
     */
    loadSkillResource(name, resourcePath) {
        const skillDir = this._resolveSkillDir(name);
        if (!skillDir) return null;

        const resolved = path.resolve(skillDir, resourcePath);
        // Security: prevent path traversal
        if (!resolved.startsWith(skillDir + path.sep) && resolved !== skillDir) return null;

        if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return null;

        try {
            return fs.readFileSync(resolved, 'utf8');
        } catch {
            return null;
        }
    }

    /**
     * Check if a skill is enabled (default: true).
     */
    isSkillEnabled(name) {
        const config = reloadConfigJson();
        return config?.skills?.[name]?.enabled !== false;
    }

    /**
     * Set a skill's enabled/disabled state.
     */
    setSkillEnabled(name, enabled) {
        const config = reloadConfigJson() ?? {};
        const skillsConfig = config.skills ?? {};
        if (!skillsConfig[name]) skillsConfig[name] = {};
        skillsConfig[name].enabled = enabled;
        updateConfigSection('skills', skillsConfig);
    }

    buildSkillsSummary() {
        const allSkills = this.listSkills(false);
        if (allSkills.length === 0) return '';

        const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const lines = ['<skills>'];
        for (const s of allSkills) {
            const meta = this.getSkillMetadata(s.name) ?? {};
            const requires = parseRequires(meta);
            const available = checkRequirements(requires);
            const enabled = this.isSkillEnabled(s.name);

            // Skip disabled skills from the prompt summary
            if (!enabled) continue;

            const desc = escapeXml(meta.description ?? s.name);

            lines.push(`  <skill available="${available}">`);
            lines.push(`    <name>${escapeXml(s.name)}</name>`);
            lines.push(`    <description>${desc}</description>`);
            lines.push(`    <location>${s.path}</location>`);
            if (!available) {
                const missing = getMissingRequirements(requires);
                if (missing) {
                    lines.push(`    <requires>${escapeXml(missing)}</requires>`);
                }
            }
            lines.push('  </skill>');
        }
        lines.push('</skills>');

        return lines.join('\n');
    }

    buildAlwaysSkillsContext() {
        const alwaysNames = this.getAlwaysSkills();
        if (alwaysNames.length === 0) return '';

        const parts = alwaysNames
            .filter((name) => this.isSkillEnabled(name))
            .map((name) => {
                const content = this.loadSkillContent(name);
                if (!content) return '';
                return `### Skill: ${name}\n\n${content}`;
            }).filter(Boolean);

        if (parts.length === 0) return '';
        return '\n\n<active_skills>\n' + parts.join('\n\n---\n\n') + '\n</active_skills>';
    }

    getSkillsContext() {
        const summary = this.buildSkillsSummary();
        const alwaysContent = this.buildAlwaysSkillsContext();

        if (!summary && !alwaysContent) return '';
        return (summary ? '\n\n' + summary : '') + alwaysContent;
    }

    saveWorkspaceSkill(name, content) {
        const dir = path.join(this.workspaceDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    }

    removeWorkspaceSkill(name) {
        const dir = path.join(this.workspaceDir, name);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            return true;
        }
        return false;
    }

    _readSkillFile(filePath) {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return null;
        }
    }
}

export const skillsLoader = new SkillsLoader();

import { useState, useEffect, useCallback } from 'react';
import { fetchSkills, fetchSkill, saveSkill, deleteSkill, setSkillEnabled } from '../../api/skillsApi.js';
import './SkillsPanel.css';

/* ─── Skill Card ──────────────────────────────────────────────────── */

function SkillCard({ skill, onSelect, onToggle }) {
    return (
        <div
            className={`skill-card ${!skill.enabled ? 'skill-card--disabled' : ''}`}
            onClick={() => onSelect(skill.name)}
        >
            <div className="skill-card-header">
                <span className="skill-card-name">{skill.name}</span>
                <div className="skill-card-badges">
                    {skill.always && <span className="skill-badge skill-badge--always">always</span>}
                    <span className={`skill-badge skill-badge--${skill.source}`}>{skill.source}</span>
                </div>
            </div>
            <p className="skill-card-desc">{skill.description}</p>
            <div className="skill-card-footer">
                <div className="skill-card-meta">
                    {skill.hasResources && (
                        <span className="skill-card-resources">{skill.resourceCount} file{skill.resourceCount !== 1 ? 's' : ''}</span>
                    )}
                    {!skill.available && <span className="skill-card-unavailable">unavailable</span>}
                </div>
                <label
                    className="skill-toggle"
                    onClick={(e) => e.stopPropagation()}
                >
                    <input
                        type="checkbox"
                        checked={skill.enabled}
                        onChange={(e) => onToggle(skill.name, e.target.checked)}
                    />
                    <span className="skill-toggle-slider" />
                </label>
            </div>
        </div>
    );
}

/* ─── Skill Detail ────────────────────────────────────────────────── */

function SkillDetail({ name, onBack, onRefreshList }) {
    const [skill, setSkill] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [editing, setEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchSkill(name);
            setSkill(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [name]);

    useEffect(() => { load(); }, [load]);

    const handleEdit = () => {
        setEditContent(skill.content);
        setEditing(true);
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await saveSkill(name, editContent);
            setEditing(false);
            await load();
            onRefreshList();
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!confirm(`Delete workspace skill "${name}"?`)) return;
        setDeleting(true);
        try {
            await deleteSkill(name);
            onRefreshList();
            onBack();
        } catch (err) {
            setError(err.message);
            setDeleting(false);
        }
    };

    if (loading) return <div className="skill-detail-loading">Loading...</div>;
    if (error) return <div className="skill-detail-error">{error}</div>;
    if (!skill) return null;

    const resources = Array.isArray(skill.resources) ? skill.resources : [];

    return (
        <div className="skill-detail">
            <div className="skill-detail-header">
                <button className="skill-detail-back" onClick={onBack}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Back
                </button>
                <div className="skill-detail-actions">
                    {skill.metadata?.source !== 'builtin' && (
                        <>
                            {!editing && <button className="skill-btn skill-btn--secondary" onClick={handleEdit}>Edit</button>}
                            <button className="skill-btn skill-btn--danger" onClick={handleDelete} disabled={deleting}>
                                {deleting ? 'Deleting...' : 'Delete'}
                            </button>
                        </>
                    )}
                </div>
            </div>

            <div className="skill-detail-title">
                <h2>{name}</h2>
                {skill.metadata?.description && (
                    <p className="skill-detail-desc">{skill.metadata.description}</p>
                )}
                <div className="skill-detail-meta">
                    {skill.metadata?.license && <span className="skill-badge">license: {skill.metadata.license}</span>}
                    {skill.metadata?.always === true && <span className="skill-badge skill-badge--always">always active</span>}
                </div>
            </div>

            {editing ? (
                <div className="skill-editor">
                    <textarea
                        className="skill-editor-textarea"
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        spellCheck={false}
                    />
                    <div className="skill-editor-actions">
                        <button className="skill-btn skill-btn--secondary" onClick={() => setEditing(false)}>Cancel</button>
                        <button className="skill-btn skill-btn--primary" onClick={handleSave} disabled={saving}>
                            {saving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </div>
            ) : (
                <pre className="skill-detail-content">{skill.content}</pre>
            )}

            {resources.length > 0 && (
                <div className="skill-resources">
                    <h3>Resources ({resources.length})</h3>
                    <div className="skill-resources-list">
                        {resources.map((r) => (
                            <div key={r.path} className="skill-resource-item">
                                <span className="skill-resource-path">{r.path}</span>
                                <span className="skill-resource-size">{formatSize(r.size)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─── Create Skill Modal ──────────────────────────────────────────── */

function CreateSkillModal({ onClose, onCreated }) {
    const [name, setName] = useState('');
    const [content, setContent] = useState(`---
name: my-skill
description: What this skill does and when to use it.
---

# My Skill

Instructions for the agent...
`);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const handleCreate = async () => {
        const trimmedName = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        if (!trimmedName) {
            setError('Name is required.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await saveSkill(trimmedName, content);
            onCreated();
            onClose();
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="skill-modal-overlay" onClick={onClose}>
            <div className="skill-modal" onClick={(e) => e.stopPropagation()}>
                <div className="skill-modal-header">
                    <h2>Create Skill</h2>
                    <button className="skill-modal-close" onClick={onClose}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="skill-modal-body">
                    <label className="skill-form-label">
                        Name
                        <input
                            type="text"
                            className="skill-form-input"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="my-skill"
                        />
                    </label>
                    <label className="skill-form-label">
                        SKILL.md Content
                        <textarea
                            className="skill-editor-textarea"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            spellCheck={false}
                        />
                    </label>
                    {error && <div className="skill-form-error">{error}</div>}
                </div>
                <div className="skill-modal-footer">
                    <button className="skill-btn skill-btn--secondary" onClick={onClose}>Cancel</button>
                    <button className="skill-btn skill-btn--primary" onClick={handleCreate} disabled={saving}>
                        {saving ? 'Creating...' : 'Create'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/* ─── Main Panel ──────────────────────────────────────────────────── */

export function SkillsPanel() {
    const [skills, setSkills] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedSkill, setSelectedSkill] = useState(null);
    const [showCreate, setShowCreate] = useState(false);
    const [filter, setFilter] = useState('all'); // 'all' | 'builtin' | 'workspace' | 'active'

    const loadSkills = useCallback(async () => {
        try {
            const data = await fetchSkills();
            setSkills(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadSkills(); }, [loadSkills]);

    const handleToggle = async (name, enabled) => {
        // Optimistic update
        setSkills((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s));
        try {
            await setSkillEnabled(name, enabled);
        } catch {
            // Revert on failure
            setSkills((prev) => prev.map((s) => s.name === name ? { ...s, enabled: !enabled } : s));
        }
    };

    if (selectedSkill) {
        return (
            <SkillDetail
                name={selectedSkill}
                onBack={() => setSelectedSkill(null)}
                onRefreshList={loadSkills}
            />
        );
    }

    const filtered = skills.filter((s) => {
        if (filter === 'builtin') return s.source === 'builtin';
        if (filter === 'workspace') return s.source === 'workspace';
        if (filter === 'active') return s.enabled && s.available;
        return true;
    });

    const counts = {
        all: skills.length,
        builtin: skills.filter((s) => s.source === 'builtin').length,
        workspace: skills.filter((s) => s.source === 'workspace').length,
        active: skills.filter((s) => s.enabled && s.available).length,
    };

    return (
        <div className="skills-panel">
            <div className="skills-panel-header">
                <div className="skills-panel-title">
                    <h2>Skills</h2>
                    <span className="skills-count">{skills.length} total</span>
                </div>
                <div className="skills-panel-actions">
                    <div className="skills-filters">
                        {['all', 'active', 'builtin', 'workspace'].map((f) => (
                            <button
                                key={f}
                                className={`skills-filter-btn ${filter === f ? 'skills-filter-btn--active' : ''}`}
                                onClick={() => setFilter(f)}
                            >
                                {f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
                            </button>
                        ))}
                    </div>
                    <button className="skill-btn skill-btn--primary" onClick={() => setShowCreate(true)}>
                        + Create Skill
                    </button>
                </div>
            </div>

            {loading && <div className="skills-loading">Loading skills...</div>}
            {error && <div className="skills-error">{error}</div>}

            <div className="skills-grid">
                {filtered.map((skill) => (
                    <SkillCard
                        key={skill.name}
                        skill={skill}
                        onSelect={setSelectedSkill}
                        onToggle={handleToggle}
                    />
                ))}
                {!loading && filtered.length === 0 && (
                    <div className="skills-empty">No skills found for this filter.</div>
                )}
            </div>

            {showCreate && (
                <CreateSkillModal
                    onClose={() => setShowCreate(false)}
                    onCreated={loadSkills}
                />
            )}
        </div>
    );
}

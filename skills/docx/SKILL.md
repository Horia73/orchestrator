---
name: docx
description: Create, read, edit, and validate Microsoft Word .docx documents while preserving professional layout. Use for Word files, reports/memos/letters/templates requested as DOCX, content extraction or reorganization, find-and-replace, images, headings, tables of contents, headers/footers, tracked changes, and comments; exclude PDF, spreadsheet, Google Docs, and unrelated coding work.
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## Goal

Produce the requested Word result while preserving content, document structure, and layout fidelity.

## Success criteria

- Use the correct path for reading, creating, or editing rather than rebuilding an existing document unnecessarily.
- Save the final user-facing DOCX under workspace `files/` unless the user requests another destination.
- Validate the package and render layout-sensitive output before delivery.
- Report the file path, checks run, and any unresolved fidelity limitation.

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. Resolve every referenced file relative to `skill_root`; in commands below, set:

```bash
SKILL_ROOT="/absolute/path/from/ActivateSkill"
```

## Route the task

| Task | Primary route |
|---|---|
| Read/analyze | `pandoc --track-changes=all input.docx -o output.md` |
| Inspect raw structure | `python "$SKILL_ROOT/scripts/office/unpack.py" input.docx unpacked/` |
| Create a new document | docx-js; read `references/docx-implementation.md` first |
| Edit an existing document | unpack → edit OOXML → pack; read `references/docx-implementation.md` first |
| Accept tracked changes | `python "$SKILL_ROOT/scripts/accept_changes.py" input.docx output.docx` |
| Convert legacy `.doc` | `python "$SKILL_ROOT/scripts/office/soffice.py" --headless --convert-to docx input.doc` |

Prefer editing the existing package when the user supplied a DOCX whose formatting matters. Create from scratch only for a new document or when the user explicitly wants a rebuild.

## Workflow

1. Inspect the source and clarify only a missing requirement that would materially change content or layout.
2. Choose the route above and load `references/docx-implementation.md` only for docx-js or OOXML details.
3. Make the smallest content and structure changes that satisfy the request.
4. Validate the file:

   ```bash
   python "$SKILL_ROOT/scripts/office/validate.py" output.docx
   ```

5. For layout-sensitive work, render and inspect every page:

   ```bash
   python "$SKILL_ROOT/scripts/office/soffice.py" --headless --convert-to pdf output.docx
   pdftoppm -jpeg -r 150 output.pdf page
   ```

6. Revise until validation passes and the rendered pages have no clipping, broken hierarchy, unexpected pagination, missing content, or visual inconsistency.

## Constraints

- Preserve requested facts, structure, length, and genre before improving polish.
- Do not claim tracked changes, comments, or formatting survived unless the package/readback confirms it.
- Use `Orchestrator` as tracked-change/comment author unless the user requests another name.
- Do not use Unicode bullet characters for generated lists; use DOCX numbering.
- Do not use a success-shaped conversion response as proof of visual quality.

## Output and stop rules

Lead with the completed file link. Include only material assumptions, validation performed, and remaining limitations. Stop when the requested content is present, package validation passes, and layout-sensitive pages have been inspected. If rendering or validation is unavailable, state the exact missing check and the best fallback performed.

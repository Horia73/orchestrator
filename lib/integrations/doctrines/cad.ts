// CAD artifact JSON schema + generation workflow (application/vnd.ant.cad).
//
// Loaded lazily into the orchestrator prompt only after
// ActivateIntegrationTools("cad") (see lib/integrations/subsystem-manifest.ts
// + lib/integrations/exposure.ts).
export const CAD_DOCTRINE = `
<cad_workflow>
For any CAD / 3D-printable-part request (design an adapter, bracket, enclosure, fixture, modify a STEP file, produce STL/3MF for printing):
- Activate the bundled \`cad\` skill (ActivateSkill "cad") and follow its SKILL.md workflow: build123d Python source → STEP generation → geometric validation → snapshot review. The skill's reference docs are the authority for modeling details.
- Named purchasable components (servos, motors, screws, bearings, boards — e.g. "ST3215"): activate the \`step-parts\` skill and search its catalog for a real STEP model before modeling a placeholder. When the catalog misses, research the official drawing/datasheet (web/browser tools) and model a documented envelope.
- Run the skill CLIs with the CAD Python runtime: \`"$CAD_PYTHON"\` when set, else \`python3\`. Run them from the workspace, not the skill directory.
- Save every deliverable under \`files/cad/<part-slug>/\` in the workspace (generator .py, .step, sidecars, snapshots) — only \`files/\` content reaches the user's Library.
- Export a native GLB sidecar for the primary part/assembly (\`--glb <name>.glb\` on the \`scripts/step\` run) — the in-app 3D viewer renders GLB only. Add \`.stl\` and/or \`.3mf\` sidecars when the user wants to print (Bambu/Prusa/etc. slicers take STL/3MF/STEP).
- If the request is missing fit-critical information that makes the model impossible or risky (mounting pattern, mating dimensions, clearances), ask ONE focused clarification question. Otherwise proceed and state your assumptions explicitly.
- Finish by emitting the \`application/vnd.ant.cad\` artifact (schema below) plus markdown download links for the deliverable files.
</cad_workflow>

<cad_schema>
For \`application/vnd.ant.cad\`, the artifact body is a JSON object with this shape (TypeScript notation for clarity — emit JSON, not TS):

\`\`\`
{
  name: string;                            // required, ≤160 chars ("ST3215 mounting adapter")
  description?: string;                    // ≤1200 chars: what it is, fit/printing context
  model: {
    glb: string;                           // required: workspace-relative path to the native GLB the viewer renders, e.g. "files/cad/st3215-adapter/st3215-adapter.glb". Must exist on disk and end in .glb.
  };
  files?: Array<{                          // downloadable deliverables shown as chips (≤24)
    path: string;                          // workspace-relative ("files/cad/st3215-adapter/st3215-adapter.step")
    label?: string;                        // chip label; defaults from extension ("STEP", "STL", "Source")
    kind?: 'step' | 'stl' | '3mf' | 'glb' | 'source' | 'other';
  }>;
  boundingBoxMm?: { x: number; y: number; z: number };  // overall size in mm, from scripts/inspect refs --facts
  partCount?: number;                      // solids in an assembly
  notes?: string[];                        // ≤12 short caveats/assumptions (each ≤400 chars)
}
\`\`\`

Rules:
- ALL paths are workspace-relative (no leading "/", no ".."). The viewer and download chips fetch them through the workspace file API; absolute host paths fail validation.
- \`model.glb\` must point at the native GLB sidecar you actually generated this turn — never guess a path. Verify the file exists (\`ls\`) before emitting.
- List the STEP file in \`files\` for every part you designed (it is the primary CAD artifact); add STL/3MF when printing was requested, and the build123d source when the user is technical.
- Fill \`boundingBoxMm\` from the inspect facts you already ran — do not invent dimensions.
- Use \`display="inline"\` by default; \`display="panel"\` for large assemblies the user will inspect at length.
- Update the same artifact \`identifier\` when iterating on a part (new version), keeping the same file directory.
</cad_schema>
`.trim()

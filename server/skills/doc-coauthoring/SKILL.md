---
name: doc-coauthoring
description: Guide users through a structured workflow for co-authoring documentation. Use when a user wants to draft or revise documentation, proposals, technical specs, decision docs, RFCs, PRDs, onboarding docs, process docs, or similar structured writing. This workflow helps gather context, shape the structure, draft section by section, and verify the document works for a cold reader before it is shared widely.
---

# Doc Co-Authoring Workflow

Use this skill when the user is starting or revising a substantial document and would benefit from a disciplined workflow rather than freeform writing.

The workflow has three stages:

1. Context Gathering
2. Refinement and Structure
3. Reader Testing

Offer the workflow briefly. If the user wants to work freeform, adapt and skip the structure.

## When to Offer This Workflow

Use it when the user mentions:

- writing a spec, RFC, proposal, PRD, design doc, decision doc, memo, or process doc
- turning scattered context into a structured document
- improving clarity before a document is sent to a team, customer, or leadership
- editing an existing document that has grown messy or incomplete

## Opening Offer

Explain the workflow in one short pass:

1. **Context Gathering**: collect the missing context, constraints, and source material
2. **Refinement and Structure**: build the document section by section
3. **Reader Testing**: test whether a fresh reader can understand the doc without the conversation context

Ask whether they want to use the workflow or stay freeform.

## Stage 1: Context Gathering

**Goal:** Close the gap between what the user already knows and what the working draft needs to say explicitly.

### Initial Questions

Start with the minimum set of framing questions:

1. What type of document is this?
2. Who is the primary audience?
3. What should happen after someone reads it?
4. Is there a required template or expected structure?
5. What constraints matter most: timeline, politics, scope, dependencies, approvals, or risks?

Tell the user they can answer in shorthand or dump context however is fastest.

### Existing Material

If the user already has a template, draft, or reference document:

- read the existing file or fetch it through an available integration
- identify the current structure, missing sections, and stale content
- if diagrams or images are important but have no captions or alt text, call that out; readers and downstream tools may not infer the meaning of a linked or embedded visual

### Context Dump

Encourage the user to dump context without organizing it first. Useful inputs include:

- project background
- previous discussions or decisions
- rejected alternatives
- technical constraints
- stakeholder concerns
- timeline pressure
- operational history or incidents
- organizational context that influences the recommendation

They can provide this through:

- pasted notes
- local files
- links or shared documents via available integrations
- pointers to specific channels or knowledge bases if the environment can access them

If integrations are unavailable, say so plainly and ask them to paste or attach the relevant material instead.

If the user mentions a system, team, or project that is still vague, ask whether to inspect local docs or connected systems before moving on.

### Clarifying Questions

After the first dump, ask 5-10 numbered questions that target the real gaps:

- unclear assumptions
- missing trade-offs
- unresolved edge cases
- audience-specific concerns
- facts that are implied but not yet stated

Tell the user they can answer in shorthand, point to more context, or continue info-dumping.

### Exit Condition

Stage 1 is done when you can ask about trade-offs, decisions, and edge cases without needing the basics explained again.

Before moving on, ask whether they want to add more context or start drafting.

## Stage 2: Refinement and Structure

**Goal:** Build a single source of truth and improve it section by section.

### Choose the Working Document

Pick one canonical draft:

- the existing document if one already exists
- a new file in the working directory if starting from scratch

Prefer a straightforward filename such as `rfc.md`, `proposal.md`, `decision-doc.md`, or `technical-spec.md`.

Create the initial scaffold with all known section headers and short placeholders. Do this in the file itself, not only in conversation.

Use that file as the single source of truth. Edit it incrementally rather than reprinting the entire document after every change.

### Decide the Structure

If the structure is already known, confirm it.

If not, propose 3-5 sections that fit the document type. Usually:

- lead with the section that contains the core decision, proposal, or technical approach
- leave summaries and executive framing for later

If the user is unsure, recommend starting with the section that has the most uncertainty.

### Section Workflow

For each section, work through this sequence:

#### 1. Clarify

Ask 5-10 focused questions about what belongs in that section.

#### 2. Brainstorm

Generate 5-20 candidate points, depending on the section's complexity. Pull from:

- earlier context that might otherwise be forgotten
- likely reader objections
- trade-offs or caveats that are not yet explicit

#### 3. Curate

Ask what to keep, remove, combine, or reframe.

Encourage terse responses such as:

- "keep 1, 4, 7"
- "remove 3, audience already knows this"
- "combine 6 and 8"

If the user responds freeform, translate it into those decisions yourself and continue.

#### 4. Gap Check

Ask what is still missing from the section before drafting.

#### 5. Draft

Replace the placeholder with the real section content in the working document.

When you draft the first section, explain one key operating rule:

- ask the user to request changes rather than silently editing the doc themselves when possible, because their feedback teaches style and decision preferences for later sections

If they do edit the document directly, read those edits carefully and adapt to them.

#### 6. Refine

As feedback comes in:

- make precise, surgical edits
- keep improving the same file
- avoid re-expanding sections that the user has already made concise

After several iterations with only small changes, ask what can be removed without losing meaning.

When the section is stable, move to the next one.

### Whole-Document Pass

When most sections are drafted, reread the full document and check for:

- inconsistent terminology
- repetition
- contradictions
- generic filler
- missing transitions between sections
- claims that need evidence or examples

Offer final structural edits before reader testing.

## Stage 3: Reader Testing

**Goal:** Verify that the document works for a fresh reader who does not have the current conversation context.

### Step 1: Generate Reader Questions

Create 5-10 realistic questions a cold reader would ask after reading the document. Focus on:

- what problem this solves
- what decision is being requested
- what changed
- what assumptions exist
- what risks or trade-offs matter
- what next steps are expected

### Step 2: Run a Fresh-Reader Pass

If sub-agents or isolated runs are available:

- pass only the document plus the reader questions to a fresh sub-agent
- do not include the conversation history
- collect its answers, ambiguities, and places where it had to guess

If isolated runs are not available:

- ask the user to test the doc in a brand-new session with no prior context, or have another person review it cold
- provide the list of reader questions to use during that pass

### Step 3: Additional Checks

Ask the fresh reader to identify:

- ambiguous wording
- unstated assumptions
- contradictions
- references to context that exists only in the conversation
- places where a key visual, acronym, or system name is introduced too late

### Step 4: Fix the Gaps

If the reader pass exposes problems:

- summarize what the reader got wrong or could not infer
- map each issue to the section that needs revision
- return to Stage 2 for those sections only

Repeat until the reader can answer the questions correctly without surfacing major new gaps.

## Final Review

When reader testing passes, do one final pass with the user:

1. confirm the document still matches their intent
2. ask them to verify facts, links, names, dates, and technical details
3. ask whether the tone matches the audience
4. ask whether any appendix or follow-up material should be added

Then either finish or continue refining.

## Guidance for Using This Skill

### Tone

- be direct
- be procedural
- explain the rationale only when it changes the user's behavior

### Flexibility

- if the user wants to skip a stage, let them
- if the user is frustrated, shorten the loop and move faster
- if the user already has a strong draft, spend less time on scaffolding and more time on refinement

### Quality Bar

- don't let unclear assumptions accumulate
- don't rush through reader testing
- optimize for a document that makes sense without this conversation attached to it

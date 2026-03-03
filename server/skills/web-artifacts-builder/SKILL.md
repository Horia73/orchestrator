---
name: web-artifacts-builder
description: Toolkit for creating elaborate, multi-component single-file HTML web bundles using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex interactive web outputs requiring state management, routing, or shadcn/ui components, not for simple single-file HTML/JSX snippets.
license: Complete terms in LICENSE.txt
---

# Web Artifacts Builder

To build powerful frontend single-file web bundles, follow these steps:
1. Initialize the frontend repo using `scripts/init-artifact.sh`
2. Develop your web app by editing the generated code
3. Bundle all code into a single HTML file using `scripts/bundle-artifact.sh`
4. Share the generated `bundle.html` path with the user and tell them how to open it locally
5. (Optional) Test the bundle in a browser

**Stack**: React 18 + TypeScript + Vite + Parcel (bundling) + Tailwind CSS + shadcn/ui

## Design & Style Guidelines

VERY IMPORTANT: To avoid what is often referred to as "AI slop", avoid using excessive centered layouts, purple gradients, uniform rounded corners, and Inter font.

## Quick Start

### Step 1: Initialize Project

Run the initialization script to create a new React project:
```bash
bash scripts/init-artifact.sh <project-name>
cd <project-name>
```

This creates a fully configured project with:
- ✅ React + TypeScript (via Vite)
- ✅ Tailwind CSS 3.4.1 with shadcn/ui theming system
- ✅ Path aliases (`@/`) configured
- ✅ 40+ shadcn/ui components pre-installed
- ✅ All Radix UI dependencies included
- ✅ Parcel configured for bundling (via .parcelrc)
- ✅ Node 18+ compatibility (auto-detects and pins Vite version)

### Step 2: Develop Your Artifact

To build the app, edit the generated files.

### Step 3: Bundle to Single HTML File

To bundle the React app into a single HTML file:
```bash
bash scripts/bundle-artifact.sh
```

This creates `bundle.html`, a self-contained HTML file with all JavaScript, CSS, and dependencies inlined. It is meant to be opened locally in a browser or shared anywhere a standalone HTML file makes sense. Do not claim it will render inline as a chat artifact unless the runtime explicitly supports that.

**Requirements**: Your project must have an `index.html` in the root directory.

**What the script does**:
- Installs bundling dependencies (parcel, @parcel/config-default, parcel-resolver-tspaths, html-inline)
- Creates `.parcelrc` config with path alias support
- Builds with Parcel (no source maps)
- Inlines all assets into single HTML using html-inline

### Step 4: Share the Output with the User

Finally, share the bundled HTML file in conversation so the user can open it locally.

When you present the result:
- State the app or bundle title clearly.
- Mention the exact absolute path to `bundle.html`.
- Give one explicit next step telling the user to open the file in a browser.
- Only after that, optionally ask what they want changed.
- Do not stop at a vague presentation like "How does this look?" without telling the user where/how to open it.

### Step 5: Testing/Visualizing the Bundle (Optional)

Note: This is a completely optional step. Only perform if necessary or requested.

To test or inspect the bundle, use available tools such as the `webapp-testing` skill or other browser automation tools available in the environment. In general, avoid testing upfront because it adds latency before the user can open the finished result. Test later, after presenting the bundle, if requested or if issues arise.

## Reference

- **shadcn/ui components**: https://ui.shadcn.com/docs/components

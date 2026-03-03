---
name: theme-factory
description: Toolkit for styling artifacts with a reusable theme. Use when the user wants to restyle slides, documents, reports, dashboards, HTML pages, or other artifacts with a coherent visual direction. Includes 10 preset themes with color palettes and font pairings, and can also generate a custom theme when none of the presets fit.
license: Complete terms in LICENSE.txt
---

# Theme Factory Skill

This skill provides a curated collection of reusable themes. Each theme file in `themes/` defines:

- a named visual direction
- a color palette with hex codes
- header and body font choices
- guidance on when the theme works best

## Workflow

When the user wants a theme applied:

1. Show the available preset themes by listing them from the `themes/` directory and summarizing each theme briefly.
2. If the user wants a closer look, read one or more specific theme files and present the palette, typography, and intended mood.
3. Ask the user to choose a preset or request a custom theme.
4. After the choice is clear, apply the colors and fonts consistently to the target artifact.

If a visual preview would help and none exists yet, create a quick temporary HTML or markdown preview from the theme files instead of referring to a missing showcase asset.

## Preset Themes

The following preset themes are available in `themes/`:

1. **Ocean Depths** - Professional and calming maritime theme
2. **Sunset Boulevard** - Warm and vibrant sunset colors
3. **Forest Canopy** - Natural and grounded earth tones
4. **Modern Minimalist** - Clean and contemporary grayscale
5. **Golden Hour** - Rich and warm autumnal palette
6. **Arctic Frost** - Cool and crisp winter-inspired theme
7. **Desert Rose** - Soft and sophisticated dusty tones
8. **Tech Innovation** - Bold and modern tech aesthetic
9. **Botanical Garden** - Fresh and organic garden colors
10. **Midnight Galaxy** - Dramatic and cosmic deep tones

## Applying a Theme

After the user chooses a theme:

1. Read the corresponding file in `themes/`.
2. Extract the palette, font pairings, and usage guidance.
3. Apply the style consistently across the artifact:
   - headings
   - body text
   - accents and highlights
   - backgrounds and surfaces
   - charts, shapes, borders, or callouts if present
4. Maintain readability and contrast. Do not sacrifice legibility just to force the palette.

If the artifact already has a strong visual identity, adapt the chosen theme instead of replacing everything mechanically.

## Custom Themes

If none of the presets fit:

1. Ask for the intended mood, audience, and medium.
2. Generate a new theme in the same format as the preset files:
   - short theme name
   - palette with named colors and hex values
   - header/body font pairing
   - short "best used for" note
3. Show the proposed theme for review.
4. Once approved, apply it to the artifact.

## Practical Guidance

- Prefer presets when the user wants to move quickly.
- Use a custom theme when the work needs a distinct brand, event, campaign, or product-specific identity.
- If multiple artifacts belong to the same project, reuse the same theme to keep the output coherent.

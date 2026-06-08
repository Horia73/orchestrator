---
name: theme-factory
description: Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.
license: Complete terms in LICENSE.txt
---


# Theme Factory Skill

This skill provides a curated collection of professional font and color themes themes, each with carefully selected color palettes and font pairings. Once a theme is chosen, it can be applied to any artifact.

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. Resolve referenced files relative to `skill_root`; read theme files with `ReadSkillFile` when needed.

If the user needs to view the theme showcase, copy `theme-showcase.pdf` from `skill_root` to the workspace `files/` directory with a descriptive filename and provide that file as the review artifact. Do not modify the source showcase inside the skill folder.

When applying a theme to a file artifact, also activate and follow the format-specific skill when one exists (`pptx`, `docx`, `xlsx`, or `pdf`). Save final user-facing outputs under the workspace `files/` directory unless the user asks for a different destination.

## Purpose

To apply consistent, professional styling to presentation slide decks, documents, PDFs, reports, and HTML artifacts, use this skill. Each theme includes:
- A cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- A distinct visual identity suitable for different contexts and audiences

## Usage Instructions

To apply styling to a slide deck, document, PDF, report, or other artifact:

1. **Show the theme showcase when choosing matters**: Copy `theme-showcase.pdf` to the workspace `files/` directory and present it for review. Do not make any modifications to the skill's source PDF.
2. **Ask for their choice**: Ask which theme to apply to the artifact
3. **Wait for selection**: Get explicit confirmation about the chosen theme
4. **Apply the theme**: Once a theme has been chosen, apply the selected theme's colors and fonts to the deck/artifact

## Themes Available

The following 10 themes are available, each showcased in `theme-showcase.pdf`:

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

## Theme Details

Each theme is defined in the `themes/` directory with complete specifications including:
- Cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- Distinct visual identity suitable for different contexts and audiences

## Application Process

After a preferred theme is selected:
1. Read the corresponding theme file from the `themes/` directory
2. Apply the specified colors and fonts consistently throughout the artifact
3. Ensure proper contrast and readability
4. Maintain the theme's visual identity across all pages, slides, sections, or screens

## Create your Own Theme
To handle cases where none of the existing themes work for an artifact, create a custom theme. Based on provided inputs, generate a new theme similar to the ones above. Give the theme a similar name describing what the font/color combinations represent. Use any basic description provided to choose appropriate colors/fonts. After generating the theme, show it for review and verification. Following that, apply the theme as described above.

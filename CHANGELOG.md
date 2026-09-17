# Changelog

## 0.5.0 — Pre-release

- Remove the reserved scrollbar gutter and redundant inner heading from the left terminal view.
- Let expanded terminals share the available height and place collapsed sections at the bottom.
- Match left and right header heights, using the VS Code interface font and rounded active and hover states.
- Follow the editor's scrollbar dimensions and visibility, and use live theme colours for normal, hovered, and dragged sliders.
- Keep the original Photonico Code glyph contours, add weight and move them inward, and lengthen and rotate the twelve rounded ring segments.
- Store packaged VSIX files in `release/`, with platform and version in each filename.

## 0.3.0 — Pre-release

- Separate left and right startup profiles, open tabs, and terminal processes.
- Present left terminals as Explorer-style collapsible sections; rename the right container Side Terminal.
- Add runtime tabs with + or a double click on blank tab-strip space, and close them with × or a middle click without deleting startup settings.
- Remember workspace-local tab layout and ordinary Term numbering. Restore new shells without storing or replaying typed input.
- Use compact 24 px tabs, connected active backgrounds, and smaller rounded hover backgrounds.
- Refresh the logo with twelve rounded ring segments and heavier Photonico Code glyphs.
- Migrate legacy profiles to the right at read time and preserve compatibility with existing commands.
- Refactor project-owned code to descriptive snake_case and explicit lifecycle stages.

## 0.2.0 — Pre-release

This release extends the terminal view to both sidebars and refines profile configuration.

- Added **Side Term** to the Activity Bar for use in the left sidebar, alongside the existing right sidebar view.
- Reduced the space used by profile tabs and the configuration editor.
- Shared each profile's terminal process between both views, with independent tab selection and sizing from the focused view.
- Added shell detection, a default-shell choice, and a custom executable option. Detection does not execute candidate shells.
- Added save, undo, redo, close, and configuration controls to both views. Undo and redo apply to configuration drafts; saving a terminal exports its displayed plain text.
- Protected configuration saves against changes made after the editor was opened.
- Added a profile picker and a generic command for opening a profile by identifier and side.

The outer sidebar title remains **Side Term**, with profile names shown on the compact tabs inside it. Version 0.2.0 is distributed through the pre-release channel for testing.

## 0.1.0

- Independent terminal sessions in the secondary sidebar.
- Named tabs and a visual profile editor with startup commands and optional shells.
- User settings compatible with VS Code Settings Sync; CLI authentication stays with each CLI.
- Transparent Photonico Code logo and MIT licence.

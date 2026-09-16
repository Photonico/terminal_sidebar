# Changelog

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

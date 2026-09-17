# Changelog

## 0.7.0 — Pre-release

- Rename terminals from the edit button beside each sidebar's close button; preserve renamed tabs in the saved layout.
- Use **Side Terminals** for both view titles and clarify the buttons that open the opposite sidebar's terminals.
- Unify themed tab colours and compact circular action buttons; connect the Primary Side Bar's active, expanded tab background to its terminal.
- Add **Return to terminals** to startup configuration, preserving unsaved drafts and undo history for continued editing.
- Place startup profile titles and their actions on one line, use the same close icon as terminal tabs, and make shell detection and profile actions circular.
- Improve configuration text readability, balanced spacing, and field alignment as the font size changes.

## 0.6.0 — Pre-release

- Use the official Primary Side Bar and Secondary Side Bar names while preserving existing command identifiers and settings keys.
- Add **+** to the Secondary Side Bar's title toolbar. In both title toolbars, place **Open Secondary Terminal** or **Open Primary Terminal** immediately after **+**, using circled right or left arrows, respectively.
- Add a button in each empty state to open and focus the other Side Terminal view, including when it is hidden.

## 0.5.0 — Pre-release

- Reorder tabs by dragging or keyboard; restore each sidebar's saved order.
- Preserve section order when expanding or collapsing, with consistent headers and a status badge.
- Match left tab selection and hover colours to editor tabs; adapt empty views and footer backgrounds to the theme.
- Place empty-state guidance at the top with more space around the message.
- Theme-based scrollbars, rounded controls, and collapsible startup groups.
- Reset numbering after all ordinary tabs close.
- Unify Side Terminal naming; refine the logo and Activity Bar icon.
- Store platform VSIX packages in `release/`.

## 0.3.0 — Pre-release

- Independent sidebars, collapsible left sections, and compact right tabs.
- Add and close runtime tabs without changing startup profiles.
- Remember tab layouts without saving terminal input or output.
- Update the logo; preserve legacy profiles and commands.
- Adopt descriptive `snake_case` throughout project code.

## 0.2.0 — Pre-release

- Add the left Activity Bar view with shared terminal sessions.
- Compact tabs, shell detection, and custom shells.
- Configuration undo/redo, conflict checks, and terminal export.
- Profile picker and commands for either sidebar.

## 0.1.0

- Right sidebar terminals, named tabs, and startup configuration.
- Settings Sync support; CLI-managed credentials.
- Photonico Code logo and MIT licence.

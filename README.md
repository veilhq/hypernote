<p align="center">
  <img src="assets/hypernote.svg" alt="Hypernote" width="120">
</p>

<h1 align="center">Hypernote</h1>

<p align="center">
  A note-taking app for the Hyper(R) Ecosystem. Write markdown, organize it in a sidebar, and export finished notes into hyperspace as first-class documents.
</p>

---

## What It Does

Hypernote opens on a blank editor. Notes stay plain `.txt` or `.md` files, and the app adds structure around them:

- **Markdown editor** - full-window editor with a format ribbon (bold, italic, link, callouts, collapsible, table, task list), a selection popup, and an unsaved-changes indicator
- **Save and open** - native file dialogs limited to `.txt` and `.md`, read and written as UTF-8
- **Export to `notes/`** - writes `notes/{slug}.md` with the standard hyperspace metadata header (title, created, updated, tags). The slug comes from the title, and the default tag is `notes`
- **Rebuild on export** - a background Hypervisor build runs after export, so the note shows up in the site without a manual step
- **Scratch import** - pick a day that has `.scratch/` captures and load it as seed content under a `# Notes - YYYY-MM-DD` title. The scratch file is read, never modified
- **Notes sidebar** - lists everything in `notes/`, with a title filter, folders, and manual ordering
- **Folders are real directories** - creating a folder makes a subdirectory under `notes/`, and moving a note moves the file
- **Context menu** - new folder, rename, delete, move to, move up, move down
- **Ecosystem fit** - accent palette synced from Hypervisor, dark Windows title bar, and its own taskbar identity

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New note |
| `Ctrl+O` | Open file |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save as |
| `Ctrl+E` | Export to `notes/` |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | Bold / italic / link |
| `Ctrl+\` | Toggle the notes sidebar |
| `F1` | Markdown cheatsheet |
| `Esc` | Close dialogs and menus |

## Quick Start

> **Requires Hyperkit.** The build reads shared CSS and JS from `.hyperspace/.hyperkit/` and fails with a `FileNotFoundError` if it is missing. Hyperkit must exist as a sibling of `.hypernote/`.

```bash
pip install -r requirements.txt
cd .hypernote
pythonw hypernote.py
```

`hypernote.py` runs `build.py` on launch, so edits to `assets/` are always reflected. To rebuild by hand, run `python build.py`.

For a desktop shortcut with a matching taskbar identity, run `create-shortcut.ps1` from PowerShell. The AppUserModelID step needs `pywin32`; without it the shortcut still works and the running window groups under its own ID.

## Installation

**Requirements:** Python 3.11+

```
pywebview>=5.0
```

## How Notes Are Stored

Exported notes live in `.hyperspace/notes/`, a first-class Hypervisor content directory alongside `analysis/`, `research/`, and `ideas/`.

Folder structure and per-level ordering are kept in `notes/.hypernote-tree.json`. On load, the app reconciles that manifest against the files on disk. A note added outside the app is picked up, and one that was deleted is dropped. The manifest is dotfile-prefixed so the Hypervisor site build ignores it.

## Structure

```
.hypernote/
|-- hypernote.py           # PyWebView entrypoint and the JS bridge API (HypernoteAPI)
|-- build.py               # Concatenates Hyperkit + app CSS/JS into generated_html.py
|-- requirements.txt
|-- create-shortcut.ps1    # Builds the desktop shortcut and stamps its AppUserModelID
`-- assets/
    |-- shell.html         # HTML shell with {{CSS}}, {{JS_BLOCKS}}, {{LOGO_SVG}} placeholders
    |-- css/               # App-local styles; primitives come from Hyperkit
    |-- js/                # Frontend logic
    `-- hypernote.*        # Topbar mark (svg) and window icon (ico, several sizes)
```

`generated_html.py` is a build artifact and is gitignored.

## Dependencies

**Hyperkit** (`.hyperspace/.hyperkit/`) - shared design tokens, CSS primitives, the toast, tooltip, and context-menu scripts, and the Python logging and palette helpers. The build fails loudly if it is absent.

**Hypervisor** (`.hyperspace/.hypervisor/`) - supplies the live palette from `preferences.json` and the site build that runs after an export. Optional at runtime: without it the Hyperkit token defaults apply and editing still works.

## Notes

- The dark title bar and window icon are applied through the Windows DWM API after the webview loads. Applying them earlier fails silently, because the window cannot be found by title until it exists.
- Palette changes made in Hypervisor are picked up within a couple of seconds, so there is no need to restart after changing the accent.
- Logs go to `.hyperspace/.logs/hypernote.log`.

#!/usr/bin/env python3
"""
Hypernote - meeting-notes editor for the hyper ecosystem.

A lightweight PyWebView desktop app: edit/save/load .txt and .md files, export
structured notes into the hyperspace notes/ directory as first-class documents,
and seed a session by importing a chosen day of .scratch/ captures.

Part of the hyper ecosystem (Hypervisor, Hyperagent, Hyperfield, Hypernote).

Usage:
    pythonw hypernote.py
    pythonw hypernote.py --template idea-template.md --dir ideas
"""

import argparse
import json
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import webview

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
HYPERNOTE_DIR = Path(__file__).parent.resolve()
HYPERSPACE_ROOT = HYPERNOTE_DIR.parent
HYPERVISOR_DIR = HYPERSPACE_ROOT / ".hypervisor"
SCRATCH_DIR = HYPERSPACE_ROOT / ".scratch"
NOTES_DIR = HYPERSPACE_ROOT / "notes"
TEMPLATES_DIR = HYPERSPACE_ROOT / "templates"
TREE_MANIFEST = NOTES_DIR / ".hypernote-tree.json"
ICON_FILE = HYPERNOTE_DIR / "assets" / "hypernote.ico"

# Logging (shared ecosystem logger)
sys.path.insert(0, str(HYPERSPACE_ROOT / ".hyperkit" / "python"))
from hyper_logging import setup_logger  # noqa: E402

logger = setup_logger("hypernote")

# Palette builder (shared) - optional; fall back to a flat palette if absent.
try:
    from palette import build_palette_oklch, GRADIENT_MAPS  # noqa: E402
    HAS_PALETTE = True
except Exception:
    HAS_PALETTE = False
    logger.warning("palette module unavailable - using flat accent fallback")

# Auto-build: regenerate generated_html.py from current source before import
# (matches the hypereye/hyperfield launch-time rebuild pattern).
from launch_build import build_or_warn, with_notice  # noqa: E402
_build_notice = build_or_warn(HYPERNOTE_DIR, "Hypernote")
from generated_html import HTML  # noqa: E402
HTML = with_notice(HTML, _build_notice)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(text: str) -> str:
    slug = _SLUG_RE.sub("-", (text or "").lower()).strip("-")
    return slug or "untitled-note"


def _now_stamp() -> str:
    """Local time in the hyperspace metadata format (YYYY-MM-DDTHH:MM)."""
    return datetime.now().strftime("%Y-%m-%dT%H:%M")


def _human_age(mtime: float) -> str:
    """Compact relative age like '2h', '3d', '1w' from an mtime."""
    delta = time.time() - mtime
    mins = int(delta // 60)
    if mins < 1:
        return "now"
    if mins < 60:
        return f"{mins}m"
    hrs = mins // 60
    if hrs < 24:
        return f"{hrs}h"
    days = hrs // 24
    if days < 7:
        return f"{days}d"
    weeks = days // 7
    if weeks < 52:
        return f"{weeks}w"
    return f"{days // 365}y"


def _title_from_content(text: str, fallback: str) -> str:
    """Derive a display title from a note's H1 heading, else the first plain
    line of prose. Skips lines that are clearly not a title: metadata header
    fields, horizontal rules, blockquotes/callouts, list items, table rows,
    and fenced-code markers. Falls back to the given name (slug-derived)."""
    lines = text.splitlines()
    # Prefer an explicit H1 anywhere in the first chunk of the document.
    for line in lines[:40]:
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()
    # No H1 — take the first line that reads like prose, skipping structure.
    for line in lines[:40]:
        s = line.strip()
        if not s:
            continue
        if s == "---" or s.startswith(">") or s.startswith("+++") or s.startswith("|"):
            continue
        if s.startswith(("- ", "* ", "```")) or re.match(r"^\d+\.\s", s):
            continue
        # Skip dash-prefixed metadata fields (- Created:, - Tags:, etc.)
        if re.match(r"^-?\s*[A-Za-z][A-Za-z ]*:\s", s):
            continue
        return s[:60]
    return fallback


# ---------------------------------------------------------------------------
# Palette (read from Hypervisor preferences - shared across the ecosystem)
# ---------------------------------------------------------------------------
def _read_palette() -> dict:
    """Return the ecosystem palette from Hypervisor's preferences.json.

    Mirrors Hyperfield's _read_palette: handles preset and custom modes and the
    light-mode flag. Falls back to a flat green accent if anything is missing.
    """
    prefs_file = HYPERVISOR_DIR / "preferences.json"
    fallback = {"accent": "#00ff41", "warm": "#ffb000", "cool": "#00cccc",
                "comp": "#ff3333", "mode": "custom", "lightMode": False}
    try:
        if not prefs_file.exists():
            return fallback
        data = json.loads(prefs_file.read_text(encoding="utf-8"))
        light_mode = data.get("hypervisor-light-mode", "0") == "1"
        theme_mode = data.get("hypervisor-theme-mode", "custom")
        gradient_map = data.get("hypervisor-gradient-map", "")

        if HAS_PALETTE and theme_mode == "preset" and gradient_map:
            preset = GRADIENT_MAPS.get(gradient_map) or data.get("userGradientMaps", {}).get(gradient_map)
            if preset:
                return {
                    "accent": preset["accent"], "warm": preset["warm"],
                    "cool": preset["cool"], "comp": preset["comp"],
                    "semantics": preset.get("semantics"), "mode": "preset",
                    "gradientMap": gradient_map, "lightMode": light_mode,
                }

        accent = data.get("hypervisor-accent", "#00ff41")
        if HAS_PALETTE:
            mode = data.get("hypervisor-palette-mode", "split")
            palette = build_palette_oklch(accent, mode)
            palette["mode"] = "custom"
            palette["lightMode"] = light_mode
            return palette
        out = dict(fallback)
        out["accent"] = accent
        out["lightMode"] = light_mode
        return out
    except Exception as e:
        logger.warning("palette read failed: %s", e)
        return fallback


# ---------------------------------------------------------------------------
# Notes tree manifest (folder structure + manual ordering, reconciled to disk)
# ---------------------------------------------------------------------------
def _load_manifest() -> dict:
    if TREE_MANIFEST.exists():
        try:
            return json.loads(TREE_MANIFEST.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("tree manifest unreadable, rebuilding: %s", e)
    return {"version": 1, "tree": []}


def _save_manifest(manifest: dict) -> None:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    TREE_MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _scan_notes_disk() -> dict:
    """Map every note file on disk to its metadata: {relpath: {title, age, folder}}."""
    found = {}
    if not NOTES_DIR.exists():
        return found
    for path in NOTES_DIR.rglob("*.md"):
        name = path.name
        if name.startswith("_") or name.startswith("."):
            continue  # skip _meta.md, _index fragments, dotfiles
        rel = path.relative_to(NOTES_DIR).as_posix()
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            text = ""
        found[rel] = {
            "title": _title_from_content(text, path.stem.replace("-", " ").title()),
            "age": _human_age(path.stat().st_mtime),
            "folder": path.parent.relative_to(NOTES_DIR).as_posix() if path.parent != NOTES_DIR else "",
        }
    return found


def _reconcile_tree() -> dict:
    """Reconcile the manifest against files on disk.

    - Drop manifest note-nodes whose file no longer exists.
    - Append note files present on disk but absent from the manifest (root or,
      if they live in a subdir that is a manifest folder, that folder).
    - Preserve folder structure and manual ordering already in the manifest.
    Returns the reconciled manifest (also persisted).
    """
    manifest = _load_manifest()
    disk = _scan_notes_disk()

    # Collect note relpaths already represented in the manifest.
    represented = set()

    def visit(nodes):
        kept = []
        for node in nodes:
            if node.get("type") == "folder":
                node["children"] = visit(node.get("children", []))
                kept.append(node)
            else:
                rel = node.get("path")
                if rel in disk:
                    # Keep the manifest's stored title (set from the title field
                    # on export/rename); only fall back to the disk-derived
                    # title when the node has none (e.g. a file added outside
                    # the app). Always refresh the age from disk.
                    if not node.get("title"):
                        node["title"] = disk[rel]["title"]
                    node["age"] = disk[rel]["age"]
                    represented.add(rel)
                    kept.append(node)
                # else: file gone -> drop the node
        return kept

    tree = visit(manifest.get("tree", []))

    # Index manifest folders by their posix path so orphan files can be placed.
    folders_by_path = {}

    def index_folders(nodes, prefix=""):
        for node in nodes:
            if node.get("type") == "folder":
                fpath = (prefix + "/" + node["name"]).strip("/") if prefix else node["name"]
                folders_by_path[fpath] = node
                index_folders(node.get("children", []), fpath)

    index_folders(tree)

    # Append disk files missing from the manifest.
    for rel, meta in sorted(disk.items()):
        if rel in represented:
            continue
        note_node = {"type": "note", "path": rel, "title": meta["title"], "age": meta["age"], "tag": "notes"}
        folder = meta["folder"]
        if folder and folder in folders_by_path:
            folders_by_path[folder].setdefault("children", []).append(note_node)
        elif folder:
            # File in a subdir with no matching manifest folder - create the folder node.
            fnode = {"type": "folder", "name": folder, "collapsed": False, "children": [note_node]}
            tree.append(fnode)
            folders_by_path[folder] = fnode
        else:
            tree.append(note_node)

    manifest["tree"] = tree
    _save_manifest(manifest)
    return manifest


def _find_node(tree, path):
    """Return (parent_list, index, node) for a note by relpath, or (None, -1, None)."""
    def walk(nodes):
        for i, node in enumerate(nodes):
            if node.get("type") == "note" and node.get("path") == path:
                return nodes, i, node
            if node.get("type") == "folder":
                r = walk(node.get("children", []))
                if r[2]:
                    return r
        return None, -1, None
    return walk(tree.get("tree", []) if isinstance(tree, dict) else tree)


def _find_folder(tree, name):
    """Return the folder node with the given name (first match), or None."""
    def walk(nodes):
        for node in nodes:
            if node.get("type") == "folder":
                if node.get("name") == name:
                    return node
                r = walk(node.get("children", []))
                if r:
                    return r
        return None
    return walk(tree.get("tree", []) if isinstance(tree, dict) else tree)


# ---------------------------------------------------------------------------
# Bridge API (exposed to the frontend via window.pywebview.api)
# ---------------------------------------------------------------------------
class HypernoteAPI:
    """PyWebView JS bridge for Hypernote."""

    def __init__(self):
        self._window = None

    def set_window(self, window):
        self._window = window

    # --- palette ---
    def get_accent(self) -> dict:
        return _read_palette()

    # --- file save / load (txt + md) ---
    def open_file(self) -> dict:
        """Open a native picker for .txt/.md and return {path, name, ext, content}."""
        win = self._window
        if not win:
            return {"error": "no window"}
        result = win.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False,
            file_types=("Markdown/Text (*.md;*.txt)", "All files (*.*)"),
        )
        if not result:
            return {"cancelled": True}
        path = Path(result[0])
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            logger.warning("open_file read error %s: %s", path, e)
            return {"error": str(e)}
        logger.info("opened %s", path)
        return {"path": str(path), "name": path.name, "ext": path.suffix.lstrip(".").lower() or "txt", "content": content}

    def save_file(self, content: str, suggested_name: str = "untitled.md", existing_path: str = "") -> dict:
        """Save content. If existing_path is given, overwrite it; else open Save dialog."""
        win = self._window
        if existing_path:
            path = Path(existing_path)
        else:
            if not win:
                return {"error": "no window"}
            result = win.create_file_dialog(
                webview.SAVE_DIALOG, save_filename=suggested_name,
                file_types=("Markdown (*.md)", "Text (*.txt)", "All files (*.*)"),
            )
            if not result:
                return {"cancelled": True}
            path = Path(result if isinstance(result, str) else result[0])
        try:
            path.write_text(content, encoding="utf-8")
        except Exception as e:
            logger.warning("save_file write error %s: %s", path, e)
            return {"error": str(e)}
        logger.info("saved %s (%d bytes)", path, len(content))
        return {"path": str(path), "name": path.name, "ext": path.suffix.lstrip(".").lower() or "txt"}

    # --- scratch import ---
    def list_scratch_days(self) -> list:
        """Return [{date, count}] for every .scratch/YYYY-MM-DD.md, newest first."""
        days = []
        if not SCRATCH_DIR.exists():
            return days
        for path in sorted(SCRATCH_DIR.glob("*.md"), reverse=True):
            stem = path.stem
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", stem):
                continue  # skip _report.md etc.
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            count = len(re.findall(r"^##\s+\d{1,2}:\d{2}", text, re.MULTILINE))
            days.append({"date": stem, "count": count})
        return days

    def import_scratch_day(self, date: str) -> dict:
        """Read a scratch day and return lightly-restructured seed content.

        Never modifies the source scratch file. The seed is a '# Notes - DATE'
        title followed by the day's entries, ready to expand in the editor.
        """
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or ""):
            return {"error": "bad date"}
        path = SCRATCH_DIR / f"{date}.md"
        if not path.exists():
            return {"error": "no scratch for that day"}
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            return {"error": str(e)}

        # Extract the timestamped entries; strip the scratch's own top-level header.
        lines = raw.splitlines()
        body_lines = []
        for ln in lines:
            if ln.startswith("# "):
                continue  # drop the '# Scratch - DATE' header
            body_lines.append(ln)
        body = "\n".join(body_lines).strip()

        seed = f"# Notes - {date}\n\n"
        if body:
            seed += body + "\n"
        logger.info("imported scratch day %s (%d chars seed)", date, len(seed))
        return {"title": f"Notes {date}", "content": seed}

    # --- templates ---
    def get_launch_context(self) -> dict:
        """Template and target directory passed on the command line, if any."""
        return dict(LAUNCH_CONTEXT)

    def list_templates(self) -> list:
        """Return [{name, title}] for each markdown file in templates/."""
        out = []
        if not TEMPLATES_DIR.exists():
            return out
        for path in sorted(TEMPLATES_DIR.glob("*.md")):
            if path.name.startswith("_"):
                continue
            title = path.stem.removesuffix("-template").replace("-", " ").replace("_", " ")
            out.append({"name": path.name, "title": title})
        return out

    def import_template(self, name: str) -> dict:
        """Read templates/{name} and return its raw content."""
        path = (TEMPLATES_DIR / (name or "")).resolve()
        if path.parent != TEMPLATES_DIR.resolve() or path.suffix != ".md" or path.name.startswith("_") or not path.is_file():
            return {"error": "unknown template"}
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as e:
            return {"error": str(e)}
        logger.info("imported template %s", path.name)
        return {"name": path.name, "content": content}

    def export_to_directory(self, rel_dir: str, title: str, content: str) -> dict:
        """Write {rel_dir}/{slug}.md verbatim (templates carry their own header)
        and trigger a Hypervisor rebuild. Never overwrites an existing file."""
        target = (HYPERSPACE_ROOT / (rel_dir or "")).resolve()
        root = HYPERSPACE_ROOT.resolve()
        if root not in target.parents or any(p.startswith(".") for p in target.relative_to(root).parts):
            return {"error": "directory outside hyperspace"}
        target.mkdir(parents=True, exist_ok=True)
        path = target / f"{_slugify(title)}.md"
        if path.exists():
            return {"error": f"{path.name} already exists"}
        try:
            path.write_text(content or "", encoding="utf-8")
        except Exception as e:
            logger.warning("export_to_directory write error %s: %s", path, e)
            return {"error": str(e)}
        rel = path.relative_to(root).as_posix()
        logger.info("exported %s", rel)
        self._trigger_rebuild()
        return {"path": rel}

    # --- export to notes/ ---
    def export_note(self, title: str, content: str, folder: str = "") -> dict:
        """Write notes/[folder/]{slug}.md with a hyperspace metadata header,
        register it in the tree manifest, and trigger a Hypervisor rebuild."""
        NOTES_DIR.mkdir(parents=True, exist_ok=True)
        slug = _slugify(title)
        display = (title or "Untitled note").strip()
        target_dir = NOTES_DIR
        rel_folder = ""
        if folder:
            safe = _slugify(folder)
            # folder is a display name from the tree; map to its on-disk subdir
            target_dir = NOTES_DIR / safe
            target_dir.mkdir(parents=True, exist_ok=True)
            rel_folder = safe
        path = target_dir / f"{slug}.md"
        stamp = _now_stamp()

        header = (
            f"# {display}\n\n"
            f"Note exported from Hypernote.\n\n"
            f"- Created: {stamp}\n"
            f"- Updated: {stamp}\n"
            f"- Tags: notes\n\n"
            f"---\n\n"
        )
        # If the body already opens with an H1 matching the title, don't double it.
        body = content or ""
        stripped = body.lstrip()
        if stripped.startswith(f"# {display}"):
            body = stripped[len(f"# {display}"):].lstrip("\n")

        try:
            path.write_text(header + body, encoding="utf-8")
        except Exception as e:
            logger.warning("export write error %s: %s", path, e)
            return {"error": str(e)}

        rel = path.relative_to(NOTES_DIR).as_posix()
        logger.info("exported %s", rel)

        # Register in the tree manifest (append to folder or root if new).
        manifest = _load_manifest()
        _, _, existing = _find_node(manifest, rel)
        if not existing:
            note_node = {"type": "note", "path": rel, "title": display, "age": "now", "tag": "notes"}
            if rel_folder:
                fnode = _find_folder(manifest, rel_folder)
                if fnode:
                    fnode.setdefault("children", []).append(note_node)
                else:
                    manifest["tree"].append(note_node)
            else:
                manifest["tree"].insert(0, note_node)
            _save_manifest(manifest)

        # Rebuild the Hypervisor site off the main thread so export stays snappy.
        self._trigger_rebuild()
        return {"path": rel, "slug": slug}

    def _trigger_rebuild(self):
        def _run():
            try:
                bp = HYPERVISOR_DIR / "build.py"
                if not bp.exists():
                    logger.warning("hypervisor build.py not found; skipping rebuild")
                    return
                subprocess.run([sys.executable, str(bp)], cwd=str(HYPERVISOR_DIR),
                               creationflags=0x08000000)  # CREATE_NO_WINDOW
                logger.info("hypervisor rebuild complete")
                if self._window:
                    self._window.evaluate_js("if(window.__hnRebuilt)window.__hnRebuilt()")
            except Exception as e:
                logger.warning("rebuild failed: %s", e)
        threading.Thread(target=_run, daemon=True).start()

    # --- notes tree ---
    def list_notes_tree(self) -> dict:
        """Return the reconciled folder/note tree for the sidebar."""
        return _reconcile_tree()

    def read_note(self, path: str) -> dict:
        """Read a note file (notes-relative path) and return its content."""
        src = NOTES_DIR / path
        if not src.exists() or not src.is_file():
            return {"error": "not found"}
        try:
            content = src.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            return {"error": str(e)}
        return {"path": str(src), "content": content}

    def create_folder(self, name: str) -> dict:
        safe = _slugify(name)
        if not safe:
            return {"error": "bad name"}
        (NOTES_DIR / safe).mkdir(parents=True, exist_ok=True)
        manifest = _load_manifest()
        if not _find_folder(manifest, safe):
            manifest["tree"].insert(0, {"type": "folder", "name": safe, "collapsed": False, "children": []})
            _save_manifest(manifest)
        logger.info("created folder %s", safe)
        return {"ok": True, "name": safe}

    def rename_folder(self, name: str, new_name: str) -> dict:
        """Rename a folder subdir on disk and update the manifest (folder node
        name + the relpath of every note inside it)."""
        old_safe = _slugify(name)
        new_safe = _slugify(new_name)
        if not new_safe:
            return {"error": "bad name"}
        if old_safe == new_safe:
            return {"ok": True, "name": new_safe}
        src = NOTES_DIR / old_safe
        dst = NOTES_DIR / new_safe
        if dst.exists():
            return {"error": "a folder with that name already exists"}
        try:
            if src.exists():
                src.rename(dst)
        except Exception as e:
            return {"error": str(e)}
        manifest = _load_manifest()
        fnode = _find_folder(manifest, old_safe)
        if fnode:
            fnode["name"] = new_safe
            # rewrite child note relpaths from old subdir to new
            for child in fnode.get("children", []):
                if child.get("type") == "note" and child.get("path", "").startswith(old_safe + "/"):
                    child["path"] = new_safe + "/" + child["path"].split("/", 1)[1]
            _save_manifest(manifest)
        logger.info("renamed folder %s -> %s", old_safe, new_safe)
        self._trigger_rebuild()
        return {"ok": True, "name": new_safe}

    def rename_note(self, path: str, new_title: str) -> dict:
        """Rename a note file (slug follows title) and update the manifest."""
        src = NOTES_DIR / path
        if not src.exists():
            return {"error": "not found"}
        new_slug = _slugify(new_title)
        dst = src.with_name(f"{new_slug}.md")
        try:
            if dst != src:
                src.rename(dst)
        except Exception as e:
            return {"error": str(e)}
        manifest = _load_manifest()
        _, _, node = _find_node(manifest, path)
        if node:
            node["path"] = dst.relative_to(NOTES_DIR).as_posix()
            node["title"] = new_title.strip()
            _save_manifest(manifest)
        logger.info("renamed %s -> %s", path, dst.name)
        return {"ok": True, "path": dst.relative_to(NOTES_DIR).as_posix(), "title": new_title.strip()}

    def delete_note(self, path: str) -> dict:
        src = NOTES_DIR / path
        try:
            if src.exists():
                src.unlink()
        except Exception as e:
            return {"error": str(e)}
        manifest = _load_manifest()
        parent, idx, node = _find_node(manifest, path)
        if node:
            parent.pop(idx)
            _save_manifest(manifest)
        logger.info("deleted note %s", path)
        self._trigger_rebuild()
        return {"ok": True}

    def move_note(self, path: str, folder: str) -> dict:
        """Move a note file into folder (or root if folder is empty) + update manifest."""
        src = NOTES_DIR / path
        if not src.exists():
            return {"error": "not found"}
        dest_dir = NOTES_DIR if not folder else (NOTES_DIR / _slugify(folder))
        dest_dir.mkdir(parents=True, exist_ok=True)
        dst = dest_dir / src.name
        try:
            if dst != src:
                src.rename(dst)
        except Exception as e:
            return {"error": str(e)}
        rel_new = dst.relative_to(NOTES_DIR).as_posix()
        manifest = _load_manifest()
        parent, idx, node = _find_node(manifest, path)
        if node:
            parent.pop(idx)
            node["path"] = rel_new
            if folder:
                fnode = _find_folder(manifest, _slugify(folder))
                (fnode["children"] if fnode else manifest["tree"]).append(node)
            else:
                manifest["tree"].append(node)
            _save_manifest(manifest)
        logger.info("moved %s -> %s", path, rel_new)
        return {"ok": True, "path": rel_new}

    def reorder_note(self, path: str, direction: int) -> dict:
        """Swap a note with its sibling one step up (-1) or down (+1)."""
        manifest = _load_manifest()
        parent, idx, node = _find_node(manifest, path)
        if not node:
            return {"error": "not found"}
        j = idx + (1 if direction > 0 else -1)
        if 0 <= j < len(parent):
            parent[idx], parent[j] = parent[j], parent[idx]
            _save_manifest(manifest)
        return {"ok": True}


# ---------------------------------------------------------------------------
# Window chrome (dark title bar + icon via Windows DWM API)
# ---------------------------------------------------------------------------
def _apply_window_chrome(title: str):
    try:
        import ctypes
        hwnd = ctypes.windll.user32.FindWindowW(None, title)
        if not hwnd:
            return
        DWMWA_USE_IMMERSIVE_DARK_MODE = 20
        val = ctypes.c_int(1)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.byref(val), ctypes.sizeof(val)
        )
        if ICON_FILE.exists():
            IMAGE_ICON, LR_LOADFROMFILE, WM_SETICON = 1, 0x0010, 0x0080
            ICON_BIG, ICON_SMALL = 1, 0
            hicon = ctypes.windll.user32.LoadImageW(0, str(ICON_FILE), IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
            if hicon:
                ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon)
                ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Theme watcher (re-sync accent when Hypervisor prefs change)
# ---------------------------------------------------------------------------
def _start_theme_watcher(window):
    prefs_file = HYPERVISOR_DIR / "preferences.json"
    last_mtime = prefs_file.stat().st_mtime if prefs_file.exists() else 0

    def _watch():
        nonlocal last_mtime
        while True:
            time.sleep(2)
            try:
                if not prefs_file.exists():
                    continue
                mtime = prefs_file.stat().st_mtime
                if mtime != last_mtime:
                    last_mtime = mtime
                    palette = _read_palette()
                    payload = json.dumps(palette).replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
                    window.evaluate_js(f"if(window.applyAccent)window.applyAccent(JSON.parse(`{payload}`))")
            except Exception:
                pass

    threading.Thread(target=_watch, daemon=True).start()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
LAUNCH_CONTEXT = {"template": "", "dir": ""}


def _parse_args(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--template", default="")
    parser.add_argument("--dir", default="")
    args, _ = parser.parse_known_args(argv)
    return args


def main():
    args = _parse_args(sys.argv[1:])
    LAUNCH_CONTEXT["template"] = args.template
    LAUNCH_CONTEXT["dir"] = args.dir.replace("\\", "/").strip("/")
    # Set a unique AppUserModelID so Windows treats this as a distinct taskbar
    # entry, separate from Hypervisor and other pythonw-hosted ecosystem apps.
    import ctypes
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Hyper.Hypernote")
    except Exception:
        pass

    logger.info("hypernote starting")
    NOTES_DIR.mkdir(parents=True, exist_ok=True)

    api = HypernoteAPI()
    icon_path = str(ICON_FILE) if ICON_FILE.exists() else None

    window = webview.create_window(
        "Hypernote",
        html=HTML,
        js_api=api,
        width=1080,
        height=740,
        min_size=(720, 480),
        background_color="#030305",
    )

    def on_start():
        time.sleep(0.5)
        _apply_window_chrome("Hypernote")
        api.set_window(window)
        _start_theme_watcher(window)
        logger.info("hypernote ready")

    webview.start(on_start, icon=icon_path, debug=False)
    logger.info("hypernote closed")


if __name__ == "__main__":
    main()

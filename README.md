# Obsidian Autosave Control

This plugin gives you full control over how Obsidian.md saves your notes.

By default, Obsidian saves every ~2 seconds while you type. While convenient, this behavior can cause issues such as:

- Sync conflicts with cloud storage (e.g. Google Drive, Dropbox, Proton Drive, ...)
- Performance problems with large files
- Issues when working on network drives
- Increased battery usage

This plugin allows you to change that behavior.

## Modes

### 1. Delayed Autosave

- You type normally.
- The save timer resets on every edit (per file).
- Obsidian saves **once**, only after you stop editing for the configured delay (by default 10 seconds).

This reduces unnecessary writes and avoids constant file updates.

### 2. Autosave Disabled

- No automatic saving occurs.
- Files are saved **only** when you manually trigger a save.
- You must use the **Save File** command (assign a hotkey if needed).
- Closing a note or quitting Obsidian with unsaved changes will show a warning.

## Status Indicator

The plugin shows save state in the status bar:

🔵 Blue — Unsaved changes pending  
🟢 Green — All changes saved  

Colors and the size of the icon can be customized in settings.

## Settings

### Save Delay

- Defines how long Obsidian waits after you stop editing before saving
- Only available in **Delayed Autosave** mode

### Disable Autosave Completely

- Turns off all automatic saving
- Hides the delay setting
- Requires manual saves

### Saved status color

- Status dot color when all changes are saved.

### Pending status color

- Status dot color while changes are not saved.

### Status icon size

- Size of the status bar dot in pixels.

## Installation

1. Download the latest release from GitHub:  
   https://github.com/mihasm/obsidian-autosave-control/releases

2. Extract the `.zip` file

3. Copy the contents into: `your-vault/.obsidian/plugins/autosave-control`.
4. In Obsidian:
- Open **Settings → Community Plugins**
- Enable the plugin

## Important Notes

- Unsaved changes are kept in memory until written to disk.
- If Obsidian or your system crashes before saving, changes may be lost.
- This plugin reduces disk writes, but does **not** provide backup functionality.

## How It Works

The plugin intercepts editor change events and delays or suppresses save operations using a debounced save mechanism.

## License

MIT — see `LICENSE`

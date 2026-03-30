# Obsidian Autosave Control

## Overview

This plugin gives you full control over how Obsidian.md saves your notes.

By default, Obsidian saves every ~2 seconds while you type. While convenient, this behavior can cause issues such as:

- Sync conflicts with cloud storage (e.g. Proton Drive)
- Performance problems with large files
- Issues when working on network drives
- Increased battery usage

This plugin allows you to change that behavior.

---

## Modes

### 1. Delayed Autosave

- You type normally.
- The save timer resets on every change.
- Obsidian saves **once**, only after you stop editing for the configured delay.

This reduces unnecessary writes and avoids constant file updates.

---

### 2. Autosave Disabled

- No automatic saving occurs.
- Files are saved **only** when you manually trigger a save.

Important behavior:

- You must use the **Save File** command (assign a hotkey if needed).
- Closing a note or quitting Obsidian with unsaved changes will show a warning.

---

## Default vs Plugin Behavior

### Default Obsidian

- Saves continuously (every ~2 seconds while typing)

### Delayed Mode

- Saves once after you stop typing
- Timer resets on every keystroke

### Disabled Mode

- No autosave at all
- Manual save only

---

## Status Indicator

The plugin shows save state in the status bar:

- 🔵 Blue — Unsaved changes pending  
- 🟢 Green — All changes saved  

Colors can be customized in settings.

---

## Settings

### Save Delay

- Defines how long Obsidian waits after you stop editing before saving
- Only available in **Delayed Autosave** mode

### Disable Autosave Completely

- Turns off all automatic saving
- Hides the delay setting
- Requires manual saves

---

## When to Use Each Mode

**Delayed Autosave**
- Recommended for most users
- Best for use with cloud sync services
- Reduces file churn and sync conflicts

**Autosave Disabled**
- For advanced users
- Useful in controlled environments or when working with sensitive workflows
- Requires disciplined manual saving

---

## Installation

1. Download the latest release from GitHub:  
   https://github.com/mihasm/obsidian-autosave-control/releases

2. Extract the `.zip` file

3. Copy the contents into: `your-vault/.obsidian/plugins/autosave-control`.
4. In Obsidian:
- Open **Settings → Community Plugins**
- Enable the plugin

---

## Important Notes

- Unsaved changes are kept in memory until written to disk.
- If Obsidian or your system crashes before saving, changes may be lost.
- This plugin reduces disk writes, but does **not** provide backup functionality.

---

## How It Works

The plugin intercepts editor change events and delays or suppresses save operations using a debounced save mechanism.

---

## License

MIT — see `LICENSE`

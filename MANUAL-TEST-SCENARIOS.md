# Manual Test Scenarios

Use a visible save delay while testing, preferably `5s` or `10s`.

## Setup

- Enable the plugin and confirm the status dot appears in the status bar.
- Open a markdown note and keep the file visible in Finder/Explorer or a sync client so disk writes are easy to notice.
- Repeat the core checks on at least one desktop platform you care about, especially if a change touches window handling.

## Core Delayed Save

- [ ] Type normal letters continuously for longer than 2 seconds. Expected: status dot turns pending quickly and no disk save happens until you stop typing and the full configured delay expires.
- [ ] Stop typing and wait for the configured delay. Expected: exactly one save after the delay.
- [ ] Type, pause briefly, then type again before the delay finishes. Expected: timer resets and save happens only after the last pause.
- [ ] Leave the note idle without changes. Expected: no extra saves.
- [ ] While changes are pending, use Obsidian's current Save File shortcut. Expected: file saves immediately and the status dot returns to saved.

## Special Input Cases

- [ ] Press `Enter` repeatedly. Expected: status dot turns pending and delayed save still works; no immediate fallback autosaves.
- [ ] Press `Backspace` repeatedly. Expected: delayed save still works.
- [ ] Press `Delete` repeatedly. Expected: delayed save still works.
- [ ] Press `Space` repeatedly. Expected: delayed save still works.
- [ ] Paste text. Expected: pending state appears and save happens after the delay.
- [ ] Cut text. Expected: pending state appears and save happens after the delay.

## Multiple Windows

- [ ] Open a note in a new window and type there. Expected: same delayed-save behavior as the main window.
- [ ] Open one note in the main window and a different note in a popup window; edit both. Expected: each file saves on its own timer.
- [ ] Switch focus between windows while a save is pending. Expected: no immediate unexpected save just because focus changed.
- [ ] Close the popup window with pending edits. Expected: pending changes flush to disk before the window closes.

## Switching, Closing, Quitting

- [ ] Edit a note, then switch to another note/tab. Expected: switch does not force an immediate save; pending changes still save on timer.
- [ ] Edit a note, then close its tab. Expected: pending changes are saved.
- [ ] Edit a note, then close Obsidian normally. Expected: pending changes are saved.
- [ ] Edit a note in one Obsidian window, then focus another Obsidian window. Expected: window switch does not force an immediate save.
- [ ] Edit a note, then click into a different app before the delay finishes. Expected: switching away from Obsidian does not force a save; the configured timer still decides when the file is written.
- [ ] Disable or reload the plugin while nothing is pending. Expected: editor keeps working normally.

## Status Indicator

- [ ] Start editing. Expected: status dot changes to the pending status color soon after the first edit and tooltip says changes are pending.
- [ ] Wait for autosave to complete. Expected: status dot changes back to the saved status color and tooltip says all changes saved.
- [ ] Edit two files with pending timers. Expected: indicator stays pending until both are saved.

## Settings

- [ ] Change save delay to another valid value. Expected: next pending save uses the new delay.
- [ ] Enter values below `3` and above `3600`. Expected: setting is clamped to the allowed range.
- [ ] Enter a non-numeric delay. Expected: plugin falls back to a valid number and keeps working.
- [ ] Change saved status color and pending status color. Expected: status dot updates to the selected colors.
- [ ] Start from a fresh install or clean plugin data state. Expected: plugin loads defaults and works before any settings are changed.

## Regression Checks From Old Issues

- [ ] No case should show constant immediate saves while typing in a normal note.
- [ ] No case should leave the status dot green while there are clearly unsaved edits.
- [ ] Separate-window editing must not fall back to Obsidian's default rapid autosave behavior.
- [ ] `Enter`, `Backspace`, and `Delete` must count as input for the timer.
- [ ] First edit in a note must reliably turn the status dot pending.
- [ ] Tab switch and window switch must not force save, but tab close, window close, and app quit still must save.

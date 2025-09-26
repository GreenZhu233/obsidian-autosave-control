# Obsidian Autosave Control

## What It Does

This plugin changes how often Obsidian saves files to the disk.  

Instead of saving every two seconds from start of typing (Obsidian default), this plugin makes Obsidian wait for the user to finish with editing, and after the input stops, it waits for a defined time (by default 10 seconds) and then it only saves once.

- This reduces sync conflicts with services like Dropbox, Google Drive, or Git.  
- It makes working with large files or network drives smoother.
- It reduces power consumption when using Obsidian on battery-powered devices.

## Key Features

- **Save Interval**: Choose how many seconds Obsidian should wait before saving after last keystroke (3–3600 seconds). Default is 10 seconds.
- **Smart Handling**:
  - Keeps edits in memory and saves them after the chosen interval when you stop editing a file.
  - Files are saved automatically when you switch, close, or quit Obsidian.
  - Files can be saved regardless of timer using the default Save file shortcut.
- **Status Icon**: A dot in the status bar shows save status:  
  - **Blue** → changes pending
  - **Green** → all saved
  - Color picker included for personalized status icon colors!

## Installation

1. **Download** the latest release from [GitHub Releases](https://github.com/mihasm/obsidian-autosave-control/releases).  
2. **Extract** the `.zip` file.  
3. Copy the files into:
your-vault/.obsidian/plugins/autosave-control

4. In Obsidian, go to **Settings > Community plugins**, turn off **Safe mode** if needed, and **enable** the plugin.  

## Usage

Once enabled, the plugin works automatically:

- Just edit your notes as usual.  
- The plugin waits until you pause typing, then saves.  
- You can check the status dot in the bar (blue = waiting, green = saved).
- Change the save interval under **Settings > Obsidian Autosave Control**.  

## Important Notes

- Unsaved changes are kept in memory during the wait. If Obsidian or your computer crashes, those pending edits may be lost.  
- Choose a save interval that balances fewer saves with your comfort level.  

## Development

If you’d like to build or modify the plugin:

```bash
git clone https://github.com/mihasm/obsidian-autosave-control.git
cd obsidian-autosave-control
npm install
npm run build
```

Then link or copy the build into your vault’s .obsidian/plugins/ folder.

## License

MIT License. See LICENSE.

⸻

Tip: Always keep backups of your vault, no matter which plugins you use.

# Obsidian Autosave Control

## What It Does

This plugin delays Obsidian's automatic disk writes until editing has stopped for a chosen amount of time.

Instead of repeatedly saving during an active editing burst, the plugin records edit activity, waits for you to pause, and then performs one save after the configured delay. The default delay is 10 seconds.

- This reduces sync conflicts with services like Dropbox, Google Drive, or Git.  
- It makes working with large files or network drives smoother.
- It reduces power consumption when using Obsidian on battery-powered devices.

## Key Features

- **Save Delay**: Choose how many seconds Obsidian should wait after editing stops before saving (3-3600 seconds). Default is 10 seconds.
- **Edit-Aware Saving**:
  - Tracks edit activity and schedules a delayed save instead of saving on every Obsidian autosave tick.
  - Flushes pending saves when you switch, close, or quit Obsidian.
  - Still allows an immediate save when Obsidian performs a normal save outside the edit burst.
- **Status Icon**: A dot in the status bar shows save state:
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
- The plugin waits until you pause editing, then saves after the configured delay.
- You can check the status dot in the bar (blue = waiting, green = saved).
- Change the save delay under **Settings > Obsidian Autosave Control**.

## Important Notes

- Unsaved changes are kept in memory during the wait. If Obsidian or your computer crashes, those pending edits may be lost.
- Choose a save delay that balances fewer writes with your comfort level.

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

# Changelog

## 0.2.0 (unreleased)

- The first time it runs on a Steam Deck, DiscordDeck picks a controller layout for Discord: Steam's Web Browser layout, with the Menu button opening Discord's quick switcher (Ctrl+K) instead of hiding Discord, A pressing only Enter and Y going only Forward. A layout you picked for Discord yourself stays.
- The Quick Access menu has a new **Controller buttons** list showing what each button does in Discord. From there you can edit the layout in Steam, or switch back to DiscordDeck's layout.
- Steam's controller settings for Discord show the layout's name. Before, it was blank.

## 0.1.4 (2026-10-18)

- Position in Steam menu now lists a number for every spot among the entries you can see, counting other plugins' entries and leaving out entries a theme hides.
- If another plugin asks for the same spot, it keeps it and Discord goes right below.

### Fixes

- Pressing the Steam button or the ... button while Discord is on screen no longer freezes Steam. Discord now steps aside before the menu opens instead of right after.
- CSS Loader themes that hide Steam menu entries (such as Main Menu Hide Tabs) hide the right entries again, wherever Discord sits in the menu.
- After the plugin is reloaded or updated, Discord shows up once in the Steam menu, at its saved position.

## 0.1.3 (2026-10-17)

- The Quick Access menu now mentions under the Close button that you can also close Discord by highlighting it in the Steam menu and pressing X.

## 0.1.2 (2026-10-17)

### Fixes

- The D-pad works on Steam's keyboard every time after Steam + X. Before, it sometimes couldn't move between keys.
- Leaving or reloading the plugin no longer leaves a background process running on the Steam Machine.

## 0.1.1 (2026-10-16)

- Discord's icon in the Steam menu turns light blue while Discord is running, instead of glowing. The glow setting in the Quick Access menu is gone.

### Fixes

- Steam no longer freezes when you press the Steam button while Discord is on screen.

## 0.1.0 (2026-10-16)

- Adds Discord to the Steam menu. Picking it opens the official Discord app or Vesktop (Discord with Vencord) installed from Discover, and starts it first if it isn't running.
- Discord no longer needs to be added as a non-Steam game, and doesn't take up a running game slot.
- Discord keeps running in the background after you leave it with the Steam button, so you stay in voice chat while you play.
- The Steam menu and Quick Access menu open over Discord, so you can get back to Steam at any time.
- Type messages with Steam's keyboard: press Steam + X while Discord is open, type in the message box, and press Enter to send it. Turn off sending in the Quick Access menu to only put the text into Discord's text field.
- Discord's icon in the Steam menu lights up while Discord is running. Set how brightly it glows, or turn it off, in the Quick Access menu.
- Close Discord by pressing X on its Steam menu entry, or with the Close button in the Quick Access menu.
- Choose which app to open, Discord or Vesktop, and where Discord sits in the Steam menu, from the Quick Access menu.

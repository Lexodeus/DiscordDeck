# DiscordDeck

Adds **Discord** to the Steam menu in Gaming Mode. It opens the official Discord flatpak (`com.discordapp.Discord`) or [Vesktop](https://github.com/Vencord/Vesktop) (Discord with Vencord, `dev.vencord.Vesktop`), installed from Discover in Desktop Mode, without adding it to your library as a non-Steam game.

![The Discord entry in the Steam menu, and DiscordDeck's Quick Access settings](assets/screenshot.png)

- Pick **Discord** in the Steam menu to open it. It starts the app first if it isn't running yet.
- Press the Steam button and pick anything else to go back to Steam. Discord keeps running in the background, so you stay in voice chat.
- Press Steam + X while Discord is open to type a message with Steam's keyboard. Press Enter or Send and it's typed into the text field selected in Discord, usually the message box of the open channel.
- Highlight Discord in the Steam menu and press X to close it, or use the Close button in the Quick Access menu.
- The Quick Access menu also sets where Discord sits in the Steam menu, whether messages typed with Steam + X are sent right away or only put into the text field, and which flatpak to open: Discord or Vesktop.

## How it works

Gaming Mode's compositor (gamescope) only shows windows that belong to an app Steam launched. The plugin's backend starts Discord in your user session and tags its window with a placeholder app ID. While Steam is on the plugin's Discord page, the backend asks gamescope to show that window. When Steam navigates away, or brings a game to the front, it hands the screen back to Steam.

Steam's on-screen keyboard only types into Steam's own UI, so the plugin shows a message box on Steam's page instead and types the text into Discord with `xdotool`.

## Requirements

- Decky Loader 3 or newer
- Discord (Flathub `com.discordapp.Discord`) or Vesktop (Flathub `dev.vencord.Vesktop`) installed from Discover

## Credits

The Steam menu patch is adapted from [DeckWebBrowser](https://github.com/jessebofill/DeckWebBrowser) by Jesse Bofill (GPL-3.0).

## License

GPL-3.0

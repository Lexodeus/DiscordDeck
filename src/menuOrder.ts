/**
 * Shared ordering for plugin entries in the Steam menu, kept identical across Lexodeus' menu plugins
 * (SpotifyDeck, DiscordDeck, DeckWebBrowser). Each plugin marks its entry with a numeric `menuPosition`
 * prop and calls placePositionedMenuItems after inserting it. Whichever plugin patches the menu last
 * then places every marked entry, so the order doesn't depend on the order Decky loads the plugins in.
 */

// Running game entries route to the game's page, e.g. /library/app/<appid>
function isRunningAppRoute(route: unknown) {
  return typeof route === "string" && /\/\d+(\/|$)/.test(route);
}

/**
 * A visible entry in the menu. Friends & Chat and Power have an action instead of a route, but still
 * count, so positions match what's on screen (and themes that hide entries by position stay correct).
 */
export function isMenuEntry(e: any) {
  return (
    !!e?.props?.label &&
    !!(e.props.onFocus || e.props.onGamepadFocus) &&
    !!(e.props.route || e.props.action) &&
    !isRunningAppRoute(e.props.route)
  );
}

const isPositioned = (e: any) => typeof e?.props?.menuPosition === "number";

/** Moves every marked entry to its position: 1 is the first entry, anything past the end goes last. */
export function placePositionedMenuItems(items: any[]) {
  const positioned = items.filter(isPositioned);
  for (const item of positioned) items.splice(items.indexOf(item), 1);
  positioned.sort((a, b) => a.props.menuPosition - b.props.menuPosition);
  for (const item of positioned) {
    const entries = items.flatMap((e, index) => (isMenuEntry(e) ? index : []));
    const position = Math.max(item.props.menuPosition, 1);
    const index =
      position <= entries.length ? entries[position - 1] : entries.length ? entries[entries.length - 1] + 1 : items.length;
    items.splice(index, 0, item);
  }
}

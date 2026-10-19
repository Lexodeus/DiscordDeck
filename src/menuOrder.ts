/**
 * Shared ordering for plugin entries in the Steam menu, kept identical across Lexodeus' menu plugins
 * (SpotifyDeck, DiscordDeck, DeckWebBrowser). Each plugin marks its entry with a numeric `menuPosition`
 * prop and calls placePositionedMenuItems after inserting it. Whichever plugin patches the menu last
 * then places every marked entry, so the order doesn't depend on the order Decky loads the plugins in.
 */

import { createElement } from "react";

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

const TRAILING_GROUP_KEY = "menu-plugins-trailing";
const isTrailingGroup = (e: any) => e?.key === TRAILING_GROUP_KEY;

/**
 * Moves every marked entry to its position: 1 is the first entry, anything past the end goes last.
 *
 * `siblings` is the children array that holds `items`. After the entries Steam renders a shadow strip there, so the
 * menu ends with one element after Steam's last entry. Themes hide entries with selectors like `:nth-last-child(6)`
 * (counting from the end, since Steam adds running games at the top), so an entry after Steam's last one would hide
 * the wrong entry. Entries there are grouped with the shadow strip in one element that takes no space
 * (display: contents), which keeps the count.
 */
export function placePositionedMenuItems(items: any[], siblings?: any[]) {
  // Undo the grouping from an earlier pass (another plugin's copy of this code)
  let trailingSiblings: any[] = [];
  const group = items.find(isTrailingGroup);
  if (group) {
    items.splice(items.indexOf(group), 1);
    const [entries, rest] = group.props.children;
    items.push(...entries);
    trailingSiblings = rest;
  } else if (siblings?.includes(items)) {
    trailingSiblings = siblings.splice(siblings.indexOf(items) + 1);
  }

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

  if (!trailingSiblings.length) return;
  let lastSteamEntry = -1;
  items.forEach((e, index) => {
    if (isMenuEntry(e) && !isPositioned(e)) lastSteamEntry = index;
  });
  const trailing = items.splice(lastSteamEntry + 1);
  items.push(createElement("div", { key: TRAILING_GROUP_KEY, style: { display: "contents" } }, trailing, trailingSiblings));
}

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


const GROUP_KEY_PREFIX = "menu-plugins-group:";
const END_GROUP_KEY = `${GROUP_KEY_PREFIX}end`;
const isGroup = (e: any) => typeof e?.key === "string" && e.key.startsWith(GROUP_KEY_PREFIX);
const rendersNothing = (e: any) => e == null || typeof e === "boolean";

/**
 * Themes hide entries by position, e.g. `:nth-last-child(6) [role=menuitem]` (counting from the end, since Steam adds
 * running games at the top). An extra element in the menu shifts those counts and the wrong entry gets hidden. So each
 * run of plugin entries is grouped with the element after it (the next Steam entry, or the shadow strip Steam renders
 * after its last entry) in one element that takes no space (display: contents). The group takes that element's place,
 * and the counts stay as they are without plugins, from either end.
 *
 * A theme rule for that element now also matches the plugin entries in its group, so they force themselves visible.
 */
function group(key: string, entries: any[], followers: any[]) {
  const keepVisible = (el: HTMLElement | null) => {
    if (!el) return;
    // Each entry renders one element; the followers come after them
    for (const child of Array.from(el.children).slice(0, entries.length)) {
      for (const item of Array.from(child.querySelectorAll<HTMLElement>("[role=menuitem]"))) {
        item.style.setProperty("display", "flex", "important");
      }
    }
  };
  return createElement("div", { key, ref: keepVisible, style: { display: "contents" } }, entries, followers);
}

/**
 * Moves every marked entry to its position: 1 is the first entry, anything past the end goes last. Then groups the
 * entries as described above.
 *
 * `siblings` is the children array that holds `items`, where Steam renders the shadow strip after the entries.
 */
export function placePositionedMenuItems(items: any[], siblings?: any[]) {
  // Undo the grouping from an earlier pass (another plugin's copy of this code)
  let endFollowers: any[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (!isGroup(items[i])) continue;
    const [entries, followers] = items[i].props.children;
    if (items[i].key === END_GROUP_KEY) {
      items.splice(i, 1, ...entries);
      endFollowers = followers;
    } else {
      items.splice(i, 1, ...entries, ...followers);
    }
  }
  if (!endFollowers.length && siblings?.includes(items)) {
    endFollowers = siblings.splice(siblings.indexOf(items) + 1);
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

  for (let i = 0; i < items.length; i++) {
    if (!isPositioned(items[i])) continue;
    let end = i;
    while (end < items.length && isPositioned(items[end])) end++;
    let next = end;
    while (next < items.length && rendersNothing(items[next])) next++;
    const entries = items.slice(i, end);
    if (next < items.length) {
      const followers = items.slice(end, next + 1);
      items.splice(i, next + 1 - i, group(`${GROUP_KEY_PREFIX}${items[next].key ?? next}`, entries, followers));
    } else {
      items.splice(i, end - i, group(END_GROUP_KEY, entries, endFollowers));
      endFollowers = [];
    }
  }
  // Nothing placed last: put the shadow strip back after the entries
  if (endFollowers.length) items.push(group(END_GROUP_KEY, [], endFollowers));
}

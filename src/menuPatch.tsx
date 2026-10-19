// Adapted from DeckWebBrowser's menu patch (GPL-3.0, Jesse Bofill)
import { afterPatch, findInReactTree, getReactRoot } from "@decky/ui";
import { FC, ReactElement, ReactNode } from "react";
import { FaDiscord } from "react-icons/fa";
import { closeDiscord, settings, useDiscordState } from "./backend";
import { hasMenuItem, isMenuEntry, placePositionedMenuItems } from "./menuOrder";
import { routePath } from "./routes";

interface MainMenuItemProps {
  route: string;
  label: ReactNode;
  onFocus?: () => void;
  onGamepadFocus?: () => void;
  icon?: ReactElement;
  children?: ReactNode;
  onSecondaryButton?: () => void;
  onSecondaryActionDescription?: ReactNode;
}

const log = (...args: unknown[]) => console.log("[DiscordDeck] Menu patch:", ...args);

export function patchMenu() {
  const reactTree = getReactRoot(document.getElementById("root") as HTMLElement);
  const menuNode = findInReactTree(reactTree, (node) => node?.memoizedProps?.navID == "MainNavMenuContainer");
  if (!menuNode || !menuNode.return?.type) {
    log("Failed to find main menu root node.");
    return () => {};
  }
  const orig = menuNode.return.type;
  let patchedInnerMenu: any;
  let unpatched = false;
  const menuWrapper = (props: any) => {
    const ret = orig(props);
    if (unpatched) return ret;
    if (!ret?.props?.children?.props?.children?.[0]?.type) {
      log("The main menu element could not be found at the expected location. Valve may have changed it.");
      return ret;
    }
    if (patchedInnerMenu) {
      ret.props.children.props.children[0].type = patchedInnerMenu;
    } else {
      afterPatch(ret.props.children.props.children[0], "type", (_: any, ret: any) => {
        // Decky can't remove this patch when the plugin unloads (other patches may wrap it), so after a reload it
        // stays in place next to the new instance's patch. Only the new instance adds Discord.
        if (unpatched) return ret;
        const isMenuItemElt = (e: any) =>
          e?.props?.label && (e.props.onFocus || e.props.onGamepadFocus) && e.props.route && e.type?.toString;
        const menuItems = findInReactTree(ret, (node) => Array.isArray(node) && node.some(isMenuItemElt)) as any[];
        if (!menuItems) {
          log("Could not find menu items to patch.");
          return ret;
        }
        if (!hasMenuItem(menuItems, "discord")) {
          // Steam's own entries with a route (not running games) render with the component to copy
          const menuItem = menuItems.find((e) => isMenuItemElt(e) && isMenuEntry(e)) as
            | { props: MainMenuItemProps; type: FC<MainMenuItemProps> }
            | undefined;
          if (!menuItem) {
            log("Could not find a menu item to copy.");
            return ret;
          }
          menuItems.push(
            <DiscordMenuItem
              key="discord"
              route={routePath}
              label="Discord"
              menuPosition={settings.menuPosition}
              menuYieldsOnTie
              onFocus={menuItem.props.onFocus}
              onGamepadFocus={menuItem.props.onGamepadFocus}
              useIconAsProp={!!menuItem.props.icon}
              MenuItemComponent={menuItem.type}
            />
          );
        }
        const siblings = findInReactTree(ret, (node) => Array.isArray(node) && node.includes(menuItems)) as any[];
        placePositionedMenuItems(menuItems, siblings);

        return ret;
      });
      patchedInnerMenu = ret.props.children.props.children[0].type;
    }
    return ret;
  };
  menuNode.return.type = menuWrapper;
  if (menuNode.return.alternate) {
    menuNode.return.alternate.type = menuNode.return.type;
  }

  return () => {
    unpatched = true;
    // Another plugin may have wrapped the menu after us. Restoring orig would drop its wrapper too,
    // so then our wrapper stays in the chain and just passes through.
    if (menuNode.return.type !== menuWrapper) return;
    menuNode.return.type = orig;
    if (menuNode.return.alternate) {
      menuNode.return.alternate.type = menuNode.return.type;
    }
  };
}

export interface MenuEntryInfo {
  /** Its position as menuPosition counts it: every entry in the menu other than Discord, from 1 */
  position: number;
  /** False when a theme hides it */
  visible: boolean;
}

// The menu's entries and grouping divs are plain children of this element (see menuOrder.ts)
function findEntriesElementFiber(fiber: any, depth = 0): any {
  for (let f = fiber; f && depth < 12; f = f.sibling) {
    const children = f.memoizedProps?.children;
    if (typeof f.type === "string" && Array.isArray(children) && Array.isArray(children[0])) return f;
    const found = findEntriesElementFiber(f.child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The Steam menu's entries as last rendered, with whether each is visible. Read from the rendered menu, so it
 * includes other plugins' entries and reflects theme hiding. Undefined if the menu can't be read.
 */
export function readMenuEntries(): MenuEntryInfo[] | undefined {
  try {
    const reactTree = getReactRoot(document.getElementById("root") as HTMLElement);
    const menuNode = findInReactTree(reactTree, (node) => node?.memoizedProps?.navID == "MainNavMenuContainer");
    const fiber = findEntriesElementFiber(menuNode?.child);
    const element = fiber?.stateNode as HTMLElement | undefined;
    if (!element) return undefined;

    // Elements in render order, with the plugin groups opened up
    const flatten = (nodes: any[]): any[] =>
      nodes.flatMap((e) =>
        Array.isArray(e) ? flatten(e) : typeof e?.key === "string" && e.key.startsWith("menu-plugins-group:") ? flatten(e.props.children) : [e]
      );
    const rendered = flatten(fiber.memoizedProps.children).filter(
      (e) => e?.props?.label && (e.props.onFocus || e.props.onGamepadFocus)
    );
    const items = Array.from(element.querySelectorAll<HTMLElement>("[role=menuitem]"));
    if (items.length !== rendered.length) return undefined;

    const view = element.ownerDocument.defaultView ?? window;
    const entries: MenuEntryInfo[] = [];
    rendered.forEach((e, index) => {
      if (!isMenuEntry(e) || e.key === "discord") return;
      entries.push({
        position: entries.length + 1,
        visible: view.getComputedStyle(items[index]).display !== "none",
      });
    });
    return entries;
  } catch (e) {
    log("Couldn't read the menu's entries:", e);
    return undefined;
  }
}

interface DiscordMenuItemProps extends MainMenuItemProps {
  menuPosition: number;
  menuYieldsOnTie: boolean;
  MenuItemComponent: FC<MainMenuItemProps>;
  useIconAsProp: boolean;
}

const DiscordMenuItem: FC<DiscordMenuItemProps> = ({
  MenuItemComponent,
  useIconAsProp,
  menuPosition: _position,
  menuYieldsOnTie: _yields,
  ...props
}) => {
  const { running, appName } = useDiscordState();
  // While it's running: a light blurple mixed 70/30 with the menu's icon grey
  const icon = <FaDiscord style={running ? { color: "#abb1ec" } : {}} />;

  return (
    <MenuItemComponent
      {...props}
      {...(useIconAsProp ? { icon } : { children: icon })}
      onSecondaryActionDescription={running ? `Close ${appName ?? "Discord"}` : ""}
      onSecondaryButton={running ? () => closeDiscord() : undefined}
    />
  );
};

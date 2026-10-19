// Adapted from DeckWebBrowser's menu patch (GPL-3.0, Jesse Bofill)
import { afterPatch, findInReactTree, getReactRoot } from "@decky/ui";
import { FC, ReactElement, ReactNode } from "react";
import { FaDiscord } from "react-icons/fa";
import { closeDiscord, settings, useDiscordState } from "./backend";
import { isMenuEntry, placePositionedMenuItems } from "./menuOrder";
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
        const isMenuItemElt = (e: any) =>
          e?.props?.label && (e.props.onFocus || e.props.onGamepadFocus) && e.props.route && e.type?.toString;
        const menuItems = findInReactTree(ret, (node) => Array.isArray(node) && node.some(isMenuItemElt)) as any[];
        if (!menuItems) {
          log("Could not find menu items to patch.");
          return ret;
        }
        if (!menuItems.some((item) => item?.key === "discord")) {
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

interface DiscordMenuItemProps extends MainMenuItemProps {
  menuPosition: number;
  MenuItemComponent: FC<MainMenuItemProps>;
  useIconAsProp: boolean;
}

const DiscordMenuItem: FC<DiscordMenuItemProps> = ({ MenuItemComponent, useIconAsProp, menuPosition: _, ...props }) => {
  const { running, appName } = useDiscordState();
  // A light blurple mixed 70/30 with the menu's icon grey. No CSS filter (e.g. a drop-shadow glow): on menu icons
  // it freezes Steam's UI when the menu opens as Discord steps aside.
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

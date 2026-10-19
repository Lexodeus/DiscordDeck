import { definePlugin, routerHook } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, staticClasses, ToggleField } from "@decky/ui";
import { useState } from "react";
import { FaDiscord } from "react-icons/fa";
import {
  closeDiscord,
  DiscordApp,
  LAST_MENU_POSITION,
  listenForState,
  loadSettings,
  setApp,
  setMenuPosition,
  setPressEnter,
  settings,
  useDiscordState,
} from "./backend";
import { patchMenu, readMenuEntries } from "./menuPatch";
import { DiscordPage, routePath, watchNavigation } from "./routes";

/**
 * One option per spot among the entries you can see in the Steam menu, numbered from the top. Entries a theme hides
 * are skipped: Discord goes above the next visible entry either way. If another plugin using the shared menuOrder.ts
 * asks for the same spot, it goes first and Discord goes right below.
 */
function menuPositionOptions() {
  const entries = readMenuEntries()?.filter((entry) => entry.visible);
  if (!entries?.length) {
    // The menu couldn't be read: plain numbers for Steam's 8 entries
    return [
      ...Array.from({ length: 8 }, (_, i) => ({ data: i + 1, label: `${i + 1}` })),
      { data: LAST_MENU_POSITION, label: "9" },
    ];
  }
  return [
    ...entries.map((entry, i) => ({ data: entry.position, label: `${i + 1}` })),
    { data: LAST_MENU_POSITION, label: `${entries.length + 1}` },
  ];
}

// Same order as the backend's APPS
const appLabels: Record<DiscordApp, string> = { discord: "Discord", vesktop: "Vesktop" };

function Content() {
  const { installed, app, appName, running, launching } = useDiscordState();
  const [menuPosition, setMenuPositionState] = useState(settings.menuPosition);
  const [pressEnter, setPressEnterState] = useState(settings.pressEnter);
  // Read when the panel opens, so it matches the menu as it is now
  const [options] = useState(menuPositionOptions);
  // A saved position above a hidden entry shows as the next visible spot, where Discord actually appears
  const selected = options.find((option) => option.data >= menuPosition) ?? options[options.length - 1];

  let status = "Not running";
  if (!app || !installed.includes(app)) status = "Not installed. Install it from Discover in Desktop Mode.";
  else if (launching) status = "Starting…";
  else if (running) status = "Running";

  return (
    <PanelSection>
      <PanelSectionRow>
        <div>
          {appName ?? "Discord"}: {status}
        </div>
      </PanelSectionRow>
      {running && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description="You can also close it by highlighting Discord in the Steam menu and pressing X."
            onClick={() => closeDiscord()}
          >
            Close {appName}
          </ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <DropdownItem
          label="Flatpak"
          rgOptions={(Object.keys(appLabels) as DiscordApp[]).map((key) => ({
            data: key,
            label: installed.includes(key) ? appLabels[key] : `${appLabels[key]} (not installed)`,
          }))}
          selectedOption={app}
          onChange={(option) => setApp(option.data)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Send messages typed with Steam + X"
          description="On: your message is sent right away. Off: the text is only put into Discord's text field, so you can add to it or use it in a search box."
          checked={pressEnter}
          onChange={(checked) => {
            setPressEnterState(checked);
            setPressEnter(checked);
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label="Position in Steam menu"
          rgOptions={options}
          selectedOption={selected.data}
          onChange={(option) => {
            setMenuPositionState(option.data);
            setMenuPosition(option.data);
          }}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  const stopListeningForState = listenForState();
  routerHook.addRoute(routePath, DiscordPage, { exact: true });
  // Add Discord to the Steam menu once its saved position is known. Right after a reload or update the backend
  // takes a few seconds to answer, and until then the menu would show Discord last.
  let unloaded = false;
  let unpatchMenu = () => {};
  loadSettings()
    .catch((e) => console.error("[DiscordDeck] Couldn't load settings, using the defaults:", e))
    .finally(() => {
      if (!unloaded) unpatchMenu = patchMenu();
    });
  const stopWatchingNavigation = watchNavigation();

  return {
    name: "DiscordDeck",
    titleView: <div className={staticClasses.Title}>DiscordDeck</div>,
    content: <Content />,
    icon: <FaDiscord />,
    onDismount() {
      stopWatchingNavigation();
      unloaded = true;
      unpatchMenu();
      routerHook.removeRoute(routePath);
      stopListeningForState();
    },
  };
});

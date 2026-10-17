import { definePlugin, routerHook } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, staticClasses, ToggleField } from "@decky/ui";
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
  setIndicatorBrightness,
  setPressEnter,
  settings,
  useDiscordState,
  useIndicatorBrightness,
} from "./backend";
import { patchMenu } from "./menuPatch";
import { DiscordPage, routePath, watchNavigation } from "./routes";

const menuPositionOptions = [
  ...Array.from({ length: 8 }, (_, i) => ({ data: i + 1, label: `${i + 1}` })),
  { data: LAST_MENU_POSITION, label: "Last" },
];

// Same order as the backend's APPS
const appLabels: Record<DiscordApp, string> = { discord: "Discord", vesktop: "Vesktop (Vencord)" };

function Content() {
  const { installed, app, appName, running, launching } = useDiscordState();
  const [menuPosition, setMenuPositionState] = useState(settings.menuPosition);
  const [pressEnter, setPressEnterState] = useState(settings.pressEnter);
  const brightness = useIndicatorBrightness();

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
          <ButtonItem layout="below" onClick={() => closeDiscord()}>
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
        <SliderField
          label="Menu icon glow"
          description="How brightly Discord's icon lights up in the Steam menu while it's running. 0 turns it off."
          value={brightness}
          min={0}
          max={100}
          step={10}
          showValue
          valueSuffix="%"
          onChange={(value) => setIndicatorBrightness(value)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label="Position in Steam menu"
          rgOptions={menuPositionOptions}
          selectedOption={menuPosition}
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
  loadSettings();
  const stopListeningForState = listenForState();
  routerHook.addRoute(routePath, DiscordPage, { exact: true });
  const unpatchMenu = patchMenu();
  const stopWatchingNavigation = watchNavigation();

  return {
    name: "DiscordDeck",
    titleView: <div className={staticClasses.Title}>DiscordDeck</div>,
    content: <Content />,
    icon: <FaDiscord />,
    onDismount() {
      stopWatchingNavigation();
      unpatchMenu();
      routerHook.removeRoute(routePath);
      stopListeningForState();
    },
  };
});

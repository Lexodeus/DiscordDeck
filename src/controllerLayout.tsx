import { ConfirmModal, DialogButton, Focusable, ModalRoot, Navigation, Router, showModal } from "@decky/ui";
import { FC, useEffect, useState } from "react";
import { addLayoutController, prepareLayout, settings } from "./backend";

/**
 * Steam Input treats Discord's window as an app of its own (the placeholder ID the backend gives it, without its top
 * byte) and loads a controller layout for it. Left alone that's Steam's gamepad layout, which Discord ignores, so
 * DiscordDeck picks its own: Steam's Web Browser layout with a few buttons changed (see build_layout in main.py).
 */
const CONTROLLER_APP_ID = 4805443;

// Steam only has a Web Browser layout for the Steam Deck's controls (eControllerType 4)
const LAYOUT_TEMPLATES: Record<number, string> = { 4: "controller_neptune" };

interface Controller {
  nControllerIndex: number;
  eControllerType: number;
  strSerialNumber: string;
  strName?: string;
}

interface LayoutConfig {
  Title: string;
  URL: string;
}

const store = () => (window as any).controllerConfiguratorStore;

function controllers(): Controller[] {
  return store()?.m_controllerList ?? [];
}

// While Steam starts, its user is account 0 (this ID) and has no controllers yet
const NO_USER = "76561197960265728";
const steamId = (): string | undefined => {
  const id = (window as any).App?.m_CurrentUser?.strSteamID;
  return id && id !== NO_USER ? id : undefined;
};

const currentLayout = (controller: Controller): Promise<LayoutConfig> =>
  (SteamClient.Input as any).GetConfigForAppAndController(CONTROLLER_APP_ID, controller.nControllerIndex);

async function selectLayout(controller: Controller, replace: boolean) {
  const id = steamId();
  const template = LAYOUT_TEMPLATES[controller.eControllerType];
  if (!id || !template) throw new Error("This controller has no Web Browser layout to start from");
  const { url, title } = await prepareLayout(id, controller.strSerialNumber, template, replace);
  if (!url) return title;
  store().SetActiveConfigForApp(CONTROLLER_APP_ID, controller.nControllerIndex, url, false);
  console.log(`[DiscordDeck] Selected the DiscordDeck layout for controller ${controller.strSerialNumber}`);
  return null;
}

/**
 * Steam's controller settings page leaves a layout's name blank when the app has no name in Steam, which Discord's
 * placeholder app doesn't. While one of those pages is open, give it the name "Discord".
 */
export function nameDiscordForControllerSettings() {
  const detailsStore = (window as any).appDetailsStore;
  const original = detailsStore?.GetAppDetails;
  if (typeof original !== "function") {
    console.error("[DiscordDeck] Steam's app details weren't found, Steam's controller page shows no layout name.");
    return () => {};
  }
  const hadOwn = Object.prototype.hasOwnProperty.call(detailsStore, "GetAppDetails");
  const getAppDetails = function (this: any, appId: number, ...rest: any[]) {
    const details = original.call(this, appId, ...rest);
    if (details || appId != CONTROLLER_APP_ID) return details;
    const path: string | undefined = (Router.WindowStore?.GamepadUIMainWindowInstance as any)?.m_history?.location
      ?.pathname;
    return path?.includes("controllerconfigurator")
      ? { unAppID: CONTROLLER_APP_ID, strDisplayName: "Discord" }
      : details;
  };
  detailsStore.GetAppDetails = getAppDetails;
  return () => {
    // Only undo it if nothing wrapped it after this
    if (detailsStore.GetAppDetails !== getAppDetails) return;
    if (hadOwn) detailsStore.GetAppDetails = original;
    else delete detailsStore.GetAppDetails;
  };
}

let settingUp: Promise<void> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const RETRY_MS = 2000;
const MAX_RETRIES = 30;

async function setUp(retries: number) {
  if (!store() || !steamId() || controllers().length == 0) {
    // Steam is still starting: try again in a moment
    if (retries > 0) retryTimer = setTimeout(() => setUpLayouts(retries - 1), RETRY_MS);
    else console.error("[DiscordDeck] Steam's user or controllers weren't found, the controller layout wasn't set up.");
    return;
  }
  for (const controller of controllers()) {
    const serial = controller.strSerialNumber;
    if (!serial || !LAYOUT_TEMPLATES[controller.eControllerType] || settings.layoutControllers.includes(serial)) {
      continue;
    }
    try {
      const layout = await currentLayout(controller);
      if (layout?.URL?.startsWith("default://")) await selectLayout(controller, true);
      await addLayoutController(serial);
    } catch (e) {
      console.error(`[DiscordDeck] Couldn't set up the controller layout for ${serial}:`, e);
    }
  }
}

/**
 * Picks DiscordDeck's layout for each controller that has nothing picked for Discord yet. Each controller is only set
 * up once, so a layout you pick yourself later stays. Right after Steam starts it waits for Steam's user and
 * controllers.
 */
export function setUpLayouts(retries = MAX_RETRIES) {
  clearTimeout(retryTimer);
  // .finally, not try/finally: that could run before settingUp is assigned and leave it set for good
  settingUp ??= setUp(retries).finally(() => {
    settingUp = undefined;
  });
  return settingUp;
}

export function stopSettingUpLayouts() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

const shortcuts: [string, string][] = [
  ["Right trackpad or right stick", "Move the pointer. Press it down to click."],
  ["R2 / L2", "Click / right-click"],
  ["Left stick or left trackpad", "Scroll"],
  ["D-pad", "Arrow keys"],
  ["A", "Enter"],
  ["B or L1", "Back"],
  ["Y or R1", "Forward"],
  ["X", "Type a message with Steam's keyboard"],
  ["Menu (☰)", "Quick switcher (Ctrl+K): jump to a server, channel or DM by typing its name"],
  ["View (⧉)", "Escape: closes popups and menus"],
  ["L4", "Middle click"],
  ["R4", "Hold Ctrl"],
  ["Steam + X", "Type a message, with any layout"],
];

function editInSteam(close: () => void) {
  close();
  Navigation.CloseSideMenus();
  Navigation.Navigate(`/app/${CONTROLLER_APP_ID}/controllerconfigurator`);
}

const ButtonsModal: FC<{ closeModal?: () => void }> = ({ closeModal }) => {
  const close = () => closeModal?.();
  const controller = controllers().find((c) => LAYOUT_TEMPLATES[c.eControllerType]) ?? controllers()[0];
  const supported = !!controller && !!LAYOUT_TEMPLATES[controller.eControllerType];
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    if (controller) currentLayout(controller).then(setLayout, (e) => setError(String(e)));
  };
  useEffect(refresh, []);

  const ours = layout?.URL?.startsWith("autosave://") && layout.URL.endsWith(`/${controller?.strSerialNumber}.vdf`);
  const isDiscordDeck = ours && layout?.Title === "DiscordDeck";

  const useOurs = async () => {
    if (!controller) return;
    try {
      setError(null);
      // The file Steam saved for this controller holds another layout. That's the one in use when ours is true.
      const otherTitle = await selectLayout(controller, !ours);
      if (otherTitle !== null) {
        showModal(
          <ConfirmModal
            strTitle="Replace your layout?"
            strDescription={`Discord uses your layout "${otherTitle}". DiscordDeck's layout replaces it, and your changes to it are lost.`}
            strOKButtonText="Replace"
            onOK={() => selectLayout(controller, true).then(refresh, (e) => setError(String(e)))}
          />
        );
        return;
      }
      setTimeout(refresh, 500);
    } catch (e) {
      setError(String(e));
    }
  };

  let status: string;
  if (!controller) status = "No controller found.";
  else if (!layout) status = "";
  else if (isDiscordDeck) status = "Discord uses DiscordDeck's layout. If you changed it in Steam, your changes apply.";
  else status = `Discord uses another layout ("${layout.Title}"), so these buttons may do something else.`;

  return (
    <ModalRoot onCancel={close} onEscKeypress={close}>
      <div style={{ fontSize: "22px", fontWeight: "bold", marginBottom: "8px" }}>Controller buttons in Discord</div>
      {status && <div style={{ marginBottom: "12px", opacity: 0.8 }}>{status}</div>}
      {!supported && controller && (
        <div style={{ marginBottom: "12px", opacity: 0.8 }}>
          DiscordDeck's layout is only made for the Steam Deck's controls. Pick a layout for this controller in Steam.
        </div>
      )}
      <table style={{ width: "100%", borderSpacing: "0 6px", marginBottom: "12px" }}>
        <tbody>
          {shortcuts.map(([button, action]) => (
            <tr key={button}>
              <td style={{ fontWeight: "bold", paddingRight: "16px", whiteSpace: "nowrap", verticalAlign: "top" }}>
                {button}
              </td>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div style={{ color: "#ff6b6b", marginBottom: "12px" }}>{error}</div>}
      <Focusable style={{ display: "flex", gap: "12px" }} flow-children="horizontal">
        {controller && <DialogButton onClick={() => editInSteam(close)}>Edit layout in Steam</DialogButton>}
        {supported && layout && !isDiscordDeck && (
          <DialogButton onClick={useOurs}>Use DiscordDeck's layout</DialogButton>
        )}
        <DialogButton onClick={close}>Close</DialogButton>
      </Focusable>
    </ModalRoot>
  );
};

export const showButtonsModal = () => showModal(<ButtonsModal />);

import { DialogButton, Focusable, Router, TextField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";
import { FaDiscord } from "react-icons/fa";
import { hideDiscord, sendText, setSteamOverlayOpen, showDiscord, useDiscordState } from "./backend";

export const routePath = "/discord";

// Time for Steam to restore the controller config after Steam + X
const CHORD_RELEASE_DELAY_MS = 400;

interface History {
  location?: { pathname: string };
  listen(listener: (location: { pathname: string }, action: "PUSH" | "POP" | "REPLACE") => void): () => void;
}

const mainWindow = () => Router.WindowStore?.GamepadUIMainWindowInstance as any;

function isKeyboardShowing() {
  // A getter returning a subscribable value ({ m_currentValue }), not a function
  return !!mainWindow()?.m_VirtualKeyboardManager?.IsShowingVirtualKeyboard?.m_currentValue;
}

function hideKeyboard() {
  try {
    mainWindow()?.m_VirtualKeyboardManager?.SetVirtualKeyboardHidden?.();
  } catch (e) {
    console.error("[DiscordDeck] Couldn't hide Steam's keyboard:", e);
  }
}

// With no game running, Steam draws these inside its own window, which is underneath Discord
function isSteamOverlayOpen() {
  try {
    const window = mainWindow();
    return !!(window?.MenuStore?.IsAnySideMenuVisible?.() || window?.m_bShowingGlobalModal || isKeyboardShowing());
  } catch (e) {
    console.error("[DiscordDeck] Couldn't check Steam's menus:", e);
    return false;
  }
}

/**
 * Steam's keyboard can't type into Discord, so opening it on the Discord page shows a message box
 * on Steam's page instead. Discord stays out of the way until the message is sent or cancelled.
 */
let composing = false;
const composingListeners = new Set<(composing: boolean) => void>();

function setComposing(next: boolean) {
  if (composing === next) return;
  composing = next;
  composingListeners.forEach((listener) => listener(composing));
}

function useComposing() {
  const [current, setCurrent] = useState(composing);
  useEffect(() => {
    composingListeners.add(setCurrent);
    setCurrent(composing);
    return () => void composingListeners.delete(setCurrent);
  }, []);
  return current;
}

/**
 * Shows Discord while Steam is on the Discord route and hides it when Steam navigates anywhere else.
 * Steam's menu pushes the route again when Discord is picked while already on it, which re-shows it
 * after a game took the screen back.
 */
export function watchNavigation() {
  const history = mainWindow()?.m_history as History | undefined;
  if (!history?.listen) {
    console.error("[DiscordDeck] Steam's navigation history wasn't found, the Discord page can't open Discord.");
    return () => {};
  }
  let onDiscord = false;
  let overlayOpen = false;
  const stopListening = history.listen((location, action) => {
    if (location.pathname === routePath) {
      // Steam replaces the current entry to store focus state; only a real navigation should re-show Discord
      if (!onDiscord || action !== "REPLACE") showDiscord();
      onDiscord = true;
    } else if (onDiscord) {
      onDiscord = false;
      overlayOpen = false;
      setComposing(false);
      hideDiscord();
    }
  });
  // After a plugin reload Steam can still be on the Discord page, with no navigation to tell us
  if (history.location?.pathname === routePath) {
    onDiscord = true;
    showDiscord();
  }
  // Steam + X is sent to the focused app's in-game overlay, which Discord doesn't have, so Steam shows nothing.
  // Open the message box instead. The message comes as the Steam button is released, when Steam also puts back
  // Discord's controller config. Stepping aside before that lands leaves the controller on the game config, and
  // the D-pad doesn't reach Steam's keyboard.
  let keyboardRequests: { unregister(): void } | undefined;
  let composeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    keyboardRequests = (SteamClient.Input as any).RegisterForUserKeyboardMessages(() => {
      if (!onDiscord) return;
      clearTimeout(composeTimer);
      composeTimer = setTimeout(() => {
        if (onDiscord) setComposing(true);
      }, CHORD_RELEASE_DELAY_MS);
    });
  } catch (e) {
    console.error("[DiscordDeck] Couldn't listen for Steam + X:", e);
  }
  // Step aside before Steam's menu or Quick Access menu opens, not after. Opening a side menu while Discord is
  // still in front and then handing the screen back can hang Steam's UI (seen with the physical Steam button).
  // Every way of opening them (Steam button, ... button, ToggleSideMenu, OpenMainMenu) goes through OpenSideMenu.
  const menuStore = mainWindow()?.MenuStore;
  const originalOpenSideMenu = menuStore?.OpenSideMenu;
  const hadOwnOpenSideMenu = !!menuStore && Object.prototype.hasOwnProperty.call(menuStore, "OpenSideMenu");
  // Until then the 100 ms check below must not bring Discord back just because the menu isn't drawn yet
  let menuOpeningUntil = 0;
  const openSideMenu = function (this: any, ...args: any[]) {
    // 0 means no side menu, i.e. closing
    if (!onDiscord || overlayOpen || !args[0]) return originalOpenSideMenu.apply(this, args);
    console.log("[DiscordDeck] Stepping aside before Steam's side menu opens");
    overlayOpen = true;
    menuOpeningUntil = Date.now() + 1500;
    const steppedAside = setSteamOverlayOpen(true).catch((e) =>
      console.error("[DiscordDeck] Couldn't step aside for Steam's menu:", e)
    );
    // Open the menu once Discord stepped aside, or after half a second if the backend doesn't answer
    Promise.race([steppedAside, new Promise((resolve) => setTimeout(resolve, 500))]).then(() =>
      originalOpenSideMenu.apply(this, args)
    );
  };
  if (typeof originalOpenSideMenu === "function") menuStore.OpenSideMenu = openSideMenu;
  else console.error("[DiscordDeck] Steam's MenuStore.OpenSideMenu wasn't found, menus open over Discord first.");

  const overlayTimer = setInterval(() => {
    if (!onDiscord) return;
    if (isKeyboardShowing()) setComposing(true);
    const open = composing || isSteamOverlayOpen();
    if (open) menuOpeningUntil = 0;
    else if (Date.now() < menuOpeningUntil) return;
    if (open !== overlayOpen) {
      overlayOpen = open;
      setSteamOverlayOpen(open);
    }
  }, 100);
  return () => {
    stopListening();
    keyboardRequests?.unregister();
    clearTimeout(composeTimer);
    clearInterval(overlayTimer);
    setComposing(false);
    // If another plugin wrapped OpenSideMenu after this one, this wrapper stays in its chain. With onDiscord false it
    // just passes calls on instead of waiting on this unloaded backend.
    onDiscord = false;
    // Only undo the wrap if nothing wrapped it after this
    if (menuStore?.OpenSideMenu === openSideMenu) {
      if (hadOwnOpenSideMenu) menuStore.OpenSideMenu = originalOpenSideMenu;
      else delete menuStore.OpenSideMenu;
    }
  };
}

const MessageBox: FC<{ appName: string }> = ({ appName }) => {
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  // Open Steam's keyboard on the text field, the way selecting it with A would
  useEffect(() => {
    const timer = setTimeout(() => {
      const input = boxRef.current?.querySelector("input");
      if (!input || isKeyboardShowing()) return;
      input.focus();
      input.click();
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  const finish = (send: boolean) => {
    if (send && text.trim()) sendText(text);
    setText("");
    hideKeyboard();
    setComposing(false);
  };

  return (
    <div ref={boxRef} style={{ width: "100%", maxWidth: "720px" }}>
      <Focusable
        style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        onCancel={(e) => {
          e.stopPropagation();
          finish(false);
        }}
        onCancelActionDescription="Back to Discord"
      >
        <div style={{ fontSize: "16px", opacity: 0.8 }}>
          Goes into the text field selected in {appName}, usually the message box of the open channel.
        </div>
        <TextField
          focusOnMount
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            }
          }}
        />
        <Focusable style={{ display: "flex", gap: "12px" }} flow-children="horizontal">
          <DialogButton disabled={!text.trim()} onClick={() => finish(true)}>
            Send
          </DialogButton>
          <DialogButton onClick={() => finish(false)}>Cancel</DialogButton>
        </Focusable>
      </Focusable>
    </div>
  );
};

/** Steam's page behind Discord. It's seen while Discord starts, while typing a message, or when something went wrong. */
export const DiscordPage: FC = () => {
  const { installed, app, appName, running, launching, error } = useDiscordState();
  const isComposing = useComposing();
  const name = appName ?? "Discord";

  let message = `Press the Steam button to go back to Steam. ${name} keeps running in the background.`;
  if (!app) message = "Neither Discord nor Vesktop is installed. Install one from Discover in Desktop Mode.";
  else if (!installed.includes(app)) message = `${name} isn't installed. Install it from Discover in Desktop Mode, or pick another app in DiscordDeck's settings.`;
  else if (error) message = error;
  else if (launching) message = `Starting ${name}…`;
  else if (!running) message = `${name} is closed. Pick Discord in the Steam menu to open it again.`;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "16px",
        padding: "0 16px",
        textAlign: "center",
        background: "#313338",
      }}
    >
      <FaDiscord size="64px" color="#5865f2" />
      {isComposing && running ? <MessageBox appName={name} /> : <div style={{ fontSize: "18px", maxWidth: "560px" }}>{message}</div>}
    </div>
  );
};

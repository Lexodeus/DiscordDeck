import { addEventListener, callable, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";

export type DiscordApp = "discord" | "vesktop";

export interface DiscordState {
  installed: DiscordApp[];
  app: DiscordApp | null;
  appName: string | null;
  running: boolean;
  launching: boolean;
  shown: boolean;
  error: string | null;
}

export const showDiscord = callable<[], void>("show");
export const hideDiscord = callable<[], void>("hide");
export const closeDiscord = callable<[], void>("close");
export const setSteamOverlayOpen = callable<[isOpen: boolean], void>("set_steam_overlay_open");
const sendTextCall = callable<[text: string, pressEnter: boolean], void>("send_text");
const getState = callable<[], DiscordState>("get_state");
const getSetting = callable<[key: string, fallback: unknown], any>("get_setting");
const setSetting = callable<[key: string, value: unknown], void>("set_setting");

let state: DiscordState = {
  installed: ["vesktop"],
  app: "vesktop",
  appName: "Vesktop",
  running: false,
  launching: false,
  shown: false,
  error: null,
};
const stateListeners = new Set<(state: DiscordState) => void>();

function setState(next: DiscordState) {
  state = next;
  stateListeners.forEach((listener) => listener(state));
}

export const refreshState = () => getState().then(setState);

export function listenForState() {
  const listener = addEventListener<[DiscordState]>("state", setState);
  refreshState();
  return () => removeEventListener("state", listener);
}

export function useDiscordState() {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    stateListeners.add(setCurrent);
    refreshState();
    return () => void stateListeners.delete(setCurrent);
  }, []);
  return current;
}

// Position 1 puts Discord first in the Steam menu, LAST_MENU_POSITION after the last entry
export const LAST_MENU_POSITION = 99;

export const settings = {
  menuPosition: LAST_MENU_POSITION,
  app: null as DiscordApp | null,
  pressEnter: true,
  // How brightly the Steam menu icon lights up while Discord runs, 0-100
  indicatorBrightness: 50,
};

export async function loadSettings() {
  settings.menuPosition = await getSetting("menuPosition", LAST_MENU_POSITION);
  settings.app = await getSetting("app", null);
  settings.pressEnter = await getSetting("pressEnter", true);
  settings.indicatorBrightness = await getSetting("indicatorBrightness", 50);
  brightnessListeners.forEach((listener) => listener(settings.indicatorBrightness));
}

export async function setMenuPosition(position: number) {
  settings.menuPosition = position;
  await setSetting("menuPosition", position);
}

export async function setApp(app: DiscordApp) {
  settings.app = app;
  await setSetting("app", app);
}

export async function setPressEnter(pressEnter: boolean) {
  settings.pressEnter = pressEnter;
  await setSetting("pressEnter", pressEnter);
}

const brightnessListeners = new Set<(brightness: number) => void>();

export async function setIndicatorBrightness(brightness: number) {
  settings.indicatorBrightness = brightness;
  brightnessListeners.forEach((listener) => listener(brightness));
  await setSetting("indicatorBrightness", brightness);
}

export function useIndicatorBrightness() {
  const [current, setCurrent] = useState(settings.indicatorBrightness);
  useEffect(() => {
    brightnessListeners.add(setCurrent);
    setCurrent(settings.indicatorBrightness);
    return () => void brightnessListeners.delete(setCurrent);
  }, []);
  return current;
}

export const sendText = (text: string) => sendTextCall(text, settings.pressEnter);

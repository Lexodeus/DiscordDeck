import asyncio
import ctypes
import json
import os
import signal

import decky

# Flatpak ID, X window class and display name of each supported client, in order of preference
APPS = {
    "discord": ("com.discordapp.Discord", "^discord$", "Discord"),
    "vesktop": ("dev.vencord.Vesktop", "^vesktop$", "Vesktop"),
}
# Gamescope only lets Steam focus windows that carry a STEAM_GAME app ID, which windows
# launched outside Steam don't have. This ID ("DISC") is not a real Steam app.
GAMESCOPE_APP_ID = 0x44495343
STEAM_APP_ID = 769
WINDOW_WAIT_SECONDS = 60
# Both clients show a small splash window (same window class) while they load
MIN_WINDOW_SIZE = 400
# Time for the client to take keyboard focus again after it's brought back to the front
REFOCUS_DELAY = 0.3

SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

# Steam Input treats Discord's window as app GAMESCOPE_APP_ID without its top byte
CONTROLLER_APP_ID = GAMESCOPE_APP_ID & 0xFFFFFF
LAYOUT_TITLE = "DiscordDeck"


def load_settings() -> dict:
    try:
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(values: dict):
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(values, f, indent=2)


def session_env() -> dict[str, str]:
    """Environment for talking to Steam's X display and the user's systemd session."""
    # Decky's bundled libraries leak in through LD_LIBRARY_PATH and break system binaries
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LD_", "PYTHON", "_MEI"))}
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    env["DISPLAY"] = ":0"
    env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin"
    # xdotool drops anything outside ASCII without a UTF-8 locale
    env["LC_ALL"] = "C.UTF-8"
    # Copy the display and session bus from Steam itself, in case they aren't the defaults
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/comm") as f:
                if f.read().strip() != "steam":
                    continue
            with open(f"/proc/{pid}/environ", "rb") as f:
                steam_env = dict(
                    item.split("=", 1) for item in f.read().decode(errors="replace").split("\0") if "=" in item
                )
        except OSError:
            continue
        for key in ("DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"):
            if key in steam_env:
                env[key] = steam_env[key]
        break
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={env['XDG_RUNTIME_DIR']}/bus")
    return env


def die_with_parent():
    """Runs in the child before exec. Decky can stop the backend without cleanup, which would leave it running."""
    try:
        PR_SET_PDEATHSIG = 1
        ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    except Exception:
        pass


# Steam Input layouts are Valve KeyValues files: nested "key" "value" pairs where keys can repeat, so a block is
# kept as a list of (key, value) pairs and a value is either a string or another list.
KeyValues = list[tuple[str, "str | KeyValues"]]


def parse_keyvalues(text: str) -> KeyValues:
    tokens: list[str | None] = []  # None marks a brace, kept in order in braces
    braces: list[str] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c.isspace():
            i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = len(text) if end == -1 else end + 1
        elif c in "{}":
            tokens.append(None)
            braces.append(c)
            i += 1
        elif c == '"':
            end = text.index('"', i + 1)
            tokens.append(text[i + 1:end])
            i = end + 1
        else:
            end = i
            while end < len(text) and not text[end].isspace() and text[end] not in '{}"':
                end += 1
            tokens.append(text[i:end])
            i = end
    pos = brace = 0

    def block() -> KeyValues:
        nonlocal pos, brace
        pairs: KeyValues = []
        while pos < len(tokens):
            key = tokens[pos]
            pos += 1
            if key is None:
                if braces[brace] == "}":
                    brace += 1
                    return pairs
                raise ValueError("Block without a key")
            value = tokens[pos]
            pos += 1
            if value is None:
                if braces[brace] != "{":
                    raise ValueError("Unexpected }")
                brace += 1
                pairs.append((key, block()))
            else:
                pairs.append((key, value))
        return pairs

    return block()


def format_keyvalues(pairs: KeyValues, depth=0) -> str:
    indent = "\t" * depth
    lines = []
    for key, value in pairs:
        if isinstance(value, str):
            lines.append(f'{indent}"{key}"\t\t"{value}"')
        else:
            lines += [f'{indent}"{key}"', f"{indent}{{", format_keyvalues(value, depth + 1), f"{indent}}}"]
    return "\n".join(line for line in lines if line)


def blocks(pairs: KeyValues, key: str) -> list[KeyValues]:
    return [value for k, value in pairs if k.lower() == key.lower() and not isinstance(value, str)]


def edit_button(mappings: KeyValues, button: str, edit) -> bool:
    """Runs edit on every binding list of a button. Returns whether anything changed."""
    changed = False
    for group in blocks(mappings, "group"):
        for inputs in blocks(group, "inputs"):
            for binding in blocks(inputs, button):
                for activators in blocks(binding, "activators"):
                    for _, activator in activators:
                        if isinstance(activator, str):
                            continue
                        for bindings in blocks(activator, "bindings"):
                            before = list(bindings)
                            edit(bindings)
                            changed |= bindings != before
    return changed


def button_activators(mappings: KeyValues, button: str) -> list[KeyValues]:
    return [activators for group in blocks(mappings, "group") for inputs in blocks(group, "inputs")
            for binding in blocks(inputs, button) for activators in blocks(binding, "activators")]


def bound_keys(activators: KeyValues) -> list[str]:
    """Every key a button presses, from all its activators"""
    return [value.split(",")[0].strip() for _, activator in activators if not isinstance(activator, str)
            for bindings in blocks(activator, "bindings") for key, value in bindings
            if key == "binding" and isinstance(value, str)]


def full_press(binding: str, settings: KeyValues) -> tuple[str, KeyValues]:
    return ("Full_Press", [("bindings", [("binding", binding)]), ("settings", settings)])


# Steam presses and releases all of an activator's keys in the same instant, and Chromium apps like Discord ignore a
# shortcut pressed that way. So Ctrl goes down 30 ms before K and comes up 30 ms after it, from separate activators.
QUICK_SWITCHER: KeyValues = [
    full_press("key_press LEFT_CONTROL, Quick switcher", [("delay_end", "30"), ("interruptable", "0")]),
    full_press("key_press K", [("delay_start", "30"), ("interruptable", "0")]),
]
ESCAPE: KeyValues = [("Full_Press", [("bindings", [("binding", "key_press ESCAPE")])])]

# What View (button_menu) presses in Steam's Web Browser layout, and in DiscordDeck 0.2.0's layout
WEB_BROWSER_VIEW = ["key_press LEFT_CONTROL", "key_press W"]
DISCORDDECK_0_2_0_VIEW = ["key_press LEFT_CONTROL", "key_press K"]


def set_menu_buttons(mappings: KeyValues, view_keys: list[str]) -> bool:
    """
    Puts the quick switcher on Menu (☰, button_escape in layout files) and Escape on View (⧉, button_menu), if
    they still press Escape and view_keys. Returns whether it changed them.
    """
    menu, view = button_activators(mappings, "button_escape"), button_activators(mappings, "button_menu")
    if len(menu) != 1 or len(view) != 1 or bound_keys(menu[0]) != ["key_press ESCAPE"] or bound_keys(view[0]) != view_keys:
        return False
    menu[0][:] = QUICK_SWITCHER
    view[0][:] = ESCAPE
    return True


# Steam only has a Web Browser layout for the Steam Deck. The Steam Controller (2026) has the same buttons and input
# names, so its layout is built from the Deck's.
WEB_BROWSER_TEMPLATES = {"controller_neptune": "controller_neptune", "controller_triton": "controller_neptune"}


def build_layout(template: str, template_url: str, url: str, steam_id: str, controller_type: str) -> str:
    """
    Steam's Web Browser layout, for controller_type, with these buttons changed for Discord:
    - Menu sends Ctrl+K (quick switcher) instead of Escape
    - View sends Escape instead of Ctrl+W, which hides Discord's window to the tray
    - A presses only Enter (not also Space)
    - Y goes Forward only (not also the S key)
    """
    (_, mappings), = parse_keyvalues(template)

    def remove(binding: str):
        def edit(bindings: KeyValues):
            bindings[:] = [(k, v) for k, v in bindings if not (k == "binding" and v.split(",")[0].strip() == binding)]
        return edit

    for button, edit in {"button_a": remove("key_press SPACE"), "button_y": remove("key_press S")}.items():
        if not edit_button(mappings, button, edit):
            raise ValueError(f"Steam's Web Browser layout has changed, {button} wasn't found")
    if not set_menu_buttons(mappings, WEB_BROWSER_VIEW):
        raise ValueError("Steam's Web Browser layout has changed, its Menu or View button wasn't found")
    header = {
        "title": LAYOUT_TITLE,
        "description": "Layout for Discord, set up by DiscordDeck",
        "creator": steam_id,
        "progenitor": template_url,
        "url": url,
        "export_type": "unknown",
    }
    body = [(k, v) for k, v in mappings if k.lower() not in header and k.lower() != "localization"]
    body = [(k, controller_type if k == "controller_type" else v) for k, v in body]
    version = [(k, v) for k, v in body[:1] if k == "version"]
    mappings[:] = version + list(header.items()) + body[len(version):]
    return format_keyvalues([("controller_mappings", mappings)]) + "\n"


def update_layout(path: str) -> bool:
    """
    DiscordDeck 0.2.0 put the quick switcher on View instead of Menu, pressing Ctrl and K at once. Fixes that in a
    layout it saved, unless those buttons were changed since. The rest of the layout stays as it is.
    """
    with open(path, encoding="utf-8") as f:
        (_, mappings), = parse_keyvalues(f.read())
    if not set_menu_buttons(mappings, DISCORDDECK_0_2_0_VIEW):
        return False
    write_file(path, format_keyvalues([("controller_mappings", mappings)]) + "\n")
    decky.logger.info(f"Fixed the Menu and View buttons in {path}")
    return True


def write_file(path: str, text: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


def steam_dir() -> str:
    return os.path.join(decky.DECKY_USER_HOME, ".local", "share", "Steam")


def layout_path(steam_id: str, serial: str) -> str:
    # Steam keeps the layout picked for an app per controller, in a file named after the controller's serial number
    account_id = int(steam_id) - 76561197960265728
    return os.path.join(steam_dir(), "steamapps", "common", "Steam Controller Configs", str(account_id), "config",
                        str(CONTROLLER_APP_ID), f"{serial}.vdf")


def layout_title(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            (_, mappings), = parse_keyvalues(f.read())
        return next((v for k, v in mappings if k.lower() == "title" and isinstance(v, str)), None)
    except (OSError, ValueError):
        return None


async def run(*args: str, stdin: str | None = None) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, env=session_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate(stdin.encode() if stdin is not None else None)
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def read_root_cardinals(prop: str) -> list[int]:
    _, out = await run("xprop", "-root", prop)
    return parse_cardinals(out)


def parse_cardinals(xprop_line: str) -> list[int]:
    if "=" not in xprop_line:
        return []
    return [int(v) for v in xprop_line.split("=", 1)[1].replace(" ", "").split(",") if v.isdigit()]


async def is_top_level(window: int) -> bool:
    """Gamescope only shows top-level windows. An app can also have visible child windows drawn inside its own."""
    _, out = await run("xwininfo", "-tree", "-id", str(window))
    parent = next((line for line in out.splitlines() if line.strip().startswith("Parent window id:")), "")
    return "(the root window)" in parent


async def set_root_window_focus(window: int):
    await run("xprop", "-root", "-f", "GAMESCOPECTRL_BASELAYER_WINDOW", "32c",
              "-set", "GAMESCOPECTRL_BASELAYER_WINDOW", str(window))


async def park_pointer() -> tuple[int, int] | None:
    """
    Moves the mouse pointer to the bottom-right corner, where Steam keeps it, and returns where it was (None if it was
    already there).
    Steam's menu opens at the left edge of the screen. If the pointer is still over that spot when Discord steps
    aside, the menu and Steam's main window fight over keyboard focus and Steam's UI hangs.
    """
    try:
        _, location = await run("xdotool", "getmouselocation", "--shell")
        values = dict(line.split("=", 1) for line in location.splitlines() if "=" in line)
        _, size = await run("xdotool", "getdisplaygeometry")
        width, height = (int(v) for v in size.split())
        corner = (width - 1, height - 1)
        position = (int(values["X"]), int(values["Y"]))
        if position == corner:
            return None
        await run("xdotool", "mousemove", *map(str, corner))
        return position
    except Exception:
        decky.logger.exception("Couldn't move the mouse pointer out of the way")
        return None


class Plugin:
    launching = False
    shown_window: int | None = None
    error: str | None = None

    # Where the mouse pointer was in Discord before it was parked for Steam
    pointer: tuple[int, int] | None = None

    # Discord window stepped aside while a Steam menu, modal, keyboard or the message box is open
    lowered_window: int | None = None
    steam_overlay_open = False

    # Message from the plugin's message box, typed into Discord once it's back in front
    pending_text: tuple[str, bool] | None = None

    async def _main(self):
        self.lock = asyncio.Lock()
        self.show_task: asyncio.Task | None = None
        self.watch_task: asyncio.Task | None = None
        async with self.lock:
            await self._release_stale_windows()

    async def _unload(self):
        # Decky may stop the backend before a full hide() finishes, so give the screen back to Steam first
        if self.shown_window is not None:
            await park_pointer()
            await set_root_window_focus(0)
        await self.hide()

    async def _release_stale_windows(self):
        """Releases windows a previous run left tagged, e.g. when Decky stopped it before it could clean up."""
        if self.shown_window is not None:
            return
        focused = await read_root_cardinals("GAMESCOPECTRL_BASELAYER_WINDOW")
        focusable = await read_root_cardinals("GAMESCOPE_FOCUSABLE_WINDOWS")
        # Triplets of window, app ID, pid
        for window, app_id in zip(focusable[0::3], focusable[1::3]):
            if app_id != GAMESCOPE_APP_ID:
                continue
            if focused == [window]:
                # Put the pointer back where it was when Discord is shown again
                self.pointer = await park_pointer() or self.pointer
                await set_root_window_focus(0)
            await run("xprop", "-id", str(window), "-remove", "STEAM_GAME")
            decky.logger.info(f"Released Discord window {window} left over from a previous run")

    async def _installed_apps(self) -> list[str]:
        _, out = await run("flatpak", "list", "--app", "--columns=application")
        installed = out.split()
        return [key for key, (flatpak_id, _, _) in APPS.items() if flatpak_id in installed]

    async def _running_apps(self) -> list[str]:
        _, out = await run("flatpak", "ps", "--columns=application")
        running = out.split()
        return [key for key, (flatpak_id, _, _) in APPS.items() if flatpak_id in running]

    async def _active_app(self) -> str | None:
        """The client picked in the settings, or before one is picked, a running one or the first installed one."""
        chosen = load_settings().get("app")
        if chosen in APPS:
            return chosen
        running = await self._running_apps()
        return (running or await self._installed_apps() or [None])[0]

    async def get_state(self) -> dict:
        installed = await self._installed_apps()
        app = await self._active_app()
        return {
            "installed": installed,
            "app": app,
            "appName": APPS[app][2] if app else None,
            "running": app in await self._running_apps(),
            "launching": self.launching,
            "shown": self.shown_window is not None,
            "error": self.error,
        }

    async def get_setting(self, key: str, default):
        return load_settings().get(key, default)

    async def set_setting(self, key: str, value):
        values = load_settings()
        previous = values.get(key)
        values[key] = value
        save_settings(values)
        if key == "app" and value != previous:
            # Don't leave the previous client's window on screen
            await self.hide()

    async def prepare_layout(self, steam_id: str, serial: str, controller_type: str, replace: bool) -> dict:
        """
        Writes DiscordDeck's controller layout for one controller, and returns its URL to select it with.
        A layout file that's already there is kept, so changes made to it in Steam stay (only 0.2.0's Menu and View
        buttons get fixed, see update_layout). "updated" says whether the file changed. One with another title is
        a different layout, saved by Steam for this controller: it's only replaced with replace set, and otherwise
        its title is returned instead of a URL.
        """
        path = layout_path(steam_id, serial)
        url = f"autosave://{path}"
        if os.path.exists(path):
            title = layout_title(path)
            if title == LAYOUT_TITLE:
                try:
                    updated = update_layout(path)
                except (OSError, ValueError) as e:
                    decky.logger.error(f"Couldn't check the controller layout {path}: {e}")
                    updated = False
                return {"url": url, "title": title, "updated": updated}
            if not replace:
                return {"url": None, "title": title, "updated": False}
        if controller_type not in WEB_BROWSER_TEMPLATES:
            raise ValueError(f"No Web Browser layout to start from for {controller_type}")
        template_name = f"{WEB_BROWSER_TEMPLATES[controller_type]}_webbrowser.vdf"
        with open(os.path.join(steam_dir(), "controller_base", "templates", template_name), encoding="utf-8") as f:
            layout = build_layout(f.read(), f"template://{template_name}", url, steam_id, controller_type)
        write_file(path, layout)
        decky.logger.info(f"Wrote the controller layout {path}")
        return {"url": url, "title": LAYOUT_TITLE, "updated": True}

    async def show(self):
        """Bring Discord to the front, launching it first if needed."""
        if self.show_task and not self.show_task.done():
            return
        self.show_task = asyncio.create_task(self._show())

    async def hide(self):
        """Hand the screen back to Steam. Discord keeps running (and in voice) in the background."""
        if self.show_task and not self.show_task.done():
            self.show_task.cancel()
        async with self.lock:
            self.steam_overlay_open = False
            self.lowered_window = None
            self.pending_text = None
            await self._unfocus()
        await self.emit_state()

    async def set_steam_overlay_open(self, is_open: bool):
        """
        With no game running, Steam draws its menus, modals and keyboard inside its own window,
        which is underneath Discord. Step Discord aside while they're open.
        """
        async with self.lock:
            self.steam_overlay_open = is_open
            if is_open and self.shown_window is not None:
                window = self.shown_window
                await self._unfocus(keep_watching=True)
                self.lowered_window = window
            elif not is_open and self.lowered_window is not None:
                window, self.lowered_window = self.lowered_window, None
                if await self._find_window() == window:
                    await self._focus(window)
            await self._type_pending_text()
        await self.emit_state()

    async def send_text(self, text: str, press_enter: bool):
        """Type text into Discord's selected text field, as soon as Discord is back in front."""
        text = " ".join(text.splitlines()).strip()
        if not text:
            return
        async with self.lock:
            self.pending_text = (text, press_enter)
            await self._type_pending_text()

    async def close(self):
        app = await self._active_app()
        await self.hide()
        if app:
            await run("flatpak", "kill", APPS[app][0])
        await self.emit_state()

    async def emit_state(self):
        await decky.emit("state", await self.get_state())

    async def _show(self):
        self.error = None
        try:
            app = await self._active_app()
            if app is None:
                raise RuntimeError("Neither Discord nor Vesktop is installed")
            if app not in await self._installed_apps():
                raise RuntimeError(f"{APPS[app][2]} isn't installed. Install it from Discover in Desktop Mode.")
            window = await self._find_window(app)
            if window is None:
                self.launching = True
                await self.emit_state()
                # Also brings back a window that was closed to the tray, through the running instance
                await self._launch(app)
                window = await self._wait_for_window(app)
            async with self.lock:
                if self.steam_overlay_open:
                    self.lowered_window = window
                else:
                    await self._focus(window)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            decky.logger.exception("Failed to show Discord")
            self.error = str(e)
        finally:
            self.launching = False
            await self.emit_state()

    async def _launch(self, app: str):
        flatpak_id = APPS[app][0]
        env = session_env()
        decky.logger.info(f"Launching {flatpak_id} on {env['DISPLAY']}")
        # Run it in the user's systemd session so it outlives the plugin and Decky restarts
        code, out = await run(
            "systemd-run", "--user", "--collect", "--quiet",
            *(f"--setenv={k}={env[k]}" for k in ("DISPLAY", "XAUTHORITY") if k in env),
            "flatpak", "run", flatpak_id,
        )
        if code != 0:
            raise RuntimeError(f"Couldn't start {APPS[app][2]}: {out}")

    async def _find_window(self, app: str | None = None) -> int | None:
        app = app or await self._active_app()
        if app is None:
            return None
        # Skips the unmapped helper windows and the splash window shown while the client loads
        _, out = await run("xdotool", "search", "--onlyvisible", "--class", APPS[app][1])
        for window in reversed([w for w in out.split() if w.isdigit()]):
            if not await is_top_level(int(window)):
                continue
            _, geometry = await run("xdotool", "getwindowgeometry", "--shell", window)
            size = dict(line.split("=", 1) for line in geometry.splitlines() if "=" in line)
            if int(size.get("WIDTH", 0)) >= MIN_WINDOW_SIZE and int(size.get("HEIGHT", 0)) >= MIN_WINDOW_SIZE:
                return int(window)
        return None

    async def _wait_for_window(self, app: str) -> int:
        for _ in range(WINDOW_WAIT_SECONDS * 2):
            window = await self._find_window(app)
            if window is not None:
                return window
            await asyncio.sleep(0.5)
        raise RuntimeError(f"{APPS[app][2]} started, but its window never appeared")

    async def _type_pending_text(self):
        """Types the pending message if Discord is in front. Call with the lock held."""
        if self.pending_text is None or self.shown_window is None:
            return
        (text, press_enter), self.pending_text = self.pending_text, None
        await asyncio.sleep(REFOCUS_DELAY)
        # Typed through XTEST into whatever has keyboard focus, which is the window gamescope focused
        await run("xdotool", "type", "--delay", "12", "--file", "-", stdin=text)
        if press_enter:
            await run("xdotool", "key", "Return")

    async def _focus(self, window: int):
        await run("xprop", "-id", str(window), "-f", "STEAM_GAME", "32c", "-set", "STEAM_GAME", str(GAMESCOPE_APP_ID))
        await set_root_window_focus(window)
        self.shown_window = window
        if self.pointer:
            await run("xdotool", "mousemove", *map(str, self.pointer))
            self.pointer = None
        decky.logger.info(f"Showing Discord window {window}")
        if not self.watch_task or self.watch_task.done():
            self.watch_task = asyncio.create_task(self._watch_steam_focus())

    async def _unfocus(self, keep_watching=False):
        if not keep_watching and self.watch_task and not self.watch_task.done():
            self.watch_task.cancel()
        window, self.shown_window = self.shown_window, None
        if window is None:
            return
        if await read_root_cardinals("GAMESCOPECTRL_BASELAYER_WINDOW") == [window]:
            self.pointer = await park_pointer()
            await set_root_window_focus(0)
        await run("xprop", "-id", str(window), "-remove", "STEAM_GAME")
        decky.logger.info(f"Hid Discord window {window}")

    async def _watch_steam_focus(self):
        """Steps aside when Steam brings a game to the front, e.g. when it's resumed from the Steam menu."""
        proc = await asyncio.create_subprocess_exec(
            "xprop", "-root", "-spy", "GAMESCOPECTRL_BASELAYER_APPID",
            env=session_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            preexec_fn=die_with_parent,
        )
        try:
            assert proc.stdout
            # The first line is the current value
            last = parse_cardinals((await proc.stdout.readline()).decode())
            while line := await proc.stdout.readline():
                app_ids = parse_cardinals(line.decode())
                if app_ids == last:
                    continue
                last = app_ids
                if app_ids and app_ids[0] != STEAM_APP_ID:
                    decky.logger.info(f"Steam focused app {app_ids[0]}, hiding Discord")
                    async with self.lock:
                        self.watch_task = None
                        self.lowered_window = None
                        self.pending_text = None
                        await self._unfocus()
                    await self.emit_state()
                    return
        finally:
            if proc.returncode is None:
                proc.kill()

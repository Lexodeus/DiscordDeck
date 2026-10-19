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

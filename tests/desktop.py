#!/usr/bin/env python3
"""Exercise the installed Linux application on an isolated display and D-Bus session.

Run with xvfb-run -a dbus-run-session -- python3 tests/desktop.py /usr/bin/editor-text.
Requires WebKitWebDriver, xdotool, xclip and an available loopback socket on a private X11 display.
"""
import argparse
import base64
import contextlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def eventually(function, label, timeout=10):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if function():
            return
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {label}")


class Driver:
    def __init__(self, binary, environment, port):
        self.binary = binary
        self.environment = environment
        self.base = f"http://127.0.0.1:{port}"
        self.session = ""
        self.process = subprocess.Popen(["WebKitWebDriver", f"--port={port}"], env=environment, start_new_session=True)
        def online():
            try:
                return self.request("GET", "/status")
            except URLError:
                return False
        eventually(online, "WebKitWebDriver")

    def request(self, method, suffix, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = Request(self.base + suffix, data=data, method=method, headers={"Content-Type":"application/json"})
        try:
            with urlopen(req, timeout=35) as reply:
                return json.load(reply)["value"]
        except HTTPError as e:
            raise RuntimeError(f"{method} {suffix}: {e.read().decode()}") from e

    def start(self, args=()):
        caps = {"webkitgtk:browserOptions":{"binary":str(self.binary), "args":[str(p) for p in args]}}
        self.session = "/session/" + self.request("POST", "/session", {"capabilities":{"alwaysMatch":caps}})["sessionId"]
        eventually(lambda: self.js("return !!document.querySelector('.cm-content')"), "the editor")

    def app_processes(self):
        profile = os.fsencode("XDG_CONFIG_HOME=" + self.environment["XDG_CONFIG_HOME"])
        pids = []
        for proc in Path("/proc").glob("[0-9]*"):
            try:
                if (proc/"exe").resolve(strict=True) == self.binary and profile in (proc/"environ").read_bytes().split(b"\0"):
                    pids.append(int(proc.name))
            except OSError:
                continue
        return pids

    def stop(self):
        if self.session:
            with contextlib.suppress(RuntimeError, URLError):
                self.request("DELETE", self.session)
            self.session = ""
            # WebDriver may return while the old single-instance owner is exiting.
            eventually(lambda: not self.app_processes(), "previous test application exit")

    def close(self):
        self.stop()
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process.pid, signal.SIGTERM)
        self.process.wait(timeout=5)

    def js(self, script, *args):
        return self.request("POST", self.session + "/execute/sync", {"script":script, "args":list(args)})

    def key(self, *keys):
        down = [{"type":"keyDown", "value":key} for key in keys]
        up = [{"type":"keyUp", "value":key} for key in reversed(keys)]
        self.request("POST", self.session + "/actions", {"actions":[{"type":"key", "id":"keyboard", "actions":down + up}]})

    def insert(self, text):
        if "\n" in text:
            # Use a real multiline paste on the private X11 display.
            subprocess.run(["xclip", "-selection", "clipboard", "-i"], input=text.encode(),
                           env=self.environment, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.key("\ue009", "v")
            return
        assert self.js("return document.execCommand('insertText', false, arguments[0])", text)

    def click(self, selector):
        self.js("document.querySelector(arguments[0]).click()", selector)

    def button(self, name):
        self.js("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim() === arguments[0]).click()", name)

    def text(self, selector):
        return self.js("return document.querySelector(arguments[0])?.textContent", selector)

    def wait(self, expr, label):
        eventually(lambda: self.js("return (" + expr + ")"), label)


def choose_save_path(driver, target):
    dialog = subprocess.check_output(
        ["xdotool", "search", "--sync", "--onlyvisible", "--name", "^Save As"],
        text=True, timeout=12, env=driver.environment).splitlines()[-1]
    def xkey(*arguments):
        subprocess.run(["xdotool", *arguments], check=True, timeout=5, env=driver.environment)
    xkey("windowfocus", "--sync", dialog)
    xkey("key", "ctrl+a")
    xkey("type", str(target))
    xkey("key", "Return")


def save_as_mixed(driver, temp):
    source = temp / "mixed.txt"
    copy = temp / "mixed-copy.txt"
    contents = b"a\r\nb\nc\rd\n"
    source.write_bytes(contents)
    driver.start([source])
    driver.wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() === 'mixed.txt'", "mixed-line-ending file")
    driver.key("\ue009", "\ue008", "s")
    choose_save_path(driver, copy)
    eventually(copy.is_file, "Save As copy")
    assert copy.read_bytes() == contents, "Save As changed the source line endings"
    assert source.read_bytes() == contents
    print("PASS Save As preserves mixed CRLF, LF and CR byte for byte", flush=True)


def forward_without_display(driver, temp):
    # The existing window owns the UI. A forwarding process only needs its D-Bus session.
    environment = {**driver.environment, "GDK_BACKEND": "x11"}
    environment.pop("DISPLAY", None)
    environment.pop("WAYLAND_DISPLAY", None)
    tabs = driver.js("return document.querySelectorAll('[role=tab]').length")
    primary = driver.app_processes()
    assert len(primary) == 1
    path = temp / "forwarded β file.txt"
    path.write_text("forwarded from another working directory", encoding="utf-8")
    subprocess.run([driver.binary, path.name], cwd=temp, env=environment, timeout=10, check=True)
    driver.wait(f"document.querySelectorAll('[role=tab]').length === {tabs + 1} && "
                "document.querySelector('.cm-content')?.textContent === 'forwarded from another working directory'",
                "forwarded relative filename in the original window")
    subprocess.run([driver.binary], cwd=temp, env=environment, timeout=10, check=True)
    driver.wait(f"document.querySelectorAll('[role=tab]').length === {tabs + 2} && "
                "document.querySelector('[role=tab][aria-selected=true]')?.textContent.startsWith('Untitled')",
                "forwarded blank document in the original window")
    assert driver.app_processes() == primary
    print("PASS file and blank secondary launches forward without a display", flush=True)


def run(driver, temp, capture=None):
    ctrl, tab, esc = "\ue009", "\ue004", "\ue00c"
    driver.start()
    driver.wait("document.querySelectorAll('[role=tab]').length === 1 && document.activeElement.matches('.cm-content')", "one focused blank document")
    assert driver.text(".cm-content") == ""
    if capture:
        capture.write_bytes(base64.b64decode(driver.request("GET",driver.session + "/screenshot")))
    print("PASS blank startup and keyboard focus", flush=True)
    driver.key(ctrl, 'n')
    driver.wait("document.querySelectorAll('[role=tab]').length === 2", "new blank tab")
    driver.key(ctrl, 's')
    blank = temp / "empty notes"
    choose_save_path(driver, blank)
    eventually(lambda: blank.is_file() and blank.read_bytes() == b"", "zero-byte extensionless file")
    driver.wait("document.querySelector('[role=tab][aria-selected=true]').textContent.trim() === 'empty notes'", "saved tab name")
    driver.key(ctrl, 'w')
    driver.wait("document.querySelectorAll('[role=tab]').length === 1", "close saved blank")
    driver.wait("document.activeElement.matches('.cm-content')", "focus after closing the saved tab")
    print("PASS Save creates a zero-byte document with the exact extensionless name", flush=True)
    driver.insert("def example():\n    return 'é😀'")
    driver.wait("document.querySelector('.status-language').textContent === 'Python'", "unsaved language detection")
    assert "30 characters" in driver.text(".count"), driver.text(".count")
    driver.click("[aria-label='New document']")
    driver.wait("document.querySelectorAll('[role=tab]').length === 2", "new tab")
    driver.key(tab)
    driver.wait("document.querySelector('.count').textContent.includes('4 characters')", "Tab indentation on a blank line")
    driver.key(ctrl, 'z')
    driver.wait("document.querySelector('.count').textContent.includes('0 characters')", "undo")
    driver.key(ctrl, 'y')
    driver.wait("document.querySelector('.count').textContent.includes('4 characters')", "redo")
    driver.key(ctrl, 'w')
    driver.wait("document.querySelector('dialog[open]')", "close prompt")
    driver.button("Discard")
    driver.wait("document.querySelectorAll('[role=tab]').length === 1", "close tab")
    driver.key(ctrl, 'f')
    driver.wait("document.querySelector('.cm-search')", "find panel")
    driver.key(esc)
    print("PASS unsaved detection, Unicode count, tabs, indentation, undo, redo and find", flush=True)

    # Exercise the running-instance argument queue with real Unicode/space paths.
    source = temp / "sample β file.py"
    other = temp / "settings file.json"
    source.write_bytes(b"\xef\xbb\xbfa = 1\r\n")
    other.write_text('{"mode":"test"}')
    desktop = os.environ.get("EDITOR_TEST_DESKTOP")
    command = ["gio", "launch", desktop] if desktop else [str(driver.binary)]
    subprocess.run([*command, str(source), str(other)], env=driver.environment, timeout=15, check=True)
    driver.wait("document.querySelectorAll('[role=tab]').length === 3", "second-instance file arguments")
    driver.click("[role=tab][title$='.py']")
    assert driver.text(".status-language") == "Python"
    driver.key(ctrl, 'a')
    driver.insert("a = 2\nb = 3\n")
    eventually(lambda: source.read_bytes() == b"\xef\xbb\xbfa = 2\r\nb = 3\r\n", "atomic autosave with BOM and CRLF")
    source.write_bytes(b"external = True\r\n")
    driver.wait("document.querySelector('dialog[open]') || document.querySelector('.problem')", "external conflict")
    if not driver.js("return !!document.querySelector('dialog[open]')"):
        driver.click(".problem")
    driver.wait("document.querySelector('dialog[open]')", "external-change question")
    driver.button("Reload")
    driver.wait("document.querySelector('.cm-content').textContent.includes('external = True')", "confirmed external reload")
    print("PASS multi-file OS opening, byte-preserving autosave and external-change reload", flush=True)
    driver.button("Settings")
    driver.button("Preferences…")
    driver.js("""const select=document.querySelector('dialog select'); select.value='dark';
                 select.dispatchEvent(new Event('change',{bubbles:true}));""")
    driver.button("Accessibility")
    driver.js("""const size=Array.from(document.querySelectorAll('dialog label')).find(l=>l.textContent.includes('Editor font size')).querySelector('input');
                 size.value='18'; size.dispatchEvent(new Event('input',{bubbles:true}));""")
    driver.button("Apply")
    driver.wait("document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.querySelector('.cm-content')).fontSize === '18px'", "independent dark theme and editor font size")
    # Clean shutdown must discard the unsaved first tab only on explicit consent.
    driver.button("File")
    driver.button("Exit")
    driver.wait("document.querySelector('dialog[open]')", "exit save question")
    driver.button("Discard")
    eventually(lambda: (temp / "config/app.editor.TextEditor/window.json").exists(), "window geometry persistence")
    driver.stop()
    geometry_path = temp / "config/app.editor.TextEditor/window.json"
    geometry = json.loads(geometry_path.read_text())
    geometry.update(width=732, height=482, x=99999, y=99999, maximized=False)
    geometry_path.write_text(json.dumps(geometry))
    driver.start([source, other])
    driver.wait("innerWidth === 732 && innerHeight === 482 && screenX < screen.width && screenY < screen.height", "restored geometry on the available monitor")
    driver.wait("document.querySelectorAll('[role=tab]').length === 2", "explicit paths on startup without a blank tab")
    assert driver.text(".cm-content") == '{"mode":"test"}'
    driver.stop()
    driver.start()
    driver.wait("document.querySelectorAll('[role=tab]').length === 1 && document.querySelector('.cm-content').textContent === ''", "normal launch following clean exit")
    print("PASS clean exit, on-screen restored geometry, explicit-path startup and fresh launch", flush=True)
    driver.wait("document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.querySelector('.cm-content')).fontSize === '18px'", "saved appearance preferences")
    # SIGKILL a process that belongs specifically to this private test session.
    driver.insert("unsaved recovery probe")
    recovery = temp/"data/app.editor.TextEditor/recovery"
    eventually(lambda: any("unsaved recovery probe" in f.read_text() for f in recovery.glob("*.json")), "durable recovery snapshot")
    pids = driver.app_processes()
    assert len(pids) == 1, "could not identify the isolated test process"
    os.kill(pids[0], signal.SIGKILL)
    eventually(lambda: not Path(f"/proc/{pids[0]}").exists(), "crashed process exit")
    driver.stop()
    driver.start()
    driver.wait("document.querySelector('dialog[open]')?.textContent.includes('Recover unsaved changes')", "crash recovery offer")
    driver.button("Recover")
    driver.wait("document.querySelector('.cm-content').textContent === 'unsaved recovery probe'", "recovered untitled text")
    assert driver.js("return document.querySelectorAll('[role=tab]').length") == 1
    driver.key(ctrl, 'w')
    driver.wait("document.querySelector('dialog[open]')", "recovered tab close")
    driver.button("Discard")
    eventually(lambda: not list(recovery.glob("*.json")), "recovery cleanup")
    print("PASS theme and font persistence, crash recovery and discarded snapshot cleanup", flush=True)

    big = temp / "large log.txt"
    sample = b"status ok - record initialized\n" * 120000
    big.write_bytes(sample)
    started = time.monotonic()
    subprocess.run([str(driver.binary), str(big)], env=driver.environment, check=True, timeout=15)
    driver.wait("document.querySelector('.count').textContent.replace(/[^0-9]/g,'') === '" + str(len(sample)) + "'", "full large-file character count")
    driver.key(ctrl, 'n')
    driver.wait("document.querySelector('.count').textContent.includes('0 characters')", "responsive new tab after large open")
    print(f"PASS {len(sample)/1048576:.1f} MiB / 120,000-line log and subsequent input in {time.monotonic()-started:.2f}s", flush=True)
    driver.stop()
    save_as_mixed(driver, temp)
    forward_without_display(driver, temp)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="editor-test-") as d:
        root = Path(d)
        env = dict(os.environ, TAURI_WEBVIEW_AUTOMATION="true", XDG_CONFIG_HOME=str(root/"config"),
                   XDG_DATA_HOME=str(root/"data"), XDG_CACHE_HOME=str(root/"cache"))
        with socket.socket() as s:
            s.bind(("127.0.0.1",0))
            port = s.getsockname()[1]
        driver = Driver(args.binary.resolve(strict=True), env, port)
        try:
            run(driver, root, args.screenshot)
        except Exception:
            with contextlib.suppress(Exception):
                print("Visible state:", driver.js("return document.body.innerText"), flush=True)
            raise
        finally:
            driver.close()


if __name__ == "__main__":
    main()

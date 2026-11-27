#!/usr/bin/env python3
"""Build AGY Lab using the unmodified Electron development distribution."""

import argparse
import json
import plistlib
import shutil
import tempfile
from pathlib import Path

from bundle_base import (
    BUNDLE_ID, DEFAULT_CHECKSUMS, DISPLAY_NAME, OFFICIAL_REQUIREMENT, PROJECT_ROOT,
    SUPPORTED_VERSIONS, bundle_chinese, find_asar, install_lab, run,
    replace_once, sign_item, update_file, verified_electron_archive,
)
from bundle_context import patch_context_cap
from bundle_login import patch_login
from renderer_patch import patch_renderer


DEFAULT_SOURCE = Path("/Applications/Antigravity.app")
DEFAULT_ARCHIVE = PROJECT_ROOT / "build" / "source" / "electron-v44.9.1-darwin-arm64.zip"
DEFAULT_OUTPUT = PROJECT_ROOT / "dist" / f"{DISPLAY_NAME}.app"
RESOURCES_EXPRESSION = 'require("path").dirname(require("electron").app.getAppPath())'
PACKAGED_FILES = [
    "cablev2.js", "computer/index.js", "computer/permissionsIpc.js", "debugConsole.js",
    "keybindings.js", "languageServer.js", "main.js", "paths.js", "updater.js", "utils.js",
]


def patch_development_runtime(app_root):
    dist = app_root / "dist"
    for name in PACKAGED_FILES:
        path = dist / name

        def transform(source):
            return (
                source.replace("electron_1.app?.isPackaged", "true")
                .replace("electron_1.app.isPackaged", "true")
                .replace("process.resourcesPath", RESOURCES_EXPRESSION)
            )

        update_file(path, transform)
    main = dist / "main.js"

    def own_protocol(source):
        return replace_once(
            source,
            """if (!electron_1.app.isDefaultProtocolClient(PROTOCOL, ...protocolClientArgs)) {
    electron_1.app.setAsDefaultProtocolClient(PROTOCOL, ...protocolClientArgs);
}""",
            "// The application launcher owns this copy's URL scheme.",
            "protocol registration",
        )

    update_file(main, own_protocol)


def brand_host(host, icon):
    """The Dock shows the Electron host process, so it carries the app's name and icon."""
    contents = host / "Contents"
    with (contents / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    info.update({
        "CFBundleIdentifier": f"{BUNDLE_ID}.host",
        "CFBundleName": DISPLAY_NAME,
        "CFBundleDisplayName": DISPLAY_NAME,
    })
    with (contents / "Info.plist").open("wb") as stream:
        plistlib.dump(info, stream)
    shutil.copy2(icon, contents / "Resources" / info["CFBundleIconFile"])


def make_launcher(staged, version):
    contents = staged / "Contents"
    executable = contents / "MacOS" / "AGYLabLauncher"
    executable.parent.mkdir(parents=True)
    info = {
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleExecutable": executable.name,
        "CFBundleName": DISPLAY_NAME,
        "CFBundleDisplayName": DISPLAY_NAME,
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "CFBundlePackageType": "APPL",
        "CFBundleIconFile": "icon.icns",
        "CFBundleURLTypes": [{
            "CFBundleTypeRole": "Editor",
            "CFBundleURLName": DISPLAY_NAME,
            "CFBundleURLSchemes": ["agy-lab"],
        }],
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
    }
    with (contents / "Info.plist").open("wb") as stream:
        plistlib.dump(info, stream, sort_keys=False)
    run(
        "clang", "-fobjc-arc", "-framework", "Foundation", "-framework", "AppKit",
        "-framework", "CoreServices", PROJECT_ROOT / "scripts" / "launcher.m",
        "-o", executable,
    )


def build(source, archive, checksums, output, zh_project=None):
    source = source.resolve(strict=True)
    archive = archive.resolve(strict=True)
    checksums = checksums.resolve(strict=True)
    output = output.resolve()
    if zh_project is not None:
        zh_project = zh_project.resolve(strict=True)
    if not output.is_relative_to((PROJECT_ROOT / "dist").resolve()):
        raise RuntimeError("The preview app must be built inside the project's dist directory")
    if output.exists():
        raise RuntimeError(f"Output already exists: {output}")
    with (source / "Contents" / "Info.plist").open("rb") as stream:
        source_info = plistlib.load(stream)
    version = source_info.get("CFBundleShortVersionString")
    if version not in SUPPORTED_VERSIONS:
        raise RuntimeError(f"Unsupported Antigravity {version}; expected one of {', '.join(SUPPORTED_VERSIONS)}")
    run("codesign", "--verify", "--deep", "--strict", "-R", OFFICIAL_REQUIREMENT, source)
    original_resources = source / "Contents" / "Resources"
    original_server = original_resources / "bin" / "language_server"
    run("codesign", "--verify", "--strict", original_server)
    verified_electron_archive(archive, checksums)
    asar = find_asar()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".agy-preview-build-", dir=output.parent) as temporary:
        scratch = Path(temporary)
        staged = scratch / output.name
        resources = staged / "Contents" / "Resources"
        resources.mkdir(parents=True)
        host_extract = scratch / "electron"
        host_extract.mkdir()
        run("ditto", "-x", "-k", archive, host_extract)
        host = host_extract / "Electron.app"
        with (host / "Contents" / "Frameworks" / "Electron Framework.framework" / "Resources" / "Info.plist").open("rb") as stream:
            host_info = plistlib.load(stream)
        if host_info.get("CFBundleVersion") != "44.9.1":
            raise RuntimeError("Expected Electron 44.9.1")
        shutil.copytree(host, resources / "Electron.app", symlinks=True)
        brand_host(resources / "Electron.app", original_resources / "icon.icns")
        shutil.copytree(original_resources / "bin", resources / "bin", symlinks=True)
        shutil.copy2(original_resources / "icon.icns", resources / "icon.icns")
        shutil.copy2(original_resources / "Assets.car", resources / "Assets.car")
        app_root = scratch / "app"
        run(*asar, "extract", original_resources / "app.asar", app_root)
        install_lab(app_root, PROJECT_ROOT / "lab")
        make_launcher(staged, version)
        server = resources / "bin" / "language_server"
        patch_login(server)
        patch_context_cap(server)
        renderer_source = patch_renderer(server)
        if zh_project is not None:
            bundle_chinese(zh_project, renderer_source, scratch, app_root)
        patch_development_runtime(app_root)
        package_file = app_root / "package.json"
        package = json.loads(package_file.read_text(encoding="utf-8"))
        package["productName"] = "AGY Lab"
        package_file.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        run(*asar, "pack", app_root, resources / "app.asar", "--unpack-dir", "node_modules/chrome-devtools-mcp")
        sign_item(original_server, server, scratch / "server-entitlements.plist")
        run("codesign", "--verify", "--strict", server)
        run("codesign", "--force", "--sign", "-", "--options", "runtime", "--timestamp=none", staged)
        run("codesign", "--verify", "--strict", staged)
        staged.rename(output)
    print(f"Built {output}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--electron-archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--electron-checksums", type=Path, default=DEFAULT_CHECKSUMS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--zh", type=Path, help="antigravity-zh checkout whose Chinese UI is built into the copy")
    arguments = parser.parse_args()
    build(arguments.source, arguments.electron_archive, arguments.electron_checksums, arguments.output, arguments.zh)


if __name__ == "__main__":
    main()

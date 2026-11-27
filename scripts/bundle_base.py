#!/usr/bin/env python3
"""Shared steps for building the isolated AGY Lab app."""

import hashlib
import plistlib
import re
import shutil
import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CHECKSUMS = PROJECT_ROOT / "build" / "source" / "electron-44.9.1-SHASUMS256.txt"
# Visible name only: the profile, keychain entries and URL scheme keep the "AGY Lab" identity.
DISPLAY_NAME = "Antigravity Lab"
BUNDLE_ID = "com.local.agy-lab"
OFFICIAL_REQUIREMENT = (
    '=identifier "com.google.antigravity" and anchor apple generic '
    'and certificate 1[field.1.2.840.113635.100.6.2.6] '
    'and certificate leaf[field.1.2.840.113635.100.6.1.13] '
    'and certificate leaf[subject.OU] = EQHXZ8M8AV'
)
TEAM_BOUND_ENTITLEMENTS = {
    "application-identifier",
    "com.apple.application-identifier",
    "com.apple.developer.team-identifier",
    "com.apple.security.application-groups",
    "keychain-access-groups",
}


def run(*args):
    subprocess.run([str(value) for value in args], check=True)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_electron_archive(archive, checksums):
    matches = []
    for line in checksums.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].lstrip("*") == archive.name:
            matches.append(fields[0])
    if len(matches) != 1:
        raise RuntimeError("Electron checksum manifest has no unique entry for the archive")
    if sha256_file(archive) != matches[0].lower():
        raise RuntimeError("Electron archive checksum does not match the official manifest")


def bundle_chinese(project, renderer_source, scratch, app_root):
    renderer = scratch / "renderer-main.js"
    renderer.write_text(renderer_source, encoding="utf-8")
    run("node", PROJECT_ROOT / "scripts" / "zh_bundle.mjs", project, renderer,
        app_root / "dist" / "lab" / "zh-runtime.js")


def find_asar():
    local_mjs = PROJECT_ROOT / "node_modules" / "@electron" / "asar" / "bin" / "asar.mjs"
    if local_mjs.is_file():
        node = shutil.which("node")
        if node:
            return [node, str(local_mjs)]
    local_bin = PROJECT_ROOT / "node_modules" / ".bin" / "asar"
    if local_bin.is_file():
        return [str(local_bin)]
    executable = shutil.which("asar")
    if executable:
        return [executable]
    raise RuntimeError(
        "The @electron/asar command is required to build the app. "
        "Run 'npm install' or install '@electron/asar' globally."
    )


def replace_once(text, expected, replacement, description):
    count = text.count(expected)
    if count != 1:
        raise RuntimeError(f"Unsupported runtime: expected one {description}, found {count}")
    return text.replace(expected, replacement, 1)


def update_file(path, transform):
    original = path.read_text(encoding="utf-8")
    path.write_text(transform(original), encoding="utf-8")


def patch_main(app_root):
    path = app_root / "dist" / "main.js"
    bootstrap = '''"use strict";
{
    const app = require("electron").app;
    if (process.platform === "win32") app.setAppUserModelId("com.local.agy-lab");
    const path = require("node:path");
    const fs = require("node:fs");
    const profile = path.join(app.getPath("appData"), "AGY Lab");
    const session = path.join(profile, "Session Data");
    const logs = path.join(profile, "logs");
    for (const dir of [profile, session, logs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    app.setName("AGY Lab");
    app.setPath("userData", profile);
    app.setPath("sessionData", session);
    app.setPath("logs", logs);
    require("./lab/main.cjs");
}
'''
    def transform(source):
        source = replace_once(source, '"use strict";\n', bootstrap, "main strict directive")
        source = replace_once(
            source,
            "        await (0, ideInstall_1.maybeShowIdeInstallWizard)(storageManager);",
            "        // The independent copy has no IDE data migration.",
            "IDE migration wizard",
        )
        source = replace_once(
            source,
            "const PROTOCOL = (0, signInReturn_1.protocolSchemeFor)(electron_1.app.getName());",
            "const PROTOCOL = 'agy-lab';",
            "protocol selection",
        )
        return replace_once(
            source,
            "        });\n        // The app menu bar isn't reachable on Windows (hidden title bar), so",
            "        });\n        if (process.platform === \"win32\") require('./lab/main.cjs').addTrayMenu(tray_1.insertTrayMenuItem);\n        // The app menu bar isn't reachable on Windows (hidden title bar), so",
            "Windows tray insertion point",
        )

    update_file(path, transform)


def patch_paths(app_root):
    path = app_root / "dist" / "paths.js"

    def transform(source):
        source = replace_once(
            source,
            """function getAppDataDirName() {
    if (!electron_1.app.isPackaged) {
        return 'antigravity-dev';
    }
    return electron_1.app.getName().toLowerCase().replace(/\\s+/g, '');
}""",
            "function getAppDataDirName() {\n    return 'agy-lab';\n}",
            "application data directory",
        )
        source = replace_once(
            source,
            "return path_1.default.join(os_1.default.homedir(), '.gemini', getAppDataDirName());",
            "return path_1.default.join(electron_1.app.getPath('userData'), 'gemini', getAppDataDirName());",
            "application data path",
        )
        return replace_once(
            source,
            "return path_1.default.join(os_1.default.homedir(), '.gemini', 'config', 'config.json');",
            "return path_1.default.join(electron_1.app.getPath('userData'), 'gemini', 'config', 'config.json');",
            "settings path",
        )

    update_file(path, transform)


def patch_language_server(app_root):
    path = app_root / "dist" / "languageServer.js"

    def transform(source):
        source = replace_once(
            source,
            "            '--enable_sidecars',",
            """            '--gemini_dir',
            labWsl ? labWsl.geminiDir : require("path").join(require("electron").app.getPath("userData"), "gemini"),
            '--config_dir',
            'config',
            '--enable_sidecars',""",
            "language-server argument list",
        )
        source = replace_once(
            source,
            "    const loginShellEnv = await shellEnvReads.take();",
            """    const loginShellEnv = await shellEnvReads.take();
    const labCloudEndpoint = await require('./lab/cloud-proxy.cjs').cloudEndpoint(lsDefaults_1.LS_CLOUD_CODE_ENDPOINT);
    const labWsl = wsl ? await require('./lab/wsl.cjs').prepareServer(wsl.distro, labCloudEndpoint, lsDefaults_1.LS_CLOUD_CODE_ENDPOINT) : null;""",
            "language-server startup",
        )
        source = replace_once(
            source,
            "            '--enable_sidecars',\n        ];",
            """            '--enable_sidecars',
        ];
        const labCloudFlag = args.indexOf('--cloud_code_endpoint');
        if (labCloudFlag < 0) throw new Error('Language server arguments have no Cloud Code endpoint');
        args[labCloudFlag + 1] = labWsl ? labWsl.cloudEndpoint : labCloudEndpoint;""",
            "language-server cloud endpoint",
        )
        source = replace_once(
            source,
            "        const env = { ...process.env, ...loginShellEnv };",
            """        const env = { ...process.env, ...loginShellEnv };
        env['ANTIGRAVITY_AUTH_SUCCESS_APP'] = 'agy-lab';""",
            "language-server environment",
        )
        return replace_once(
            source,
            "            (0, authBootstrap_1.appendWslAuthEnvForwarding)(env);",
            """            (0, authBootstrap_1.appendWslAuthEnvForwarding)(env);
            require('./lab/wsl.cjs').forwardEnv(env);""",
            "WSL environment forwarding",
        )

    update_file(path, transform)


def patch_wsl(app_root):
    path = app_root / "dist" / "wsl.js"

    def transform(source):
        source = replace_once(
            source,
            "    return `$HOME/.antigravity-server/bin/${version}`;",
            "    return require('./lab/wsl.cjs').installDir(version);",
            "WSL server install directory",
        )
        return replace_once(
            source,
            "    const override = process.env.ANTIGRAVITY_WSL_LS_PATH;",
            "    const override = require('./lab/wsl.cjs').bundledServer();",
            "WSL server binary override",
        )

    update_file(path, transform)


def patch_menu(app_root):
    path = app_root / "dist" / "menu.js"

    def transform(source):
        start = '    // Add "Check for Updates" to the application menu on macOS.\n'
        end = '    // Adds Docs to the Help menu.\n'
        if source.count(start) != 1 or source.count(end) != 1:
            raise RuntimeError("Unsupported runtime: updater menu is unrecognized")
        before, remainder = source.split(start, 1)
        _, after = remainder.split(end, 1)
        source = before + end + after
        marker = "    electron_1.Menu.setApplicationMenu(menu);"
        if source.count(marker) != 2:
            raise RuntimeError("Unsupported runtime: expected two application menu hooks")
        return source.replace(
            marker,
            "    require('./lab/main.cjs').addModelMenu(menu);\n" + marker,
        )

    update_file(path, transform)


def patch_updater(app_root):
    path = app_root / "dist" / "updater.js"
    functions = {
        "function initAutoUpdater(isHeadless, settingsService) {": "return;",
        "function checkForUpdates(isManual = false) {": "return;",
        "async function quitAndInstall(isSilent = false) {": "return;",
        "function applyHostUpdate() {": "return false;",
        "function headlessQuitAndInstall(downloadedFilePath) {": "return;",
    }

    def transform(source):
        for signature, guard in functions.items():
            source = replace_once(
                source,
                signature,
                signature + "\n    " + guard + " // This independent copy is rebuilt from a verified source.",
                "updater " + signature,
            )
        return source

    update_file(path, transform)


def install_lab(app_root, lab_dir):
    if not (lab_dir / "main.cjs").is_file():
        raise RuntimeError("Missing lab/main.cjs")
    shutil.copytree(lab_dir, app_root / "dist" / "lab", symlinks=False)
    patch_main(app_root)
    patch_paths(app_root)
    patch_language_server(app_root)
    patch_wsl(app_root)
    patch_menu(app_root)
    patch_updater(app_root)


def sign_item(original, target, entitlement_file):
    entitlements = subprocess.run(
        ["codesign", "-d", "--entitlements", "-", "--xml", str(original)],
        capture_output=True,
    )
    metadata = subprocess.run(
        ["codesign", "-d", "--verbose=2", str(original)],
        capture_output=True,
        text=True,
    )
    arguments = ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    flags = re.search(r"flags=0x([0-9a-fA-F]+)", metadata.stderr)
    if flags and int(flags.group(1), 16) & 0x10000:
        arguments.extend(["--options", "runtime"])
    if entitlements.returncode == 0 and entitlements.stdout.lstrip().startswith(b"<"):
        values = plistlib.loads(entitlements.stdout)
        for key in TEAM_BOUND_ENTITLEMENTS:
            values.pop(key, None)
        entitlement_file.write_bytes(plistlib.dumps(values))
        arguments.extend(["--entitlements", entitlement_file])
    run(*arguments, target)

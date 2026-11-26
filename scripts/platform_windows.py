#!/usr/bin/env python3
"""Build the Windows x64 AGY Lab directory from verified local inputs."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from bundle_base import PROJECT_ROOT, find_asar, install_lab, run
from bundle_login import patch_login, strip_pe_signature
from renderer_patch import patch_renderer


DEFAULT_SOURCE = Path.home() / "AppData" / "Local" / "Programs" / "antigravity"
DEFAULT_ARCHIVE = PROJECT_ROOT / "build" / "source" / "electron-v44.9.1-win32-x64.zip"
DEFAULT_CHECKSUMS = PROJECT_ROOT / "build" / "source" / "electron-44.9.1-SHASUMS256.txt"
DISPLAY_NAME = "Antigravity Lab"
DEFAULT_OUTPUT = PROJECT_ROOT / "dist" / DISPLAY_NAME
EXPECTED_ELECTRON_VERSION = "44.9.1"
# Digests recorded from installation trees produced by signature-valid Google LLC
# NSIS installers. The installed executables themselves are unsigned, so these
# hashes are the build-time provenance boundary together with the exact patch anchors.
WINDOWS_INPUT_SHA256 = {
    "2.35.1": {
        "app.asar": "9f0aad7274795d7fbde04931d96b348dcfc5f3d81d7373e6b70aeb09307442df",
        "app-update.yml": "7f5e7ecae74c2a2483979d085b39f59df66a908988d46d73dea8eefc038de2ba",
        "elevate.exe": "9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37",
        "bin/language_server.exe": "73ce9a2405b455a93d1f13db2ae555da50406110217a349b6dd85c377fbdb9d1",
    },
    "2.35.2": {
        "app.asar": "e057115571cf5085406d20f2427a5afac272b712ec84332c7157da0113d4b2d0",
        "app-update.yml": "7f5e7ecae74c2a2483979d085b39f59df66a908988d46d73dea8eefc038de2ba",
        "elevate.exe": "9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37",
        "bin/language_server.exe": "fcdf7454007c6edc8162e601628c28cc1e6f575be849f329bb864c41ba6e6b02",
    },
}
WINDOWS_UNPACKED_TREE_SHA256 = {
    "2.35.1": "6e7ec1d5d3ec795c1690199398b7f8f54527939fe96966de786fc54628f88ecb",
    "2.35.2": "6e7ec1d5d3ec795c1690199398b7f8f54527939fe96966de786fc54628f88ecb",
}


def verified_electron_archive(archive, checksums):
    matches = []
    for line in checksums.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].lstrip("*") == archive.name:
            matches.append(fields[0])
    if len(matches) != 1:
        raise RuntimeError("Electron checksum manifest has no unique entry for the archive")
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != matches[0].lower():
        raise RuntimeError("Electron archive checksum does not match the official manifest")


def powershell_quote(path):
    return "'" + str(path).replace("'", "''") + "'"


def installer_metadata(installer):
    quoted = powershell_quote(installer)
    command = (
        f"$path = {quoted};"
        "$item = Get-Item -LiteralPath $path;"
        "$signature = Get-AuthenticodeSignature -FilePath $item.FullName;"
        "$subject = ''; if ($signature.SignerCertificate) { $subject = $signature.SignerCertificate.Subject };"
        "[pscustomobject]@{"
        "Status=$signature.Status.ToString();"
        "Subject=$subject;"
        "ProductVersion=$item.VersionInfo.ProductVersion"
        "} | ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("Unable to inspect the Antigravity installer signature: " + result.stderr.strip())
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("PowerShell returned unrecognized installer signature metadata") from error


def validate_installer(installer, version):
    metadata = installer_metadata(installer)
    subject = metadata.get("Subject") or ""
    if metadata.get("Status") != "Valid" or "O=Google LLC" not in subject:
        raise RuntimeError(
            "The Antigravity installer must have a valid Google LLC signature "
            f"(status={metadata.get('Status')!r}, subject={subject!r})"
        )
    product_version = metadata.get("ProductVersion")
    if product_version != version:
        raise RuntimeError(f"Installer version {product_version!r} does not match installed Antigravity {version!r}")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_sha256(root):
    digest = hashlib.sha256()
    files = sorted(path for path in root.rglob("*") if path.is_file())
    for path in files:
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


def identify_verified_source(source):
    resources = source / "resources"
    archive_digest = sha256_file(resources / "app.asar")
    versions = [
        version for version, hashes in WINDOWS_INPUT_SHA256.items()
        if hashes["app.asar"] == archive_digest
    ]
    if len(versions) != 1:
        raise RuntimeError("resources\\app.asar does not match a supported official Windows x64 SHA-256")
    version = versions[0]
    expected = WINDOWS_INPUT_SHA256[version]
    for relative, expected_hash in expected.items():
        path = resources.joinpath(*relative.split("/"))
        display_path = relative.replace("/", "\\")
        if not path.is_file():
            raise RuntimeError(f"Missing official input file: resources\\{display_path}")
        actual = sha256_file(path)
        if actual != expected_hash:
            raise RuntimeError(
                f"resources\\{display_path} SHA-256 mismatch: "
                f"expected {expected_hash}, found {actual}"
            )
    bin_dir = resources / "bin"
    key_bin_files = sorted(
        item.name for item in bin_dir.iterdir()
        if item.is_file() and item.suffix.lower() in {".exe", ".cmd", ".bat", ".ps1", ".js"}
    )
    expected_bin_files = sorted(
        relative.split("/", 1)[1] for relative in expected if relative.startswith("bin/")
    )
    if key_bin_files != expected_bin_files:
        raise RuntimeError(
            "resources\\bin contains unexpected or missing key executable files: "
            f"expected {expected_bin_files}, found {key_bin_files}"
        )
    unpacked = resources / "app.asar.unpacked"
    if not unpacked.is_dir():
        raise RuntimeError("Missing official input directory: resources\\app.asar.unpacked")
    unpacked_digest = tree_sha256(unpacked)
    expected_unpacked_digest = WINDOWS_UNPACKED_TREE_SHA256[version]
    if unpacked_digest != expected_unpacked_digest:
        raise RuntimeError(
            "resources\\app.asar.unpacked SHA-256 tree mismatch: "
            f"expected {expected_unpacked_digest}, found {unpacked_digest}"
        )
    return version


def extract_zip_safely(archive, destination):
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as zip_file:
        for member in zip_file.infolist():
            target = (destination / member.filename).resolve()
            if not target.is_relative_to(destination):
                raise RuntimeError(f"Electron archive contains an unsafe path: {member.filename!r}")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zip_file.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def copy_tree(source, target):
    target.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        destination = target / item.name
        if item.is_dir():
            shutil.copytree(item, destination, symlinks=False, dirs_exist_ok=True)
        else:
            shutil.copy2(item, destination)


def bundle_chinese(project, renderer_source, scratch, app_root):
    renderer = scratch / "renderer-main.js"
    renderer.write_text(renderer_source, encoding="utf-8")
    run("node", PROJECT_ROOT / "scripts" / "zh_bundle.mjs", project, renderer,
        app_root / "dist" / "lab" / "zh-runtime.js")


def read_app_version(app_root):
    package_file = app_root / "package.json"
    package = json.loads(package_file.read_text(encoding="utf-8"))
    return package.get("version")


def build(source, archive, checksums, output, installer=None, zh_project=None):
    source = source.resolve(strict=True)
    archive = archive.resolve(strict=True)
    checksums = checksums.resolve(strict=True)
    output = output.resolve()
    if installer is not None:
        installer = installer.resolve(strict=True)
    if zh_project is not None:
        zh_project = zh_project.resolve(strict=True)
    dist = (PROJECT_ROOT / "dist").resolve()
    if not output.is_relative_to(dist):
        raise RuntimeError("The preview directory must be built inside the project's dist directory")
    if output.exists():
        raise RuntimeError(f"Output already exists: {output}")
    if not (source / "Antigravity.exe").is_file():
        raise RuntimeError("The source must be an installed Windows Antigravity directory")
    original_resources = source / "resources"
    original_server = original_resources / "bin" / "language_server.exe"
    if not original_server.is_file():
        raise RuntimeError("The source is missing resources\\bin\\language_server.exe")

    verified_electron_archive(archive, checksums)
    asar = find_asar()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".agy-preview-build-", dir=output.parent) as temporary:
        scratch = Path(temporary)
        app_root = scratch / "app"
        version = identify_verified_source(source)
        run(*asar, "extract", original_resources / "app.asar", app_root)
        package_version = read_app_version(app_root)
        if package_version != version:
            raise RuntimeError(f"app.asar package version {package_version!r} does not match verified source {version!r}")
        if installer is not None:
            validate_installer(installer, version)

        staged = scratch / output.name
        electron_extract = scratch / "electron"
        electron_extract.mkdir()
        extract_zip_safely(archive, electron_extract)
        electron_version_file = electron_extract / "version"
        electron_version = electron_version_file.read_text(encoding="ascii").strip()
        if electron_version not in {EXPECTED_ELECTRON_VERSION, "v" + EXPECTED_ELECTRON_VERSION}:
            raise RuntimeError(f"Expected Electron {EXPECTED_ELECTRON_VERSION}, found {electron_version!r}")
        copy_tree(electron_extract, staged)
        electron_exe = staged / "electron.exe"
        if not electron_exe.is_file():
            raise RuntimeError("Electron archive does not contain electron.exe")
        electron_exe.rename(staged / f"{DISPLAY_NAME}.exe")

        resources = staged / "resources"
        resources.mkdir(parents=True, exist_ok=True)
        default_app = resources / "default_app.asar"
        if default_app.exists():
            default_app.unlink()
        (resources / "bin").mkdir(parents=True, exist_ok=True)
        shutil.copy2(original_server, resources / "bin" / "language_server.exe")
        for name in ("app-update.yml", "elevate.exe"):
            shutil.copy2(original_resources / name, resources / name)

        install_lab(app_root, PROJECT_ROOT / "lab")
        package_file = app_root / "package.json"
        package = json.loads(package_file.read_text(encoding="utf-8"))
        package["productName"] = "AGY Lab"
        package_file.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        server = resources / "bin" / "language_server.exe"
        patch_login(server, platform="windows", arch="x64", version=version)
        renderer_source = patch_renderer(server)
        if zh_project is not None:
            bundle_chinese(zh_project, renderer_source, scratch, app_root)
        strip_pe_signature(server)
        run(*asar, "pack", app_root, resources / "app.asar", "--unpack-dir", "node_modules/chrome-devtools-mcp")
        staged.rename(output)
    print(f"Built {output}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--electron-archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--electron-checksums", type=Path, default=DEFAULT_CHECKSUMS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--installer",
        type=Path,
        help="optional official Antigravity Windows installer whose Google LLC signature is also verified",
    )
    parser.add_argument("--zh", type=Path, help="antigravity-zh checkout whose Chinese UI is built into the copy")
    arguments = parser.parse_args()
    build(
        arguments.source,
        arguments.electron_archive,
        arguments.electron_checksums,
        arguments.output,
        arguments.installer,
        arguments.zh,
    )


if __name__ == "__main__":
    main()

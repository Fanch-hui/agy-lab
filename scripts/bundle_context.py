#!/usr/bin/env python3
"""Lifts the language server's 256K compaction cap for catalogue models without a server override."""

import plistlib
from pathlib import Path

from bundle_base import SUPPORTED_VERSIONS


# utils.GetCheckpointConfig, Google-provider branch (2.35.1 and 2.35.2 share these bytes):
#   mov x4, #256000 ; cmp w3, w4 ; mov x4, #256000 ; csel x3, x3, x4, lo
# where w3 = maxTokens - max(maxOutputTokens, 40000). Replacing the csel with a nop keeps w3,
# so the compaction point follows the catalogue entry; Lab bounds maxTokens itself.
MACOS_CAP_OFFSET = 0x1468994
MACOS_CAP_CODE = bytes.fromhex("04009dd26400a0f27f00046b04009dd26400a0f26330849a")
MACOS_CSEL_OFFSET = MACOS_CAP_OFFSET + 20
ARM64_NOP = bytes.fromhex("1f2003d5")


def patch_context_cap(binary_path):
    """Patch a dist/ copy of the macOS language server, refusing unknown versions and layouts."""
    binary = Path(binary_path).resolve()
    dist = (Path(__file__).resolve().parent.parent / "dist").resolve()
    if not binary.is_relative_to(dist) or binary.name != "language_server":
        raise ValueError("the context cap patch only applies to a dist/ macOS language_server copy")
    with (binary.parent.parent.parent / "Info.plist").open("rb") as stream:
        version = plistlib.load(stream).get("CFBundleShortVersionString")
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"unsupported language server version: {version!r}")
    with binary.open("r+b") as stream:
        if stream.read(8) != bytes.fromhex("cffaedfe0c000001"):
            raise ValueError("expected an ARM64 Mach-O language server")
        stream.seek(MACOS_CAP_OFFSET)
        if stream.read(len(MACOS_CAP_CODE)) != MACOS_CAP_CODE:
            raise ValueError(f"unsupported checkpoint cap code at {MACOS_CAP_OFFSET:#x}")
        stream.seek(MACOS_CSEL_OFFSET)
        stream.write(ARM64_NOP)

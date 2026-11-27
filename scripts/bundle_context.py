#!/usr/bin/env python3
"""Lifts the language server's 256K compaction cap for catalogue models without a server override."""

import plistlib
from dataclasses import dataclass
from pathlib import Path

from bundle_login import PE64Image


# utils.GetCheckpointConfig, Google-provider branch (these bytes are shared, with 2.36.0 at its own offset):
#   mov x4, #256000 ; cmp w3, w4 ; mov x4, #256000 ; csel x3, x3, x4, lo
# where w3 = maxTokens - max(maxOutputTokens, 40000). Replacing the csel with a nop keeps w3,
# so the compaction point follows the catalogue entry; Lab bounds maxTokens itself.
MACOS_CAP_OFFSETS = {"2.35.1": 0x1468994, "2.35.2": 0x1468994, "2.36.0": 0x157B254}
MACOS_CAP_CODE = bytes.fromhex("04009dd26400a0f27f00046b04009dd26400a0f26330849a")
ARM64_NOP = bytes.fromhex("1f2003d5")
# mov esi, edx ; nop: the x64 cmovb selects into esi, unlike the ARM64 csel
# whose destination already contains the uncapped value. An unconditional copy
# plus padding is therefore the equal-length removal of the x64 selection step.
X64_CAP_REPLACEMENT = bytes.fromhex("8bf290")
WINDOWS_TARGET_FUNCTION = "google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig"


@dataclass(frozen=True)
class WindowsContextCapPatch:
    sequence_rva: int
    sequence_hex: str
    cap_rva: int
    original_hex: str


# utils.GetCheckpointConfig, Google-provider fallback branch:
#   mov edx, dword ptr [rsp + 0x4c]
#   cmp edx, 0x3e800
#   mov esi, 0x3e800
#   cmovb esi, edx
#   mov dword ptr [rsp + 0x50], esi
# edx is maxTokens - max(maxOutputTokens, 40000). The cmovb implements
# min(edx, 256000); replacing only that cmovb makes esi always receive edx
# without changing the later maxTokens<=0 default assignment of 256000.
WINDOWS_CAP_SEQUENCE_RVA = 0x183815E
WINDOWS_CAP_SEQUENCE = "8b54244c81fa00e80300be00e803000f42f289742450"
WINDOWS_CAP_RVA = 0x183816D
WINDOWS_CAP_ORIGINAL = "0f42f2"
WINDOWS_X64_CAP_PATCHES = {
    "2.35.1": WindowsContextCapPatch(
        sequence_rva=WINDOWS_CAP_SEQUENCE_RVA,
        sequence_hex=WINDOWS_CAP_SEQUENCE,
        cap_rva=WINDOWS_CAP_RVA,
        original_hex=WINDOWS_CAP_ORIGINAL,
    ),
    "2.35.2": WindowsContextCapPatch(
        sequence_rva=WINDOWS_CAP_SEQUENCE_RVA,
        sequence_hex=WINDOWS_CAP_SEQUENCE,
        cap_rva=WINDOWS_CAP_RVA,
        original_hex=WINDOWS_CAP_ORIGINAL,
    ),
}


def _patch_macos(binary):
    with (binary.parent.parent.parent / "Info.plist").open("rb") as stream:
        version = plistlib.load(stream).get("CFBundleShortVersionString")
    if version not in MACOS_CAP_OFFSETS:
        raise ValueError(f"unsupported language server version: {version!r}")
    cap_offset = MACOS_CAP_OFFSETS[version]
    with binary.open("r+b") as stream:
        if stream.read(8) != bytes.fromhex("cffaedfe0c000001"):
            raise ValueError("expected an ARM64 Mach-O language server")
        stream.seek(cap_offset)
        if stream.read(len(MACOS_CAP_CODE)) != MACOS_CAP_CODE:
            raise ValueError(f"unsupported checkpoint cap code at {cap_offset:#x}")
        stream.seek(cap_offset + 20)
        stream.write(ARM64_NOP)


def _patch_windows_x64(binary, version, patch=None):
    if version not in WINDOWS_X64_CAP_PATCHES:
        raise ValueError(f"unsupported language server version for Windows x64 context cap patch: {version!r}")
    if patch is None:
        patch = WINDOWS_X64_CAP_PATCHES[version]
    sequence = bytes.fromhex(patch.sequence_hex)
    original = bytes.fromhex(patch.original_hex)
    if len(original) != len(X64_CAP_REPLACEMENT):
        raise ValueError("internal Windows context cap patch must preserve the instruction length")
    sequence_offset = patch.cap_rva - patch.sequence_rva
    if sequence[sequence_offset:sequence_offset + len(original)] != original:
        raise ValueError("internal Windows context cap sequence does not contain the recorded original bytes")
    with binary.open("r+b") as stream:
        pe = PE64Image(stream)
        if pe.read_rva(patch.sequence_rva, len(sequence)) != sequence:
            raise ValueError(
                f"unsupported checkpoint cap code at {patch.sequence_rva:#x} in {WINDOWS_TARGET_FUNCTION}"
            )
        if pe.read_rva(patch.cap_rva, len(original)) != original:
            raise ValueError(
                f"unsupported checkpoint cap instruction at {patch.cap_rva:#x} in {WINDOWS_TARGET_FUNCTION}"
            )
        pe.write_rva(patch.cap_rva, X64_CAP_REPLACEMENT)


def patch_context_cap(binary_path, platform=None, arch=None, version=None):
    """Patch a dist/ copy of the language server, refusing unknown versions and layouts."""
    binary = Path(binary_path).resolve()
    dist = (Path(__file__).resolve().parent.parent / "dist").resolve()
    if not binary.is_relative_to(dist) or binary.name not in {"language_server", "language_server.exe"}:
        raise ValueError("the context cap patch only applies to a dist/ language server copy")
    if binary.name == "language_server":
        _patch_macos(binary)
        return
    if platform is None:
        platform = "windows"
    if arch is None:
        arch = "x64"
    if (platform, arch) != ("windows", "x64"):
        raise ValueError(f"unsupported context cap target: {(platform, arch)!r}")
    _patch_windows_x64(binary, version)

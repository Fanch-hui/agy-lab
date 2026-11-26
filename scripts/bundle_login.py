"""Isolate the desktop language server's credential storage.

The 2.35.1 and 2.35.2 servers share this layout byte for byte at every offset below.
"""

from pathlib import Path
import plistlib
import struct

from bundle_base import SUPPORTED_VERSIONS


IMAGE_BASE = 0x100000000
ACCOUNT_OFFSET = 0x789D590
FALLBACK_OFFSET = ACCOUNT_OFFSET + 12
PLUGIN_OFFSET = FALLBACK_OFFSET + 9
STORAGE_LITERALS = b"agy-lab-001\0.agy-lab\0agy-lab-001.plugins\0"

# These instruction sequences load storage names only. The adjacent length
# operands stay unchanged except for the seven-to-eight character fallback dir.
LOADS = (
    (0x27FA254, "437000d063082f91610180d2", 3, ACCOUNT_OFFSET, None),
    (0x2416818, "638c00f063142591e40b40b2", 3, FALLBACK_OFFSET, 4),
    (0x23EB530, "c58d00d0a5142591e60b40b2", 5, FALLBACK_OFFSET, 6),
    (0x0DA81D4, "e342019063082f91640180d2", 3, ACCOUNT_OFFSET, None),
    (0x0DA9288, "c34201f063082f91640180d2", 3, ACCOUNT_OFFSET, None),
    (0x0DA76EC, "2248019042482191630280d2", 2, PLUGIN_OFFSET, None),
    (0x0DA7740, "2448019084482191650280d2", 4, PLUGIN_OFFSET, None),
    (0x0DA779C, "2248019042482191630280d2", 2, PLUGIN_OFFSET, None),
)


def _load_address(instruction_offset, target_offset, register):
    instruction_page = (IMAGE_BASE + instruction_offset) >> 12
    target_address = IMAGE_BASE + target_offset
    page_delta = (target_address >> 12) - instruction_page
    if not -(1 << 20) <= page_delta < (1 << 20):
        raise ValueError("credential storage literal is outside ADRP range")
    immediate = page_delta & 0x1FFFFF
    adrp = 0x90000000 | ((immediate & 3) << 29) | ((immediate >> 2) << 5) | register
    add = 0x91000000 | ((target_address & 0xFFF) << 10) | (register << 5) | register
    return struct.pack("<II", adrp, add)


def patch_login(binary_path):
    """Patch a copied desktop binary, refusing unknown versions and layouts."""
    binary = Path(binary_path).resolve()
    dist = (Path(__file__).resolve().parent.parent / "dist").resolve()
    if not binary.is_relative_to(dist) or binary.name != "language_server":
        raise ValueError("credential isolation only applies to a dist/ copy")
    contents = binary.parent.parent.parent
    with (contents / "Info.plist").open("rb") as stream:
        version = plistlib.load(stream).get("CFBundleShortVersionString")
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"unsupported language server version: {version!r}")

    with binary.open("r+b") as stream:
        header = stream.read(8)
        if header != bytes.fromhex("cffaedfe0c000001"):
            raise ValueError("expected an ARM64 Mach-O language server")
        stream.seek(ACCOUNT_OFFSET - 1)
        if stream.read(49) != bytes(49):
            raise ValueError("credential storage literal region is not empty")
        stream.seek(0x3604BC2)
        if stream.read(11) != b"antigravity":
            raise ValueError("unexpected native credential storage name")
        stream.seek(0x36AB852)
        if stream.read(19) != b"antigravity.plugins":
            raise ValueError("unexpected native plugin storage name")
        for offset, expected, _, _, _ in LOADS:
            stream.seek(offset)
            if stream.read(12) != bytes.fromhex(expected):
                raise ValueError(f"unsupported credential storage code at {offset:#x}")

        stream.seek(ACCOUNT_OFFSET)
        stream.write(STORAGE_LITERALS)
        for offset, _, register, literal_offset, length_register in LOADS:
            stream.seek(offset)
            stream.write(_load_address(offset, literal_offset, register))
            if length_register is not None:
                stream.write(struct.pack("<I", 0xD2800100 | length_register))

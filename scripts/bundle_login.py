"""Isolate the desktop language server's credential storage.

The macOS 2.35.1 and 2.35.2 servers share the Mach-O layout byte for byte at
every offset below. The Windows x64 servers for those versions likewise share
the PE64 layout used by the Windows patch table.
"""

from dataclasses import dataclass
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


@dataclass(frozen=True)
class WindowsLeaPatch:
    rva: int
    expected_hex: str
    literal: str
    function: str


@dataclass(frozen=True)
class WindowsLengthPatch:
    rva: int
    expected_hex: str
    immediate_offset: int
    function: str


@dataclass(frozen=True)
class WindowsLayout:
    cave_rva: int
    account_rva: int
    fallback_rva: int
    plugin_rva: int
    original_account_rva: int
    original_fallback_rva: int
    original_plugin_rva: int
    loads: tuple[WindowsLeaPatch, ...]
    length_loads: tuple[WindowsLengthPatch, ...]


# File offset 0x4dd3260 / RVA 0x4dd4a60 is inside a long zero-filled alignment
# region in .rdata in both supported Windows x64 language servers.
WINDOWS_CAVE_RVA = 0x4DD4A60
WINDOWS_ACCOUNT_RVA = WINDOWS_CAVE_RVA
WINDOWS_FALLBACK_RVA = WINDOWS_ACCOUNT_RVA + 12
WINDOWS_PLUGIN_RVA = WINDOWS_FALLBACK_RVA + 9
WINDOWS_ORIGINAL_ACCOUNT_RVA = 0x3DEA75E
WINDOWS_ORIGINAL_FALLBACK_RVA = 0x3D8B201
WINDOWS_ORIGINAL_PLUGIN_RVA = 0x3E92D39

WINDOWS_X64_LAYOUT = WindowsLayout(
    cave_rva=WINDOWS_CAVE_RVA,
    account_rva=WINDOWS_ACCOUNT_RVA,
    fallback_rva=WINDOWS_FALLBACK_RVA,
    plugin_rva=WINDOWS_PLUGIN_RVA,
    original_account_rva=WINDOWS_ORIGINAL_ACCOUNT_RVA,
    original_fallback_rva=WINDOWS_ORIGINAL_FALLBACK_RVA,
    original_plugin_rva=WINDOWS_ORIGINAL_PLUGIN_RVA,
    loads=(
        WindowsLeaPatch(0x10533E6, "488d157173d902", "account", "authstore.pluginFallbackPath"),
        WindowsLeaPatch(0x1054611, "488d154661d902", "account", "authstore.scopeFilePath"),
        WindowsLeaPatch(0x2B1FF59, "488d15a1b22601", "fallback", "codeassistclient.DefaultKeyringMarkerPath"),
        WindowsLeaPatch(0x2B532A6, "488d15547f2301", "fallback", "codeassistclient.NewFileTokenStorage"),
        WindowsLeaPatch(0x1052753, "488d0ddf05e402", "plugin", "authstore.pluginKeychain.Get"),
        WindowsLeaPatch(0x10527B8, "488d357a05e402", "plugin", "authstore.pluginKeychain.Set"),
        WindowsLeaPatch(0x1052813, "488d0d1f05e402", "plugin", "authstore.pluginKeychain.Delete"),
        WindowsLeaPatch(0x1053039, "488d1df9fce302", "plugin", "authstore.keychainAvailable"),
        WindowsLeaPatch(0x1055CBE, "488d0d74d0e302", "plugin", "authstore.(*pluginKeychain).Delete"),
        WindowsLeaPatch(0x1055D1E, "488d0d14d0e302", "plugin", "authstore.(*pluginKeychain).Get"),
        WindowsLeaPatch(0x1055D89, "488d35a9cfe302", "plugin", "authstore.(*pluginKeychain).Set"),
    ),
    length_loads=(
        WindowsLengthPatch(
            0x2B1FF4D,
            "48c78424b000000007000000",
            8,
            "codeassistclient.DefaultKeyringMarkerPath",
        ),
        WindowsLengthPatch(
            0x2B5329D,
            "48c744245007000000",
            5,
            "codeassistclient.NewFileTokenStorage",
        ),
    ),
)


class PE64Image:
    def __init__(self, stream):
        self.stream = stream
        stream.seek(0)
        if stream.read(2) != b"MZ":
            raise ValueError("expected a PE32+ x86-64 language server")
        stream.seek(0x3C)
        self.pe_offset = struct.unpack("<I", stream.read(4))[0]
        stream.seek(self.pe_offset)
        if stream.read(4) != b"PE\0\0":
            raise ValueError("expected a PE32+ x86-64 language server")
        header = stream.read(20)
        machine, section_count, _, _, _, optional_size, _ = struct.unpack("<HHIIIHH", header)
        self.optional_offset = self.pe_offset + 24
        stream.seek(self.optional_offset)
        magic = struct.unpack("<H", stream.read(2))[0]
        if machine != 0x8664 or magic != 0x20B:
            raise ValueError("expected a PE32+ x86-64 language server")
        self.section_count = section_count
        self.section_table_offset = self.optional_offset + optional_size
        self.checksum_offset = self.optional_offset + 64
        self.certificate_directory_offset = self.optional_offset + 112 + 4 * 8
        self.sections = []
        stream.seek(self.section_table_offset)
        for _ in range(section_count):
            raw = stream.read(40)
            if len(raw) != 40:
                raise ValueError("truncated PE section table")
            name = raw[:8].rstrip(b"\0").decode("ascii", "replace")
            virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from("<IIII", raw, 8)
            self.sections.append((name, virtual_address, virtual_size, raw_offset, raw_size))

    def rva_to_offset(self, rva):
        for _, virtual_address, virtual_size, raw_offset, raw_size in self.sections:
            span = max(virtual_size, raw_size)
            if virtual_address <= rva < virtual_address + span:
                delta = rva - virtual_address
                if delta >= raw_size:
                    raise ValueError(f"RVA {rva:#x} is outside the file-backed part of its section")
                return raw_offset + delta
        raise ValueError(f"RVA {rva:#x} is not mapped by the PE section table")

    def read_rva(self, rva, size):
        self.stream.seek(self.rva_to_offset(rva))
        return self.stream.read(size)

    def write_rva(self, rva, data):
        self.stream.seek(self.rva_to_offset(rva))
        self.stream.write(data)


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


def _patch_macos(binary):
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


def _windows_targets(layout):
    return {
        "account": layout.account_rva,
        "fallback": layout.fallback_rva,
        "plugin": layout.plugin_rva,
    }


def _patch_windows_x64(binary, version, layout=WINDOWS_X64_LAYOUT):
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"unsupported language server version: {version!r}")
    with binary.open("r+b") as stream:
        pe = PE64Image(stream)
        if pe.read_rva(layout.cave_rva - 1, 49) != bytes(49):
            raise ValueError("credential storage literal region is not empty")
        originals = (
            (layout.original_account_rva, b"antigravity", "native credential storage name"),
            (layout.original_fallback_rva, b".gemini", "native credential fallback directory"),
            (layout.original_plugin_rva, b"antigravity.plugins", "native plugin storage name"),
        )
        for rva, expected, description in originals:
            if pe.read_rva(rva, len(expected)) != expected:
                raise ValueError(f"unexpected {description}")
        targets = _windows_targets(layout)
        for patch in layout.loads:
            expected = bytes.fromhex(patch.expected_hex)
            if len(expected) != 7:
                raise ValueError("internal Windows LEA patch template must be seven bytes")
            if pe.read_rva(patch.rva, 7) != expected:
                raise ValueError(f"unsupported credential storage code at {patch.rva:#x} in {patch.function}")
            old_target = patch.rva + 7 + struct.unpack_from("<i", expected, 3)[0]
            expected_original = {
                "account": layout.original_account_rva,
                "fallback": layout.original_fallback_rva,
                "plugin": layout.original_plugin_rva,
            }[patch.literal]
            if old_target != expected_original:
                raise ValueError(f"internal Windows LEA patch template has the wrong target at {patch.rva:#x}")
        for patch in layout.length_loads:
            expected = bytes.fromhex(patch.expected_hex)
            if pe.read_rva(patch.rva, len(expected)) != expected:
                raise ValueError(f"unsupported credential storage length code at {patch.rva:#x} in {patch.function}")
            if expected[patch.immediate_offset:patch.immediate_offset + 4] != struct.pack("<I", 7):
                raise ValueError("internal Windows length patch template does not contain length seven")

        pe.write_rva(layout.cave_rva, STORAGE_LITERALS)
        for patch in layout.loads:
            target = targets[patch.literal]
            displacement = target - (patch.rva + 7)
            if not -(1 << 31) <= displacement < (1 << 31):
                raise ValueError(f"credential storage literal is outside RIP-relative range at {patch.rva:#x}")
            pe.write_rva(patch.rva + 3, struct.pack("<i", displacement))
        for patch in layout.length_loads:
            pe.write_rva(patch.rva + patch.immediate_offset, struct.pack("<I", 8))


def patch_login(binary_path, platform=None, arch=None, version=None):
    """Patch a copied desktop binary, refusing unknown versions and layouts."""
    binary = Path(binary_path).resolve()
    dist = (Path(__file__).resolve().parent.parent / "dist").resolve()
    if not binary.is_relative_to(dist) or binary.name not in {"language_server", "language_server.exe"}:
        raise ValueError("credential isolation only applies to a dist/ copy")
    if binary.name == "language_server":
        _patch_macos(binary)
        return
    if platform is None:
        platform = "windows"
    if arch is None:
        arch = "x64"
    if (platform, arch) != ("windows", "x64"):
        raise ValueError(f"unsupported credential isolation target: {(platform, arch)!r}")
    _patch_windows_x64(binary, version)


def strip_pe_signature(binary_path):
    """Remove a trailing Authenticode certificate and the stale PE checksum."""
    binary = Path(binary_path).resolve()
    dist = (Path(__file__).resolve().parent.parent / "dist").resolve()
    if not binary.is_relative_to(dist) or binary.name != "language_server.exe":
        raise ValueError("PE signature cleanup only applies to a dist/ language_server.exe copy")
    with binary.open("r+b") as stream:
        pe = PE64Image(stream)
        stream.seek(0, 2)
        file_size = stream.tell()
        stream.seek(pe.certificate_directory_offset)
        certificate_offset, certificate_size = struct.unpack("<II", stream.read(8))
        if certificate_size == 0:
            return
        if certificate_offset + certificate_size != file_size or certificate_offset >= file_size:
            raise ValueError("PE certificate table does not describe a trailing signature block")
        stream.seek(pe.certificate_directory_offset)
        stream.write(bytes(8))
        stream.truncate(certificate_offset)
        stream.seek(pe.checksum_offset)
        stream.write(bytes(4))

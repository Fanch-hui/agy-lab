"""Isolate the desktop language server's credential storage.

The macOS 2.35.1 and 2.35.2 servers share one Mach-O layout; 2.36.0 has its
own. The Windows x64 2.35.1 and 2.35.2 servers share one PE64 layout; 2.36.0
has its own.
"""

from dataclasses import dataclass
from pathlib import Path
import plistlib
import struct

IMAGE_BASE = 0x100000000
STORAGE_LITERALS = b"agy-lab-001\0.agy-lab\0agy-lab-001.plugins\0"


@dataclass(frozen=True)
class MacLoad:
    offset: int
    expected_hex: str
    register: int
    literal: str
    length_register: int | None = None


@dataclass(frozen=True)
class MacLayout:
    cave_offset: int
    native_account_offset: int
    native_fallback_offset: int
    native_plugin_offset: int
    loads: tuple[MacLoad, ...]


# These instruction sequences load storage names only. The adjacent length
# operands stay unchanged except for the seven-to-eight character fallback dir.
MACOS_2_35 = MacLayout(
    cave_offset=0x789D590,
    native_account_offset=0x3604BC2,
    native_fallback_offset=0x35A5945,
    native_plugin_offset=0x36AB852,
    loads=(
        MacLoad(0x27FA254, "437000d063082f91610180d2", 3, "account"),
        MacLoad(0x2416818, "638c00f063142591e40b40b2", 3, "fallback", 4),
        MacLoad(0x23EB530, "c58d00d0a5142591e60b40b2", 5, "fallback", 6),
        MacLoad(0x0DA81D4, "e342019063082f91640180d2", 3, "account"),
        MacLoad(0x0DA9288, "c34201f063082f91640180d2", 3, "account"),
        MacLoad(0x0DA76EC, "2248019042482191630280d2", 2, "plugin"),
        MacLoad(0x0DA7740, "2448019084482191650280d2", 4, "plugin"),
        MacLoad(0x0DA779C, "2248019042482191630280d2", 2, "plugin"),
    ),
)

# The 2.36.0 cave is the zero padding after __eh_frame at the end of __TEXT;
# the 2.35 gap between __cstring and __const shrank to 32 bytes.
MACOS_2_36 = MacLayout(
    cave_offset=0x7AC3D40,
    native_account_offset=0x3562232,
    native_fallback_offset=0x3502B12,
    native_plugin_offset=0x360A380,
    loads=(
        MacLoad(0x296B184, "a35f00f063c80891610180d2", 3, "account"),
        MacLoad(0x25D5228, "637900b063482c91e40b40b2", 3, "fallback", 4),
        MacLoad(0x25A31C0, "e57a00f0a5482c91e60b40b2", 5, "fallback", 6),
        MacLoad(0x0EA51E4, "e33501b063c80891640180d2", 3, "account"),
        MacLoad(0x0EA6298, "e335019063c80891640180d2", 3, "account"),
        MacLoad(0x0EA46FC, "223b01d042000e91630280d2", 2, "plugin"),
        MacLoad(0x0EA4750, "243b01d084000e91650280d2", 4, "plugin"),
        MacLoad(0x0EA47AC, "223b01d042000e91630280d2", 2, "plugin"),
    ),
)

MACOS_LAYOUTS = {
    "2.35.1": MACOS_2_35,
    "2.35.2": MACOS_2_35,
    "2.36.0": MACOS_2_36,
}


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
WINDOWS_X64_2_35 = WindowsLayout(
    cave_rva=0x4DD4A60,
    account_rva=0x4DD4A60,
    fallback_rva=0x4DD4A6C,
    plugin_rva=0x4DD4A75,
    original_account_rva=0x3DEA75E,
    original_fallback_rva=0x3D8B201,
    original_plugin_rva=0x3E92D39,
    loads=(
        WindowsLeaPatch(0x30508F7, "488d15609ed900", "account", "authclient.NewAuthClient"),
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

# The 2.36.0 storage names go in the zero slack between the section table
# (ends at file offset 0x3B0) and SizeOfHeaders (0x600), which the loader maps
# read-only at the image base; the long zero run in .rdata is a real zero-valued
# Go object (referenced by mldsa signing), not padding.
WINDOWS_X64_2_36 = WindowsLayout(
    cave_rva=0x400,
    account_rva=0x400,
    fallback_rva=0x40C,
    plugin_rva=0x415,
    original_account_rva=0x403DD64,
    original_fallback_rva=0x3FDE340,
    original_plugin_rva=0x40E7936,
    loads=(
        WindowsLeaPatch(0x3213057, "488d1506ade200", "account", "authclient.NewAuthClient"),
        WindowsLeaPatch(0x11C8646, "488d151757e702", "account", "authstore.pluginFallbackPath"),
        WindowsLeaPatch(0x11C9871, "488d15ec44e702", "account", "authstore.scopeFilePath"),
        WindowsLeaPatch(0x2D69E39, "488d1500452701", "fallback", "codeassistclient.DefaultKeyringMarkerPath"),
        WindowsLeaPatch(0x2DA5CC6, "488d1573862301", "fallback", "codeassistclient.NewFileTokenStorage"),
        WindowsLeaPatch(0x11C79B3, "488d0d7cfff102", "plugin", "authstore.pluginKeychain.Get"),
        WindowsLeaPatch(0x11C7A18, "488d3517fff102", "plugin", "authstore.pluginKeychain.Set"),
        WindowsLeaPatch(0x11C7A73, "488d0dbcfef102", "plugin", "authstore.pluginKeychain.Delete"),
        WindowsLeaPatch(0x11C8299, "488d1d96f6f102", "plugin", "authstore.keychainAvailable"),
        WindowsLeaPatch(0x11CAF1E, "488d0d11caf102", "plugin", "authstore.(*pluginKeychain).Delete"),
        WindowsLeaPatch(0x11CAF7E, "488d0db1c9f102", "plugin", "authstore.(*pluginKeychain).Get"),
        WindowsLeaPatch(0x11CAFE9, "488d3546c9f102", "plugin", "authstore.(*pluginKeychain).Set"),
    ),
    length_loads=(
        WindowsLengthPatch(
            0x2D69E2D,
            "48c78424b000000007000000",
            8,
            "codeassistclient.DefaultKeyringMarkerPath",
        ),
        WindowsLengthPatch(
            0x2DA5CBD,
            "48c744245007000000",
            5,
            "codeassistclient.NewFileTokenStorage",
        ),
    ),
)

WINDOWS_X64_LAYOUTS = {
    "2.35.1": WINDOWS_X64_2_35,
    "2.35.2": WINDOWS_X64_2_35,
    "2.36.0": WINDOWS_X64_2_36,
}


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
        optional = stream.read(optional_size)
        if len(optional) != optional_size or optional_size < 112:
            raise ValueError("truncated PE32+ optional header")
        magic = struct.unpack_from("<H", optional)[0]
        if machine != 0x8664 or magic != 0x20B:
            raise ValueError("expected a PE32+ x86-64 language server")
        self.section_count = section_count
        self.section_table_offset = self.optional_offset + optional_size
        self.checksum_offset = self.optional_offset + 64
        self.size_of_headers = struct.unpack_from("<I", optional, 60)[0]
        directory_count = struct.unpack_from("<I", optional, 108)[0]
        self.certificate_directory_offset = None
        if optional_size >= 152 and directory_count > 4:
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
        if rva < self.size_of_headers:
            return rva
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


def _macos_literal_targets(layout):
    return {
        "account": layout.cave_offset,
        "fallback": layout.cave_offset + 12,
        "plugin": layout.cave_offset + 21,
    }


def _patch_macos(binary):
    contents = binary.parent.parent.parent
    with (contents / "Info.plist").open("rb") as stream:
        version = plistlib.load(stream).get("CFBundleShortVersionString")
    if version not in MACOS_LAYOUTS:
        raise ValueError(f"unsupported language server version: {version!r}")
    layout = MACOS_LAYOUTS[version]

    with binary.open("r+b") as stream:
        header = stream.read(8)
        if header != bytes.fromhex("cffaedfe0c000001"):
            raise ValueError("expected an ARM64 Mach-O language server")
        stream.seek(layout.cave_offset - 1)
        if stream.read(49) != bytes(49):
            raise ValueError("credential storage literal region is not empty")
        native_literals = (
            (layout.native_account_offset, b"antigravity", "native credential storage name"),
            (layout.native_fallback_offset, b".gemini", "native credential fallback directory"),
            (layout.native_plugin_offset, b"antigravity.plugins", "native plugin storage name"),
        )
        for offset, expected, description in native_literals:
            stream.seek(offset)
            if stream.read(len(expected)) != expected:
                raise ValueError(f"unexpected {description}")
        for load in layout.loads:
            stream.seek(load.offset)
            if stream.read(12) != bytes.fromhex(load.expected_hex):
                raise ValueError(f"unsupported credential storage code at {load.offset:#x}")

        stream.seek(layout.cave_offset)
        stream.write(STORAGE_LITERALS)
        targets = _macos_literal_targets(layout)
        for load in layout.loads:
            stream.seek(load.offset)
            stream.write(_load_address(load.offset, targets[load.literal], load.register))
            if load.length_register is not None:
                stream.write(struct.pack("<I", 0xD2800100 | load.length_register))


def _windows_targets(layout):
    return {
        "account": layout.account_rva,
        "fallback": layout.fallback_rva,
        "plugin": layout.plugin_rva,
    }


def _patch_windows_x64(binary, version, layout=None):
    if version not in WINDOWS_X64_LAYOUTS:
        raise ValueError(f"unsupported language server version: {version!r}")
    if layout is None:
        layout = WINDOWS_X64_LAYOUTS[version]
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
        if pe.certificate_directory_offset is None:
            return
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

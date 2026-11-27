"""Patch the Linux x64 language server bundled for WSL workspaces."""

import struct
from pathlib import Path

from bundle_base import PROJECT_ROOT
from bundle_context import (
    WINDOWS_CAP_ORIGINAL,
    WINDOWS_CAP_SEQUENCE,
    WINDOWS_TARGET_FUNCTION,
    X64ContextCapPatch,
    patch_x64_cap,
)
from bundle_login import X64Layout, X64LeaPatch, X64LengthPatch, patch_x64_layout


WSL_SERVER_NAME = "language_server-linux-x64"
WSL_SERVER_SHA256 = {"2.36.0": "d76a6d8b8d798799f4e4cf0a99bc6a39352f4e929b649271acb3e3efd76a902d"}


class ElfX64Image:
    def __init__(self, stream):
        self.stream = stream
        stream.seek(0)
        header = stream.read(64)
        if len(header) != 64 or header[:4] != b"\x7fELF" or header[4] != 2 or header[5] != 1:
            raise ValueError("expected a 64-bit little-endian ELF language server")
        if struct.unpack_from("<H", header, 18)[0] != 62:
            raise ValueError("expected an x86-64 ELF language server")
        program_offset = struct.unpack_from("<Q", header, 32)[0]
        entry_size, program_count = struct.unpack_from("<HH", header, 54)
        if entry_size < 56 or program_count == 0:
            raise ValueError("truncated ELF program header table")
        self.filesz = None
        for index in range(program_count):
            stream.seek(program_offset + index * entry_size)
            program = stream.read(56)
            if len(program) != 56:
                raise ValueError("truncated ELF program header table")
            program_type = struct.unpack_from("<I", program)[0]
            if program_type != 1:
                continue
            offset = struct.unpack_from("<Q", program, 8)[0]
            vaddr = struct.unpack_from("<Q", program, 16)[0]
            filesz = struct.unpack_from("<Q", program, 32)[0]
            if offset != 0 or vaddr != 0:
                raise ValueError("expected the first ELF PT_LOAD to map file offset zero at virtual address zero")
            self.filesz = filesz
            break
        if self.filesz is None:
            raise ValueError("expected an ELF PT_LOAD segment")

    def check_range(self, rva, size):
        if rva < 0 or rva + size > self.filesz:
            raise ValueError(f"ELF file range {rva:#x}+{size:#x} is outside the first PT_LOAD")

    def read_rva(self, rva, size):
        self.check_range(rva, size)
        self.stream.seek(rva)
        return self.stream.read(size)

    def write_rva(self, rva, data):
        self.check_range(rva, len(data))
        self.stream.seek(rva)
        self.stream.write(data)


# The cave is inside the 921-byte run of 0xCC trap padding the linker emits
# before the page boundary at 0x910D000.
LINUX_X64_LAYOUTS = {
    "2.36.0": X64Layout(
        cave_rva=0x910CD00,
        account_rva=0x910CD00,
        fallback_rva=0x910CD0C,
        plugin_rva=0x910CD15,
        original_account_rva=0x4EFAAD4,
        original_fallback_rva=0x4E9AEF8,
        original_plugin_rva=0x4FA303F,
        loads=(
            X64LeaPatch(0x87FA5D7, "488d15f60470fc", "account", "authclient.NewAuthClient"),
            X64LeaPatch(0x687C726, "488d15a7e367fe", "account", "authstore.pluginFallbackPath"),
            X64LeaPatch(0x687D971, "488d155cd167fe", "account", "authstore.scopeFilePath"),
            X64LeaPatch(0x83B7A40, "488d15b134aefc", "fallback", "codeassistclient.DefaultKeyringMarkerPath"),
            X64LeaPatch(0x83F39A6, "488d154b75aafc", "fallback", "codeassistclient.NewFileTokenStorage"),
            X64LeaPatch(0x687BA93, "488d0da57572fe", "plugin", "authstore.pluginKeychain.Get"),
            X64LeaPatch(0x687BAF8, "488d35407572fe", "plugin", "authstore.pluginKeychain.Set"),
            X64LeaPatch(0x687BB53, "488d0de57472fe", "plugin", "authstore.pluginKeychain.Delete"),
            X64LeaPatch(0x687C379, "488d1dbf6c72fe", "plugin", "authstore.keychainAvailable"),
            X64LeaPatch(0x687F05E, "488d0dda3f72fe", "plugin", "authstore.(*pluginKeychain).Delete"),
            X64LeaPatch(0x687F0BE, "488d0d7a3f72fe", "plugin", "authstore.(*pluginKeychain).Get"),
            X64LeaPatch(0x687F129, "488d350f3f72fe", "plugin", "authstore.(*pluginKeychain).Set"),
        ),
        length_loads=(
            X64LengthPatch(
                0x83B7A37,
                "48c744247007000000",
                5,
                "codeassistclient.DefaultKeyringMarkerPath",
            ),
            X64LengthPatch(
                0x83F399D,
                "48c744245007000000",
                5,
                "codeassistclient.NewFileTokenStorage",
            ),
        ),
    ),
}

LINUX_X64_CAP_PATCHES = {
    "2.36.0": X64ContextCapPatch(
        sequence_rva=0x70766BE,
        sequence_hex=WINDOWS_CAP_SEQUENCE,
        cap_rva=0x70766CD,
        original_hex=WINDOWS_CAP_ORIGINAL,
    ),
}


def patch_wsl_server(binary_path, version):
    binary = Path(binary_path).resolve()
    dist = (PROJECT_ROOT / "dist").resolve()
    if not binary.is_relative_to(dist) or binary.name != WSL_SERVER_NAME:
        raise ValueError("the WSL server patch only applies to a dist/ language_server-linux-x64 copy")
    if version not in LINUX_X64_LAYOUTS:
        raise ValueError(f"unsupported language server version: {version!r}")
    with binary.open("r+b") as stream:
        image = ElfX64Image(stream)
        patch_x64_layout(image, LINUX_X64_LAYOUTS[version], empty_byte=0xCC)
        patch_x64_cap(image, LINUX_X64_CAP_PATCHES[version], WINDOWS_TARGET_FUNCTION)

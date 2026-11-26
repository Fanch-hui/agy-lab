import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from bundle_login import (  # noqa: E402
    PE64Image,
    STORAGE_LITERALS,
    WINDOWS_X64_LAYOUT,
    WindowsLayout,
    WindowsLeaPatch,
    WindowsLengthPatch,
    _patch_windows_x64,
    strip_pe_signature,
)


def lea(target_rva, instruction_rva, register_byte=0x15):
    displacement = target_rva - (instruction_rva + 7)
    return bytes((0x48, 0x8D, register_byte)) + struct.pack("<i", displacement)


def write_rva(data, rva, payload):
    if 0x1000 <= rva < 0x1200:
        offset = 0x200 + rva - 0x1000
    elif 0x3000 <= rva < 0x3200:
        offset = 0x400 + rva - 0x3000
    else:
        raise ValueError(rva)
    data[offset:offset + len(payload)] = payload


def make_pe(certificate=False):
    data = bytearray(0x600)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", data, 0x84, 0x8664, 2, 0, 0, 0, 0xF0, 0)
    optional = 0x98
    struct.pack_into("<H", data, optional, 0x20B)
    struct.pack_into("<I", data, optional + 64, 0x12345678)
    struct.pack_into("<I", data, optional + 108, 16)
    section_table = optional + 0xF0

    def section(index, name, rva, raw_offset):
        offset = section_table + index * 40
        data[offset:offset + 8] = name.ljust(8, b"\0")
        struct.pack_into("<IIII", data, offset + 8, 0x200, rva, 0x200, raw_offset)

    section(0, b".text", 0x1000, 0x200)
    section(1, b".rdata", 0x3000, 0x400)
    if certificate:
        certificate_offset = len(data)
        payload = b"CERTIFICATE-TEST!"
        struct.pack_into("<II", data, optional + 112 + 4 * 8, certificate_offset, len(payload))
        data.extend(payload)
    return data


def synthetic_layout():
    account = 0x3010
    fallback = 0x3020
    plugin = 0x3030
    loads = (
        WindowsLeaPatch(0x1010, lea(account, 0x1010).hex(), "account", "synthetic.account"),
        WindowsLeaPatch(0x1020, lea(fallback, 0x1020).hex(), "fallback", "synthetic.fallback"),
        WindowsLeaPatch(0x1030, lea(plugin, 0x1030).hex(), "plugin", "synthetic.plugin"),
    )
    length = WindowsLengthPatch(0x1040, "48c744245007000000", 5, "synthetic.length")
    return WindowsLayout(
        cave_rva=0x3080,
        account_rva=0x3080,
        fallback_rva=0x308C,
        plugin_rva=0x3095,
        original_account_rva=account,
        original_fallback_rva=fallback,
        original_plugin_rva=plugin,
        loads=loads,
        length_loads=(length,),
    )


def populate_pe():
    data = make_pe()
    write_rva(data, 0x3010, b"antigravity")
    write_rva(data, 0x3020, b".gemini")
    write_rva(data, 0x3030, b"antigravity.plugins")
    layout = synthetic_layout()
    for patch in layout.loads:
        write_rva(data, patch.rva, bytes.fromhex(patch.expected_hex))
    for patch in layout.length_loads:
        write_rva(data, patch.rva, bytes.fromhex(patch.expected_hex))
    return data, layout


class WindowsPEPatchTest(unittest.TestCase):
    def write_binary(self, directory, data, name="language_server.exe"):
        path = Path(directory) / name
        path.write_bytes(bytes(data))
        return path

    def test_section_translation_lea_rewrite_length_and_cave(self):
        data, layout = populate_pe()
        with tempfile.TemporaryDirectory() as temporary:
            binary = self.write_binary(temporary, data)
            _patch_windows_x64(binary, "2.35.2", layout)
            patched = binary.read_bytes()
        self.assertEqual(patched[0x480:0x480 + len(STORAGE_LITERALS)], STORAGE_LITERALS)
        for patch, target in (
            (layout.loads[0], layout.account_rva),
            (layout.loads[1], layout.fallback_rva),
            (layout.loads[2], layout.plugin_rva),
        ):
            offset = 0x200 + patch.rva - 0x1000 + 3
            displacement = struct.unpack_from("<i", patched, offset)[0]
            self.assertEqual(patch.rva + 7 + displacement, target)
        length_offset = 0x200 + layout.length_loads[0].rva - 0x1000 + 5
        self.assertEqual(struct.unpack_from("<I", patched, length_offset)[0], 8)

    def test_pe_section_table_rejects_unmapped_rva(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = self.write_binary(temporary, make_pe())
            with binary.open("rb") as stream:
                pe = PE64Image(stream)
                self.assertEqual(pe.rva_to_offset(0x1000), 0x200)
                self.assertEqual(pe.rva_to_offset(0x3000), 0x400)
                with self.assertRaises(ValueError):
                    pe.rva_to_offset(0x2000)

    def test_instruction_template_mismatch_aborts(self):
        data, layout = populate_pe()
        write_rva(data, layout.loads[0].rva, bytes(7))
        with tempfile.TemporaryDirectory() as temporary:
            binary = self.write_binary(temporary, data)
            with self.assertRaisesRegex(ValueError, "unsupported credential storage code"):
                _patch_windows_x64(binary, "2.35.2", layout)

    def test_literal_mismatch_aborts(self):
        data, layout = populate_pe()
        write_rva(data, layout.original_account_rva, b"othergravit")
        with tempfile.TemporaryDirectory() as temporary:
            binary = self.write_binary(temporary, data)
            with self.assertRaisesRegex(ValueError, "unexpected native credential storage name"):
                _patch_windows_x64(binary, "2.35.2", layout)

    def test_supported_layout_includes_native_credential_client(self):
        layout = WINDOWS_X64_LAYOUT
        anchors = [patch for patch in layout.loads if patch.function == "authclient.NewAuthClient"]
        self.assertEqual(
            anchors,
            [WindowsLeaPatch(0x30508F7, "488d15609ed900", "account", "authclient.NewAuthClient")],
        )
        self.assertEqual(len(layout.loads), 12)
        self.assertEqual(len(layout.length_loads), 2)
        old_targets = {
            "account": layout.original_account_rva,
            "fallback": layout.original_fallback_rva,
            "plugin": layout.original_plugin_rva,
        }
        new_targets = {
            "account": layout.account_rva,
            "fallback": layout.fallback_rva,
            "plugin": layout.plugin_rva,
        }
        for patch in layout.loads:
            with self.subTest(rva=hex(patch.rva), function=patch.function):
                template = bytes.fromhex(patch.expected_hex)
                self.assertEqual(len(template), 7)
                self.assertEqual(template[:2], b"\x48\x8d")
                self.assertEqual(template[2] & 0xC7, 0x05)
                next_rva = patch.rva + len(template)
                old_displacement = struct.unpack_from("<i", template, 3)[0]
                self.assertEqual(next_rva + old_displacement, old_targets[patch.literal])
                new_displacement = new_targets[patch.literal] - next_rva
                self.assertTrue(-(1 << 31) <= new_displacement < (1 << 31))
        for patch in layout.length_loads:
            with self.subTest(rva=hex(patch.rva), function=patch.function):
                immediate = struct.unpack_from("<I", bytes.fromhex(patch.expected_hex), patch.immediate_offset)[0]
                self.assertEqual(immediate, 7)

    def strip_in_dist(self, data):
        dist = Path(__file__).resolve().parent.parent / "dist"
        dist.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="test-windows-pe-", dir=dist) as temporary:
            binary = self.write_binary(temporary, data)
            strip_pe_signature(binary)
            return binary.read_bytes()

    def test_strip_pe_signature_truncates_trailing_certificate(self):
        stripped = self.strip_in_dist(make_pe(certificate=True))
        self.assertEqual(len(stripped), 0x600)
        optional = 0x98
        certificate_directory = optional + 112 + 4 * 8
        self.assertEqual(stripped[certificate_directory:certificate_directory + 8], bytes(8))
        self.assertEqual(stripped[optional + 64:optional + 68], bytes(4))

    def test_strip_pe_signature_leaves_unsigned_binary_unchanged(self):
        original = bytes(make_pe(certificate=False))
        self.assertEqual(self.strip_in_dist(original), original)

    def test_strip_pe_signature_ignores_undeclared_certificate_directory(self):
        for directory_count in (0, 4):
            with self.subTest(directory_count=directory_count):
                original = make_pe(certificate=True)
                struct.pack_into("<I", original, 0x98 + 108, directory_count)
                self.assertEqual(self.strip_in_dist(original), bytes(original))


if __name__ == "__main__":
    unittest.main()

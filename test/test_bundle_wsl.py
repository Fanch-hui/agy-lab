import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from bundle_login import STORAGE_LITERALS, X64Layout, X64LeaPatch, X64LengthPatch, patch_x64_layout  # noqa: E402
from bundle_wsl import (  # noqa: E402
    LINUX_X64_CAP_PATCHES,
    LINUX_X64_LAYOUTS,
    WSL_SERVER_SHA256,
    ElfX64Image,
)


def make_elf(vaddr=0, filesz=0x80):
    data = bytearray(0x100)
    data[:4] = b"\x7fELF"
    data[4] = 2
    data[5] = 1
    struct.pack_into("<H", data, 18, 62)
    struct.pack_into("<Q", data, 32, 0x40)
    struct.pack_into("<HH", data, 54, 56, 1)
    struct.pack_into("<I", data, 0x40, 1)
    struct.pack_into("<Q", data, 0x48, 0)
    struct.pack_into("<Q", data, 0x50, vaddr)
    struct.pack_into("<Q", data, 0x60, filesz)
    return data


def lea(target_rva, instruction_rva):
    displacement = target_rva - (instruction_rva + 7)
    return b"\x48\x8d\x15" + struct.pack("<i", displacement)


class FlatImage:
    def __init__(self, data):
        self.data = data

    def read_rva(self, rva, size):
        return bytes(self.data[rva:rva + size])

    def write_rva(self, rva, payload):
        self.data[rva:rva + len(payload)] = payload


def synthetic_layout():
    return X64Layout(
        cave_rva=0xC0,
        account_rva=0xC0,
        fallback_rva=0xCC,
        plugin_rva=0xD5,
        original_account_rva=0x20,
        original_fallback_rva=0x30,
        original_plugin_rva=0x40,
        loads=(
            X64LeaPatch(0x60, lea(0x20, 0x60).hex(), "account", "synthetic.account"),
            X64LeaPatch(0x68, lea(0x30, 0x68).hex(), "fallback", "synthetic.fallback"),
            X64LeaPatch(0x70, lea(0x40, 0x70).hex(), "plugin", "synthetic.plugin"),
        ),
        length_loads=(X64LengthPatch(0x78, "48c744245007000000", 5, "synthetic.length"),),
    )


def populated_flat(fill):
    data = bytearray(0x100)
    data[0x20:0x20 + 11] = b"antigravity"
    data[0x30:0x30 + 7] = b".gemini"
    data[0x40:0x40 + 19] = b"antigravity.plugins"
    layout = synthetic_layout()
    for patch in layout.loads:
        data[patch.rva:patch.rva + 7] = bytes.fromhex(patch.expected_hex)
    for patch in layout.length_loads:
        payload = bytes.fromhex(patch.expected_hex)
        data[patch.rva:patch.rva + len(payload)] = payload
    data[layout.cave_rva - 1:layout.cave_rva + 48] = bytes([fill]) * 49
    return data, layout


class LinuxLayoutTest(unittest.TestCase):
    def test_instruction_templates_target_native_literals(self):
        for layout in set(LINUX_X64_LAYOUTS.values()):
            targets = {
                "account": layout.original_account_rva,
                "fallback": layout.original_fallback_rva,
                "plugin": layout.original_plugin_rva,
            }
            for patch in layout.loads:
                with self.subTest(rva=hex(patch.rva), function=patch.function):
                    expected = bytes.fromhex(patch.expected_hex)
                    self.assertEqual(len(expected), 7)
                    displacement = struct.unpack_from("<i", expected, 3)[0]
                    self.assertEqual(patch.rva + 7 + displacement, targets[patch.literal])
            for patch in layout.length_loads:
                immediate = struct.unpack_from("<I", bytes.fromhex(patch.expected_hex), patch.immediate_offset)[0]
                self.assertEqual(immediate, 7)

    def test_supported_version_key_sets_match(self):
        expected = set(LINUX_X64_LAYOUTS)
        self.assertEqual(set(LINUX_X64_CAP_PATCHES), expected)
        self.assertEqual(set(WSL_SERVER_SHA256), expected)


class ElfImageTest(unittest.TestCase):
    def open_image(self, data):
        import io
        return ElfX64Image(io.BytesIO(bytes(data)))

    def test_first_pt_load_maps_file_offset_zero(self):
        image = self.open_image(make_elf())
        self.assertEqual(image.filesz, 0x80)
        self.assertEqual(image.read_rva(0, 4), b"\x7fELF")
        with self.assertRaises(ValueError):
            image.read_rva(0x70, 0x20)

    def test_rejects_non_elf_and_nonzero_first_load_vaddr(self):
        with self.assertRaises(ValueError):
            self.open_image(bytearray(0x100))
        with self.assertRaises(ValueError):
            self.open_image(make_elf(vaddr=0x1000))


class X64LayoutPatchTest(unittest.TestCase):
    def test_trap_filled_cave_is_accepted(self):
        data, layout = populated_flat(0xCC)
        patch_x64_layout(FlatImage(data), layout, empty_byte=0xCC)
        self.assertEqual(data[layout.cave_rva:layout.cave_rva + len(STORAGE_LITERALS)], STORAGE_LITERALS)

    def test_zero_filled_cave_is_rejected(self):
        data, layout = populated_flat(0)
        with self.assertRaisesRegex(ValueError, "credential storage literal region is not empty"):
            patch_x64_layout(FlatImage(data), layout, empty_byte=0xCC)


if __name__ == "__main__":
    unittest.main()

import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from bundle_context import (  # noqa: E402
    WINDOWS_CAP_ORIGINAL,
    WINDOWS_CAP_SEQUENCE,
    X64_CAP_REPLACEMENT,
    WindowsContextCapPatch,
    _patch_windows_x64,
)


def write_rva(data, rva, payload):
    if not 0x1000 <= rva < 0x1200:
        raise ValueError(rva)
    offset = 0x200 + rva - 0x1000
    data[offset:offset + len(payload)] = payload


def make_pe():
    data = bytearray(0x600)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", data, 0x84, 0x8664, 1, 0, 0, 0, 0xF0, 0)
    optional = 0x98
    struct.pack_into("<H", data, optional, 0x20B)
    struct.pack_into("<I", data, optional + 108, 16)
    section_table = optional + 0xF0
    data[section_table:section_table + 8] = b".text\0\0\0"
    struct.pack_into("<IIII", data, section_table + 8, 0x200, 0x1000, 0x200, 0x200)
    return data


def synthetic_patch():
    sequence_rva = 0x1010
    original = bytes.fromhex(WINDOWS_CAP_ORIGINAL)
    cap_rva = sequence_rva + bytes.fromhex(WINDOWS_CAP_SEQUENCE).index(original)
    return WindowsContextCapPatch(
        sequence_rva=sequence_rva,
        sequence_hex=WINDOWS_CAP_SEQUENCE,
        cap_rva=cap_rva,
        original_hex=WINDOWS_CAP_ORIGINAL,
    )


def populated_pe():
    data = make_pe()
    patch = synthetic_patch()
    write_rva(data, patch.sequence_rva, bytes.fromhex(patch.sequence_hex))
    return data, patch


class WindowsContextCapPatchTest(unittest.TestCase):
    def write_binary(self, directory, data):
        path = Path(directory) / "language_server.exe"
        path.write_bytes(bytes(data))
        return path

    def test_correct_bytes_write_equal_length_copy_and_nop(self):
        data, patch = populated_pe()
        with tempfile.TemporaryDirectory() as temporary:
            binary = self.write_binary(temporary, data)
            _patch_windows_x64(binary, "2.35.2", patch)
            patched = binary.read_bytes()
        cap_offset = 0x200 + patch.cap_rva - 0x1000
        self.assertEqual(patched[cap_offset:cap_offset + 3], X64_CAP_REPLACEMENT)
        sequence = bytes.fromhex(WINDOWS_CAP_SEQUENCE)
        sequence_offset = 0x200 + patch.sequence_rva - 0x1000
        expected = bytearray(sequence)
        relative = patch.cap_rva - patch.sequence_rva
        expected[relative:relative + 3] = X64_CAP_REPLACEMENT
        self.assertEqual(patched[sequence_offset:sequence_offset + len(sequence)], bytes(expected))

    def test_byte_mismatch_aborts(self):
        data, patch = populated_pe()
        write_rva(data, patch.cap_rva, bytes(3))
        with tempfile.TemporaryDirectory() as temporary:
            binary = self.write_binary(temporary, data)
            with self.assertRaisesRegex(ValueError, "unsupported checkpoint cap"):
                _patch_windows_x64(binary, "2.35.2", patch)

    def test_unsupported_version_aborts(self):
        data, patch = populated_pe()
        with tempfile.TemporaryDirectory() as temporary:
            binary = self.write_binary(temporary, data)
            with self.assertRaisesRegex(ValueError, "unsupported language server version"):
                _patch_windows_x64(binary, "2.35.3", patch)


if __name__ == "__main__":
    unittest.main()

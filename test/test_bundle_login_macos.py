import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from bundle_context import MACOS_CAP_OFFSETS  # noqa: E402
from bundle_login import IMAGE_BASE, MACOS_LAYOUTS  # noqa: E402


def adrp_add_target(pc, adrp, add):
    immediate = (((adrp >> 5) & 0x7FFFF) << 2) | ((adrp >> 29) & 3)
    if immediate & (1 << 20):
        immediate -= 1 << 21
    page = (pc >> 12) + immediate
    return (page << 12) + ((add >> 10) & 0xFFF)


class MacLayoutTest(unittest.TestCase):
    def test_instruction_templates_target_native_literals(self):
        layouts = set(MACOS_LAYOUTS.values())
        for layout in layouts:
            native_offsets = {
                "account": layout.native_account_offset,
                "fallback": layout.native_fallback_offset,
                "plugin": layout.native_plugin_offset,
            }
            for load in layout.loads:
                with self.subTest(offset=hex(load.offset), literal=load.literal):
                    word0, word1, word2 = struct.unpack("<III", bytes.fromhex(load.expected_hex))
                    self.assertEqual(
                        word0 & 0x9F00001F,
                        0x90000000 | load.register,
                    )
                    self.assertEqual(
                        word1 & 0xFFC003FF,
                        0x91000000 | (load.register << 5) | load.register,
                    )
                    pc = IMAGE_BASE + load.offset
                    self.assertEqual(
                        adrp_add_target(pc, word0, word1),
                        IMAGE_BASE + native_offsets[load.literal],
                    )
                    if load.literal == "fallback":
                        self.assertEqual(word2, 0xB2400BE0 | load.length_register)

    def test_context_cap_versions_match_login_versions(self):
        self.assertEqual(set(MACOS_CAP_OFFSETS), set(MACOS_LAYOUTS))


if __name__ == "__main__":
    unittest.main()

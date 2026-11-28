import io
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from renderer_patch import find_renderer, patch_renderer  # noqa: E402


def build_embedded_zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return buf.getvalue()


class RendererPatchTest(unittest.TestCase):
    def test_ignores_main_js_map_and_patches_exact_main_js(self):
        filler = "".join(f"var v{i}='token_{i % 17}_payload_{i % 29}';\n" for i in range(400))
        renderer_js = filler + 'function f(d){return d.has(f.modelId.replace(g,""));}'
        payload = b"BINARYPREFIX" + build_embedded_zip([
            ("main.js.map", b'{"version":3}'),
            ("main.js", renderer_js.encode("utf-8")),
        ]) + b"BINARYSUFFIX"

        local, central, data_start, size = find_renderer(payload)
        self.assertEqual(payload[local + 30:local + 37], b"main.js")
        self.assertEqual(struct.unpack_from("<H", payload, central + 28)[0], 7)
        self.assertGreater(size, 0)
        self.assertGreater(data_start, local)

        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "language_server"
            binary.write_bytes(payload)
            patched = patch_renderer(binary)
            self.assertIn('f.modelId.startsWith("agy-ext-")', patched)
            re_local, _, re_data_start, re_size = find_renderer(binary.read_bytes())
            self.assertEqual(re_local, local)
            self.assertEqual(re_data_start, data_start)
            self.assertLessEqual(re_size, size)
            import zlib
            restored = zlib.decompress(binary.read_bytes()[re_data_start:re_data_start + re_size], -15).decode("utf-8")
            self.assertEqual(restored, patched)


if __name__ == "__main__":
    unittest.main()

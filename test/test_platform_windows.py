import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from bundle_context import WINDOWS_X64_CAP_PATCHES  # noqa: E402
from bundle_login import WINDOWS_X64_LAYOUTS  # noqa: E402
from platform_windows import (  # noqa: E402
    WINDOWS_INPUT_SHA256,
    WINDOWS_UNPACKED_TREE_SHA256,
    extract_zip_safely,
    has_google_llc_subject,
    identify_verified_source,
    tree_sha256,
    validate_installer,
)


GOOGLE_LLC_SUBJECT = "CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US"


def write_fixture(root, relative_path, contents):
    path = root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    return path


def unpacked_tree_digest():
    # Hash records are relative path, NUL, and the raw SHA-256 of the file.
    return hashlib.sha256(b"nested/file.bin\0" + hashlib.sha256(b"unpacked").digest()).hexdigest()


class WindowsVersionTablesTest(unittest.TestCase):
    def test_supported_version_key_sets_match(self):
        expected = set(WINDOWS_X64_LAYOUTS)
        self.assertEqual(set(WINDOWS_X64_CAP_PATCHES), expected)
        self.assertEqual(set(WINDOWS_INPUT_SHA256), expected)
        self.assertEqual(set(WINDOWS_UNPACKED_TREE_SHA256), expected)


class InstallerSubjectTest(unittest.TestCase):
    def test_accepts_exact_google_llc_organization(self):
        self.assertTrue(has_google_llc_subject(GOOGLE_LLC_SUBJECT))

    def test_rejects_partial_organization_names(self):
        self.assertFalse(has_google_llc_subject("CN=Test, O=Google LLCer, C=US"))
        self.assertFalse(has_google_llc_subject("CN=Test, O=NotGoogle LLC, C=US"))
        self.assertFalse(has_google_llc_subject("CN=Test, XO=Google LLC, C=US"))


class WindowsInstallerTest(unittest.TestCase):
    installer = Path(r"C:\AGY Lab\Official [x64]'s installer.exe")

    def inspect_with(self, **overrides):
        metadata = {"Status": "Valid", "Subject": GOOGLE_LLC_SUBJECT, "ProductVersion": "2.35.2"}
        metadata.update(overrides)
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps(metadata))
        return patch("platform_windows.subprocess.run", return_value=result)

    def test_accepts_valid_installer_with_trimmed_version(self):
        with self.inspect_with(ProductVersion=" 2.35.2\r\n") as powershell:
            validate_installer(self.installer, "2.35.2")
        powershell.assert_called_once()
        arguments = powershell.call_args.args[0]
        self.assertEqual(arguments[0], "powershell")
        command = arguments[-1]
        self.assertIn("Get-Item -LiteralPath $env:AGY_INSTALLER_PATH", command)
        self.assertIn("Get-AuthenticodeSignature -LiteralPath", command)
        self.assertNotIn(str(self.installer), command)
        self.assertEqual(powershell.call_args.kwargs["env"]["AGY_INSTALLER_PATH"], str(self.installer))

    def test_rejects_invalid_signature_wrong_signer_or_wrong_version(self):
        for overrides, error in (
            ({"Status": "NotSigned"}, "valid Google LLC signature"),
            ({"Subject": "CN=Test, O=Other Publisher, C=US"}, "valid Google LLC signature"),
            ({"ProductVersion": "2.35.1"}, "does not match installed Antigravity"),
        ):
            with self.subTest(metadata=overrides), self.inspect_with(**overrides):
                with self.assertRaisesRegex(RuntimeError, error):
                    validate_installer(self.installer, "2.35.2")


class WindowsArchiveTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.archive = self.root / "electron.zip"
        self.destination = self.root / "extract"

    def test_extracts_nested_file(self):
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("nested/deeper/", b"")
            archive.writestr("nested/deeper/file.txt", b"nested file")
        extract_zip_safely(self.archive, self.destination)
        self.assertEqual((self.destination / "nested/deeper/file.txt").read_bytes(), b"nested file")

    def test_rejects_path_outside_destination(self):
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("../evil.txt", b"not an extracted file")
        with self.assertRaisesRegex(RuntimeError, "unsafe path"):
            extract_zip_safely(self.archive, self.destination)
        self.assertFalse((self.root / "evil.txt").exists())


class WindowsSourceTest(unittest.TestCase):
    unpacked_file = "app.asar.unpacked/nested/file.bin"

    def setUp(self):
        self.source = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.resources = self.source / "resources"
        official_files = {"app.asar": b"app archive", "bin/language_server.exe": b"language server"}
        for relative_path, contents in official_files.items():
            write_fixture(self.resources, relative_path, contents)
        write_fixture(self.resources, self.unpacked_file, b"unpacked")
        hashes = {name: hashlib.sha256(contents).hexdigest() for name, contents in official_files.items()}
        self.enterContext(patch("platform_windows.WINDOWS_INPUT_SHA256", {"2.35.2": hashes}))
        self.enterContext(patch("platform_windows.WINDOWS_UNPACKED_TREE_SHA256", {"2.35.2": unpacked_tree_digest()}))

    def test_accepts_exact_official_inputs(self):
        self.assertEqual(identify_verified_source(self.source), "2.35.2")

    def test_rejects_changed_asar(self):
        write_fixture(self.resources, "app.asar", b"different archive")
        with self.assertRaisesRegex(RuntimeError, r"app\.asar does not match"):
            identify_verified_source(self.source)

    def test_rejects_changed_language_server(self):
        write_fixture(self.resources, "bin/language_server.exe", b"different language server")
        with self.assertRaisesRegex(RuntimeError, r"language_server\.exe SHA-256 mismatch"):
            identify_verified_source(self.source)

    def test_rejects_changed_unpacked_tree(self):
        write_fixture(self.resources, self.unpacked_file, b"different unpacked file")
        with self.assertRaisesRegex(RuntimeError, r"app\.asar\.unpacked SHA-256 tree mismatch"):
            identify_verified_source(self.source)

    def test_rejects_unlisted_executable_script(self):
        write_fixture(self.resources, "bin/extra.PS1", b"unexpected script")
        with self.assertRaisesRegex(RuntimeError, r"unexpected or missing key executable files.*extra\.PS1"):
            identify_verified_source(self.source)


class UnpackedTreeHashTest(unittest.TestCase):
    def test_hash_is_order_independent_and_sensitive_to_paths_and_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first"
            second = Path(temporary) / "second"
            write_fixture(first, "other.txt", b"other")
            write_fixture(first, "nested/file.bin", b"unpacked")
            file = write_fixture(second, "nested/file.bin", b"unpacked")
            write_fixture(second, "other.txt", b"other")
            baseline = tree_sha256(first)
            self.assertEqual(tree_sha256(second), baseline)
            file.write_bytes(b"changed")
            self.assertNotEqual(tree_sha256(second), baseline)
            file.write_bytes(b"unpacked")
            file.rename(file.with_name("renamed.bin"))
            self.assertNotEqual(tree_sha256(second), baseline)


if __name__ == "__main__":
    unittest.main()

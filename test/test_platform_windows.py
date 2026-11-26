import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from platform_windows import has_google_llc_subject  # noqa: E402


class InstallerSubjectTest(unittest.TestCase):
    def test_accepts_exact_google_llc_organization(self):
        subject = (
            "CN=Google LLC, O=Google LLC, L=Mountain View, "
            "S=California, C=US"
        )
        self.assertTrue(has_google_llc_subject(subject))

    def test_rejects_partial_organization_names(self):
        self.assertFalse(has_google_llc_subject("CN=Test, O=Google LLCer, C=US"))
        self.assertFalse(has_google_llc_subject("CN=Test, O=NotGoogle LLC, C=US"))
        self.assertFalse(has_google_llc_subject("CN=Test, XO=Google LLC, C=US"))


if __name__ == "__main__":
    unittest.main()

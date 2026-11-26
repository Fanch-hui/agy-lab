#!/usr/bin/env python3
"""Cross-platform entry point for building AGY Lab."""

import sys


def main():
    if sys.platform == "darwin":
        from platform_macos import main as platform_main
    elif sys.platform == "win32":
        from platform_windows import main as platform_main
    else:
        raise SystemExit(f"Unsupported build platform: {sys.platform}")
    platform_main()


if __name__ == "__main__":
    main()

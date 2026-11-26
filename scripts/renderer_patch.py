"""Patch the copied language server's bundled renderer at build time."""

import mmap
import re
import struct
import zlib
from pathlib import Path


# The role filter's effort-suffix regex is renamed by the minifier between releases.
ROLE_FILTER = re.compile(r'd\.has\(f\.modelId\.replace\(([A-Za-z_$][\w$]*),""\)\)')


def patch_source(source):
    # Native external models are not in the server's Orchestrator role list; allow them in both roles.
    matches = ROLE_FILTER.findall(source)
    if len(matches) != 1:
        raise RuntimeError(f"Unsupported runtime: expected one native external Orchestrator roles, found {len(matches)}")
    return ROLE_FILTER.sub(r'(\g<0>||f.modelId.startsWith("agy-ext-"))', source)


def find_renderer(binary):
    local_matches = list(re.finditer(rb"PK\x03\x04.{26}main\.js", binary, re.S))
    if len(local_matches) != 1:
        raise RuntimeError("Embedded renderer local ZIP entry was not unique")
    local = local_matches[0].start()
    flags, method = struct.unpack_from("<HH", binary, local + 6)
    crc, size, raw_size = struct.unpack_from("<III", binary, local + 14)
    name_length, extra_length = struct.unpack_from("<HH", binary, local + 26)
    if flags != 0 or method != 8:
        raise RuntimeError("Embedded renderer ZIP layout is unsupported")

    data_start = local + 30 + name_length + extra_length
    entries = []
    position = data_start + size
    while True:
        position = binary.find(b"PK\x01\x02", position)
        if position < 0:
            break
        if binary[position + 46:position + 53] == b"main.js":
            if struct.unpack_from("<III", binary, position + 16) == (crc, size, raw_size):
                entries.append(position)
        position += 4
    if len(entries) != 1:
        raise RuntimeError("Embedded renderer central ZIP entry was not unique")
    central = entries[0]
    local_offset = struct.unpack_from("<I", binary, central + 42)[0]
    archive_start = local - local_offset
    end = binary.find(b"PK\x05\x06", central)
    if end < 0:
        raise RuntimeError("Embedded renderer ZIP directory is incomplete")
    central_size, central_offset = struct.unpack_from("<II", binary, end + 12)
    if end - central_size - central_offset != archive_start:
        raise RuntimeError("Embedded renderer ZIP offsets are inconsistent")
    return local, central, data_start, size


def patch_renderer(binary_path):
    """Patch the embedded renderer in place and return the patched source."""
    with Path(binary_path).open("r+b") as stream:
        with mmap.mmap(stream.fileno(), 0) as binary:
            local, central, data_start, size = find_renderer(binary)
            source = zlib.decompress(binary[data_start:data_start + size], -15).decode("utf-8")
            patched = patch_source(source)
            updated = patched.encode("utf-8")
            compressed = zlib.compress(updated, level=9, wbits=-15)
            if len(compressed) > size:
                raise RuntimeError("Patched renderer no longer fits in the language server")
            metadata = struct.pack("<III", zlib.crc32(updated), len(compressed), len(updated))
            binary[local + 14:local + 26] = metadata
            binary[central + 16:central + 28] = metadata
            binary[data_start:data_start + size] = compressed + bytes(size - len(compressed))
    return patched

#!/usr/bin/env python3
"""Prove remote ZIP listing/extraction over HTTP Range without full download."""

from __future__ import annotations

import io
import json
from pathlib import Path
import re
import sys
import zipfile
from dataclasses import dataclass, field

import requests

PACK_URL = "https://quaternius.itch.io/universal-animation-library"


@dataclass
class RemoteRangeReader(io.RawIOBase):
    session: requests.Session
    url: str
    position: int = 0
    size: int = 0
    transferred: int = 0
    requests_made: list[tuple[int, int, int]] = field(default_factory=list)

    def __post_init__(self) -> None:
        response = self.session.get(
            self.url,
            headers={"Range": "bytes=0-0"},
            timeout=30,
        )
        response.raise_for_status()
        content_range = response.headers.get("content-range", "")
        match = re.match(r"bytes\s+\d+-\d+/(\d+)", content_range)
        if response.status_code != 206 or not match:
            raise RuntimeError(
                f"upstream does not support byte ranges: status={response.status_code} "
                f"content-range={content_range!r}"
            )
        self.size = int(match.group(1))
        self.transferred += len(response.content)
        self.requests_made.append((0, 0, len(response.content)))

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            target = offset
        elif whence == io.SEEK_CUR:
            target = self.position + offset
        elif whence == io.SEEK_END:
            target = self.size + offset
        else:
            raise ValueError(f"unsupported whence: {whence}")
        if target < 0:
            raise ValueError("negative seek")
        self.position = target
        return target

    def read(self, size: int = -1) -> bytes:
        if self.position >= self.size:
            return b""
        if size is None or size < 0:
            end = self.size - 1
        else:
            end = min(self.size - 1, self.position + size - 1)
        start = self.position
        response = self.session.get(
            self.url,
            headers={"Range": f"bytes={start}-{end}"},
            timeout=30,
        )
        response.raise_for_status()
        if response.status_code != 206:
            raise RuntimeError(f"range request returned {response.status_code}")
        data = response.content
        self.position += len(data)
        self.transferred += len(data)
        self.requests_made.append((start, end, len(data)))
        return data


def resolve_signed_file(session: requests.Session) -> tuple[str, str]:
    download_page_response = session.post(f"{PACK_URL}/download_url", timeout=30)
    download_page_response.raise_for_status()
    signed_page = download_page_response.json()["url"]

    page_response = session.get(signed_page, timeout=30)
    page_response.raise_for_status()
    upload_match = re.search(r'data-upload_id="(\d+)"', page_response.text)
    if not upload_match:
        raise RuntimeError("upload ID not found")
    upload_id = upload_match.group(1)

    file_response = session.post(
        f"{PACK_URL}/file/{upload_id}?source=game_download",
        headers={"Accept": "application/json", "Referer": signed_page},
        timeout=30,
    )
    file_response.raise_for_status()
    signed_file = file_response.json()["url"]
    return upload_id, signed_file


def main() -> int:
    session = requests.Session()
    session.headers["User-Agent"] = "threenative-asset-mcp-range-spike/0.1"
    upload_id, signed_file = resolve_signed_file(session)
    remote = RemoteRangeReader(session, signed_file)

    with zipfile.ZipFile(remote) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        candidates = [
            entry
            for entry in entries
            if entry.filename.lower().endswith((".fbx", ".gltf", ".glb", ".dae", ".blend"))
        ]
        selected = min(candidates or entries, key=lambda entry: entry.compress_size)
        listing_bytes = remote.transferred
        with archive.open(selected) as source:
            extracted = source.read()

    extracted_path = Path("/tmp/threenative-asset-spike/ual1-standard.glb")
    extracted_path.parent.mkdir(parents=True, exist_ok=True)
    extracted_path.write_bytes(extracted)

    result = {
        "uploadId": upload_id,
        "archiveBytes": remote.size,
        "entryCount": len(entries),
        "entries": [
            {
                "path": entry.filename,
                "compressedBytes": entry.compress_size,
                "uncompressedBytes": entry.file_size,
            }
            for entry in entries
        ],
        "selectedEntry": selected.filename,
        "selectedUncompressedBytes": selected.file_size,
        "selectedCompressedBytes": selected.compress_size,
        "listingTransferredBytes": listing_bytes,
        "totalTransferredBytes": remote.transferred,
        "transferRatio": round(remote.transferred / remote.size, 6),
        "rangeRequests": len(remote.requests_made),
        "extractedBytes": len(extracted),
        "extractedPath": str(extracted_path),
        "signedUrlExposed": False,
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

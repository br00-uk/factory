"""Trusted guest-only installer for explicitly pinned Go/Node tool archives."""
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

archives = json.loads(sys.argv[1])
if not isinstance(archives, list) or not 1 <= len(archives) <= 10:
    raise ValueError("Supply a bounded list of pinned tool archives")
for archive in archives:
    url, digest, destination = archive["url"], archive["sha256"], archive["destination"]
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Use an explicit HTTPS archive URL without credentials")
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or not re.fullmatch(r"/usr/local/[a-z][a-z0-9_-]*", destination):
        raise ValueError("Invalid hash or installation destination")
    with tempfile.TemporaryDirectory() as temp:
        package = os.path.join(temp, "archive.tar.gz")
        checksum, size = hashlib.sha256(), 0
        with urllib.request.urlopen(url, timeout=60) as response, open(package, "wb") as output:
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > 128 * 1024 * 1024:
                    raise ValueError("Tool archive exceeds download bound")
                checksum.update(block)
                output.write(block)
        if checksum.hexdigest() != digest:
            raise ValueError("Pinned tool archive hash mismatch")
        extracted = os.path.join(temp, "extracted")
        os.mkdir(extracted)
        with tarfile.open(package) as bundle:
            members = bundle.getmembers()
            if len(members) > 50000 or sum(member.size for member in members) > 512 * 1024 * 1024:
                raise ValueError("Tool extraction exceeds bound")
            bundle.extractall(extracted, filter="data")
        roots = os.listdir(extracted)
        if len(roots) != 1 or not os.path.isdir(os.path.join(extracted, roots[0])):
            raise ValueError("Tool archive must contain one directory")
        if os.path.lexists(destination):
            raise ValueError("Tool installation destination already exists")
        shutil.move(os.path.join(extracted, roots[0]), destination)
        print("Installed", destination, "sha256", digest, flush=True)

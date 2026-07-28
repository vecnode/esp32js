#!/usr/bin/env python3

from pathlib import PurePath
import errno
import json
import os
import shlex
import subprocess
import sys

def destdir_join(d1: str, d2: str) -> str:
    if not d1:
        return d2
    # c:\destdir + c:\prefix must produce c:\destdir\prefix
    return str(PurePath(d1, *PurePath(d2).parts[1:]))

# physicalsim build fix: this whole script only builds a convenience
# "qemu-bundle" symlink tree for QEMU's own test suite (never read by
# `ninja install`'s real output) - on this Windows/meson combination it
# can't complete (MESONINTROSPECT resolves to a bare "meson" entry-point
# script subprocess.run() can't exec directly, and even past that,
# os.symlink() needs Developer Mode/Administrator on Windows), so the
# whole thing is best-effort: skip on any failure rather than fail the
# entire configure over a step nothing downstream depends on.
try:
    introspect = os.environ.get('MESONINTROSPECT')
    if not introspect:
        raise RuntimeError('MESONINTROSPECT not set')
    out = subprocess.run([*shlex.split(introspect), '--installed'],
                         stdout=subprocess.PIPE, check=True).stdout
    for source, dest in json.loads(out).items():
        bundle_dest = destdir_join('qemu-bundle', dest)
        path = os.path.dirname(bundle_dest)
        os.makedirs(path, exist_ok=True)
        try:
            os.symlink(source, bundle_dest)
        except OSError as e:
            if e.errno != errno.EEXIST:
                raise
except BaseException as e:
    print(f'symlink-install-tree.py: skipping ({e})', file=sys.stderr)
sys.exit(0)

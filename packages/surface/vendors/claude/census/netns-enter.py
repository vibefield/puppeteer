"""Second stage of the Claude census network sandbox (census/sandbox.mjs).

Runs as namespace root inside `unshare --user --map-root-user --net --mount`,
before any census code: it brings the namespace's own loopback up (a fresh
network namespace has only a downed `lo` and no route), mounts an empty
read-only tmpfs over every path named with --hide, and then replaces itself
with the command after `--`. Nothing here opens a socket beyond the ioctl
socket, and nothing reads the hidden paths.

Usage: python3 -I netns-enter.py [--hide <dir>]... -- <command> [args...]
"""

import ctypes
import fcntl
import os
import socket
import struct
import sys

SIOCGIFFLAGS = 0x8913
SIOCSIFFLAGS = 0x8914
IFF_UP = 0x1
IFF_RUNNING = 0x40
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8


def loopback_up():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        request = struct.pack('16sH14x', b'lo', 0)
        flags = struct.unpack('16sH14x', fcntl.ioctl(sock.fileno(), SIOCGIFFLAGS, request))[1]
        fcntl.ioctl(sock.fileno(), SIOCSIFFLAGS, struct.pack('16sH14x', b'lo', flags | IFF_UP | IFF_RUNNING))


def hide(path):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    flags = MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC
    if libc.mount(b'census-hidden', path.encode(), b'tmpfs', flags, b'size=16k,mode=0555') != 0:
        error = ctypes.get_errno()
        raise OSError(error, f'cannot hide {path}: {os.strerror(error)}')


def main(argv):
    if '--' not in argv:
        raise SystemExit('usage: netns-enter.py [--hide <dir>]... -- <command> [args...]')
    split = argv.index('--')
    options, command = argv[:split], argv[split + 1 :]
    if not command:
        raise SystemExit('netns-enter.py: no command after --')
    hidden = []
    index = 0
    while index < len(options):
        if options[index] != '--hide' or index + 1 >= len(options):
            raise SystemExit(f'netns-enter.py: unexpected argument {options[index]}')
        hidden.append(options[index + 1])
        index += 2
    loopback_up()
    for path in hidden:
        if os.path.isdir(path):
            hide(path)
    os.execv(command[0], command)


if __name__ == '__main__':
    main(sys.argv[1:])

"""Lifetime OS lock. The pipe closes when the supervisor exits, even on SIGKILL."""
import fcntl
import os
import sys
import signal

# Keep the lock through the parent's graceful shutdown. A terminal signal must
# not release it while that parent is still stopping its VM and saving state.
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)

fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('BUSY', flush=True)
    sys.exit(73)
print('LOCKED', flush=True)
sys.stdin.buffer.read()

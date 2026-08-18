# Runtime baseline counters

Runtime counter snapshots are label-free totals; they never include commands,
paths, session identifiers, or file names. Record both `baseline` and `after`
snapshots (and their delta), build revision, platform, sample count, configured
RTT, and latency units. Frontend store counters use the pure
`benchmark-counters.ts` seam and are deliberately not a React store.

The ignored real-SSH RTT benchmark requires a working SSH agent and an explicit
remote fixture rooted at `/tmp/tunara-rtt-benchmark-*`. It fails closed for
other paths and runs the fixed 20/100/250 ms delayed-proxy matrix. It is not run
by normal tests; fixture host load and SSH server configuration must accompany
any published result.

Run `scripts/benchmark-runtime-optimizations.sh` for the reproducible scale
matrix. It records build revision, platform, sample count, units, frontend
before/after counters, transfer publications/pump candidates, upload
metadata/IPC/publication counts, and payload bytes. Wall-clock values are
observations, not timing gates; the tests gate structural bounds instead.

Without the explicit SSH fixture, the runner reports real SSH RTT and remote
SFTP materialization as blocked. The local manifest and pure materialization
projection results must not be described as real-network measurements. Strict
remote manifests also cannot provide an atomic snapshot when a server replaces
a pathname with the same weak attributes between SFTP LSTAT observations; all
observable mismatches and symlinks still fail closed.

#!/bin/sh
# Container entrypoint for the real-SSH regression matrix (see
# docs/TESTING.md, "Real SSH regression matrix"). Provisions deterministic
# fixture users, installs the generated client public keys, creates the
# ~10k-file directory and then runs sshd in the foreground.
set -eu

ROLE="${MATRIX_ROLE:-target}"
CLIENT_KEYS="${MATRIX_CLIENT_KEYS:-/fixture/client}"
PW_PASSWORD="${MATRIX_PW_PASSWORD:-tunara-matrix-pw}"
KBD_PASSWORD="${MATRIX_KBD_PASSWORD:-tunara-matrix-kbd}"
BIG_COUNT="${MATRIX_BIG_FILE_COUNT:-9990}"

log() { printf 'matrix[%s]: %s\n' "$ROLE" "$*" >&2; }

# --- host keys ------------------------------------------------------------
# Fresh per container start: the tests learn them through TOFU, and the
# mismatch case seeds known_hosts with the *other* hop's key on purpose.
mkdir -p /etc/ssh/matrix
[ -f /etc/ssh/matrix/ssh_host_ed25519_key ] \
    || ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/matrix/ssh_host_ed25519_key
[ -f /etc/ssh/matrix/ssh_host_rsa_key ] \
    || ssh-keygen -q -t rsa -b 3072 -N '' -f /etc/ssh/matrix/ssh_host_rsa_key
chmod 600 /etc/ssh/matrix/ssh_host_*_key

# --- users -----------------------------------------------------------------
ensure_user() {
    name="$1"
    shell="$2"
    if ! id "$name" >/dev/null 2>&1; then
        useradd --create-home --shell "$shell" "$name"
    fi
}

install_authorized_keys() {
    name="$1"
    home="/home/$name"
    mkdir -p "$home/.ssh"
    : > "$home/.ssh/authorized_keys"
    found=0
    for pub in "$CLIENT_KEYS"/*.pub; do
        [ -f "$pub" ] || continue
        cat "$pub" >> "$home/.ssh/authorized_keys"
        found=$((found + 1))
    done
    chown -R "$name:$name" "$home/.ssh"
    chmod 700 "$home/.ssh"
    chmod 600 "$home/.ssh/authorized_keys"
    log "installed $found client public key(s) for $name"
}

# publickey (ed25519 + RSA + agent) -> bash
ensure_user keyuser /bin/bash
install_authorized_keys keyuser
# password -> zsh
ensure_user pwuser /bin/zsh
printf '%s:%s\n' pwuser "$PW_PASSWORD" | chpasswd
# keyboard-interactive (PAM) -> bash
ensure_user kbduser /bin/bash
printf '%s:%s\n' kbduser "$KBD_PASSWORD" | chpasswd

# --- fixture data (target only) --------------------------------------------
if [ "$ROLE" = "target" ]; then
    mkdir -p /srv/matrix/big /srv/matrix/scratch
    if [ ! -f /srv/matrix/.big-complete ]; then
        log "generating $BIG_COUNT files under /srv/matrix/big"
        gawk -v count="$BIG_COUNT" 'BEGIN {
            for (i = 1; i <= count; i++) {
                f = sprintf("/srv/matrix/big/f-%05d.txt", i)
                printf "line %d alpha beta gamma\n", i > f
                if (i % 1000 == 0) printf "NEEDLE-tunara %d\n", i > f
                close(f)
            }
        }'
        : > /srv/matrix/.big-complete
    fi
    printf 'scratch-v1\n' > /srv/matrix/scratch/edit.txt
    chown -R keyuser:keyuser /srv/matrix
    chmod 755 /srv/matrix /srv/matrix/big /srv/matrix/scratch
fi

# --- sshd -------------------------------------------------------------------
mkdir -p /run/sshd
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.matrix
: > /run/matrix-ready
log "sshd starting"
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.matrix

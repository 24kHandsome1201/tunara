FROM debian:bookworm-slim

# One image serves both the `target` and `jump` hops. The role, users and
# fixture data are decided at container start by entrypoint.sh so the two
# services stay byte-identical apart from their environment.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openssh-server \
        bash \
        zsh \
        grep \
        gawk \
        procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    # pam_loginuid cannot set the audit loginuid inside a container and would
    # otherwise fail every PAM session (password + keyboard-interactive).
    && sed -i 's/^session\s\+required\s\+pam_loginuid\.so/session optional pam_loginuid.so/' /etc/pam.d/sshd

COPY sshd_config /etc/ssh/sshd_config.matrix
COPY entrypoint.sh /usr/local/bin/matrix-entrypoint
RUN chmod +x /usr/local/bin/matrix-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/matrix-entrypoint"]

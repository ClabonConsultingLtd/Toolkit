# Test targets for rules/dockerfile.yml.
FROM debian:12-slim
# ruleid: dockerfile-pipe-to-shell
RUN curl -fsSL https://example.com/install.sh | sh
# ok: dockerfile-pipe-to-shell
RUN curl -fsSLo /tmp/install.sh https://example.com/install.sh && sha256sum -c /tmp/install.sh.sha256
# ruleid: dockerfile-add-remote-url
ADD https://example.com/tool.tar.gz /opt/
# ok: dockerfile-add-remote-url
ADD --checksum=sha256:0000000000000000000000000000000000000000000000000000000000000000 https://example.com/tool.tar.gz /opt/
# ruleid: dockerfile-secret-in-env
ENV API_TOKEN=abc123
# ok: dockerfile-secret-in-env
ENV PASSWORD_FILE=/run/secrets/db_password
# ruleid: dockerfile-user-root
USER root
# ok: dockerfile-user-root
USER app

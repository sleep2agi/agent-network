FROM node:22.23.0-bookworm@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a
COPY .github/scripts/verify-release-main.sh /guard.sh
COPY tests/release-main-sha/run.sh /run.sh
CMD ["bash", "/run.sh"]

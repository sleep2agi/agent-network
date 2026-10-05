FROM node:22.23.0-bookworm@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a
COPY .github/scripts/verify-npm-publish-visible.sh /verify.sh
COPY tests/release-publish-visible/run.sh /run.sh
CMD ["bash", "/run.sh"]

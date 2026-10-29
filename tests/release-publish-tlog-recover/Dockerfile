FROM node:22.23.0-bookworm@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a
# #1510 续：发布脚本在「透明度日志冲突」与「真失败」之间的分类（桩 npm，无网络）。
COPY .github/scripts/publish-outcome.py /work/.github/scripts/publish-outcome.py
COPY .github/scripts/publish-with-tlog-recover.sh /work/.github/scripts/publish-with-tlog-recover.sh
COPY tests/release-publish-tlog-recover/run.sh /run.sh
CMD ["bash", "/run.sh"]

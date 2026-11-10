FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
RUN apk add --no-cache python3
WORKDIR /fixture
COPY .github/scripts/verify-gated-cli-download.py .github/scripts/test-gated-cli-download.py ./
CMD ["python3", "test-gated-cli-download.py"]

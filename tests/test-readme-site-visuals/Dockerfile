FROM python:3.12-slim
RUN pip install --no-cache-dir Pillow==11.3.0 Markdown==3.8.2
WORKDIR /repo
COPY README.md README.en.md ./
COPY docs/assets/readme/logo.png docs/assets/readme/logo.png
COPY docs-site/docs/public/hero/ docs-site/docs/public/hero/
COPY docs-site/docs/public/features/ docs-site/docs/public/features/
COPY docs-site/docs/index.md docs-site/docs/index.md
COPY docs-site/docs/.vitepress/theme/components/HeroLive.vue docs-site/docs/.vitepress/theme/components/HeroLive.vue
COPY tests/test-readme-site-visuals/check.py /check.py
CMD ["python", "/check.py"]

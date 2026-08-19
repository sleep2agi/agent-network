#!/usr/bin/env bash
set -euo pipefail

cd /app
echo "source_commit=${TEST600_SOURCE_COMMIT:-unknown}"

checks=0
pass() { checks=$((checks + 1)); printf 'PASS %s\n' "$1"; }
expect_red() {
  local name="$1"; shift
  if "$@" >/tmp/test600-red.out 2>&1; then
    printf 'FAIL %s unexpectedly passed\n' "$name" >&2
    cat /tmp/test600-red.out >&2
    exit 1
  fi
  test -s /tmp/test600-red.out
  pass "witnessed-red: $name"
}

node scripts/build-public-skillhub.mjs --check
pass "canonical catalog is deterministic and current"

case_root=/tmp/test600-case
mkdir -p "$case_root/scripts" "$case_root/docs-site/scripts" "$case_root/docs-site/docs/public"
cp scripts/build-public-skillhub.mjs "$case_root/scripts/"
cp docs-site/scripts/build-public-skillhub.mjs "$case_root/docs-site/scripts/"
cp -a docs-site/docs/public/skillhub "$case_root/docs-site/docs/public/"

cp -a "$case_root" /tmp/test600-license
sed -i 's/"Apache-2.0"/"UNLICENSED"/' /tmp/test600-license/docs-site/docs/public/skillhub/skills/skill-writing-guide/1.0.0/metadata.json
grep -F '"UNLICENSED"' /tmp/test600-license/docs-site/docs/public/skillhub/skills/skill-writing-guide/1.0.0/metadata.json >/dev/null
expect_red "unsupported license is rejected" node /tmp/test600-license/scripts/build-public-skillhub.mjs

cp -a "$case_root" /tmp/test600-secret
printf '\nntok_1234567890abcdefghijklmnop\n' >> /tmp/test600-secret/docs-site/docs/public/skillhub/skills/skill-writing-guide/1.0.0/SKILL.md
expect_red "credential-shaped content is rejected" node /tmp/test600-secret/scripts/build-public-skillhub.mjs

cp -a "$case_root" /tmp/test600-stale
printf ' ' >> /tmp/test600-stale/docs-site/docs/public/skillhub/catalog.json
expect_red "stale generated catalog is rejected" node /tmp/test600-stale/scripts/build-public-skillhub.mjs --check

bad_bundle=/tmp/test600-bad-bundle.json
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schema_version:1,metadata:{slug:"probe-skill",version:"1.0.0"},content:"# Probe\n",content_sha256:"0".repeat(64)}))' "$bad_bundle"
expect_red "import rejects a mismatched content hash" node scripts/import-public-skill-bundle.mjs "$bad_bundle"

cp -a "$case_root" /tmp/test600-private-field
cp scripts/import-public-skill-bundle.mjs /tmp/test600-private-field/scripts/
private_bundle=/tmp/test600-private-field-bundle.json
node - "$private_bundle" <<'NODE'
const fs = require('fs'); const crypto = require('crypto'); const content = '# Private field probe\n';
fs.writeFileSync(process.argv[2], JSON.stringify({
  schema_version: 1,
  metadata: { schema_version: 1, slug: 'private-field-probe', name: 'Private field probe', description: 'Must be rejected before write.', version: '1.0.0', license: 'MIT', publisher: { name: 'Test publisher' }, tags: [], published_at: '2026-08-08', network_id: 'must-not-cross' },
  content,
  content_sha256: crypto.createHash('sha256').update(content).digest('hex'),
}));
NODE
expect_red "import rejects private metadata before writing" node /tmp/test600-private-field/scripts/import-public-skill-bundle.mjs "$private_bundle"
test ! -e /tmp/test600-private-field/docs-site/docs/public/skillhub/skills/private-field-probe

cp -a "$case_root" /tmp/test600-import
cp scripts/import-public-skill-bundle.mjs /tmp/test600-import/scripts/
good_bundle=/tmp/test600-good-bundle.json
node - "$good_bundle" <<'NODE'
const fs = require('fs'); const crypto = require('crypto'); const content = '# Probe skill\n\nReusable public probe.\n';
fs.writeFileSync(process.argv[2], JSON.stringify({
  schema_version: 1,
  metadata: { schema_version: 1, slug: 'probe-skill', name: 'Probe skill', description: 'Public import probe.', version: '1.0.0', license: 'Apache-2.0', publisher: { name: 'Test publisher' }, tags: ['probe'], published_at: '2026-08-08' },
  content,
  content_sha256: crypto.createHash('sha256').update(content).digest('hex'),
}));
NODE
node /tmp/test600-import/scripts/import-public-skill-bundle.mjs "$good_bundle"
node /tmp/test600-import/scripts/build-public-skillhub.mjs
grep -q '"slug": "probe-skill"' /tmp/test600-import/docs-site/docs/public/skillhub/catalog.json
pass "valid Dashboard export bundle imports into the reviewed public source tree"

test "$(find docs-site/docs/public/skillhub/skills -type l | wc -l)" -eq 0
pass "public registry contains no symlinks"

grep -q "never as raw HTML" docs/rfcs/RFC-033-public-skillhub.md
grep -q "不会自动公开" docs-site/docs/skillhub/contribute.md
grep -q "never sends it to anet.sh automatically" docs-site/docs/en/skillhub/contribute.md
pass "private/public trust boundary is documented in both locales"

grep -q "PublicSkillHub" docs-site/docs/.vitepress/theme/index.ts
grep -q "withBase('/skillhub/catalog.json')" docs-site/docs/.vitepress/theme/PublicSkillHub.vue
grep -q "<PublicSkillHub lang=\"zh\"" docs-site/docs/skillhub/index.md
grep -q "<PublicSkillHub lang=\"en\"" docs-site/docs/en/skillhub/index.md
pass "public catalog component is wired for both locales"

docs_only=/tmp/test600-docs-only
mkdir -p "$docs_only"
cp -a docs-site/. "$docs_only/"
node "$docs_only/scripts/build-public-skillhub.mjs" --check
pass "Vercel docs-site project root contains its complete catalog validator"

npm ci --prefix docs-site --no-audit --no-fund
npm run build --prefix docs-site
test -f docs-site/docs/.vitepress/dist/skillhub/index.html
test -f docs-site/docs/.vitepress/dist/en/skillhub/index.html
test -f docs-site/docs/.vitepress/dist/skillhub/catalog.json
test -f docs-site/docs/.vitepress/dist/skillhub/skills/skill-writing-guide/1.0.0/SKILL.md
pass "VitePress production build includes catalog, pages, and immutable content"

printf 'RESULT: PASS (%d checks)\n' "$checks"

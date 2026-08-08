#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillsRoot = join(repoRoot, 'docs-site', 'docs', 'public', 'skillhub', 'skills')
const bundlePath = process.argv[2] ? resolve(process.argv[2]) : ''
const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const versionRe = /^[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*$/
const metadataKeys = new Set(['schema_version', 'slug', 'name', 'description', 'version', 'license', 'publisher', 'tags', 'published_at'])
const publisherKeys = new Set(['name', 'url'])

function fail(message) {
  console.error(`public-skillhub-import: ${message}`)
  process.exit(1)
}

if (!bundlePath) fail('usage: node scripts/import-public-skill-bundle.mjs <bundle.json>')

let bundle
try { bundle = JSON.parse(await readFile(bundlePath, 'utf8')) } catch { fail('bundle is missing or invalid JSON') }
const bundleKeys = Object.keys(bundle || {}).sort().join(',')
if (bundleKeys !== 'content,content_sha256,metadata,schema_version' || bundle.schema_version !== 1) fail('bundle shape or schema_version is invalid')
if (typeof bundle.content !== 'string' || !bundle.content) fail('bundle content must be non-empty text')
if (!bundle.metadata || typeof bundle.metadata !== 'object' || Array.isArray(bundle.metadata)) fail('bundle metadata is invalid')
if (Object.keys(bundle.metadata).some(key => !metadataKeys.has(key))) fail('bundle metadata contains an unknown field')
if (!bundle.metadata.publisher || typeof bundle.metadata.publisher !== 'object' || Array.isArray(bundle.metadata.publisher)) fail('bundle publisher is invalid')
if (Object.keys(bundle.metadata.publisher).some(key => !publisherKeys.has(key))) fail('bundle publisher contains an unknown field')
const { slug, version } = bundle.metadata
if (typeof slug !== 'string' || !slugRe.test(slug) || typeof version !== 'string' || !versionRe.test(version)) fail('bundle slug/version is invalid')
const actualHash = createHash('sha256').update(bundle.content, 'utf8').digest('hex')
if (bundle.content_sha256 !== actualHash) fail('bundle content_sha256 does not match content')

const target = join(skillsRoot, slug, version)
const slugRoot = join(skillsRoot, slug)
try {
  await mkdir(slugRoot, { recursive: false, mode: 0o755 })
} catch (error) {
  if (error?.code !== 'EEXIST') fail(`cannot create slug directory: ${error instanceof Error ? error.message : String(error)}`)
}
const slugStat = await lstat(slugRoot)
if (!slugStat.isDirectory() || slugStat.isSymbolicLink()) fail('slug path must be a real directory')
try { await mkdir(target, { recursive: false, mode: 0o755 }) } catch { fail('target version already exists') }
await writeFile(join(target, 'metadata.json'), `${JSON.stringify(bundle.metadata, null, 2)}\n`, { mode: 0o644 })
await writeFile(join(target, 'SKILL.md'), bundle.content, { mode: 0o644 })
console.log(`public-skillhub-import: wrote ${slug}/${version}; run node scripts/build-public-skillhub.mjs`)

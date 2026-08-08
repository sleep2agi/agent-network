#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_ROOT = join(REPO_ROOT, 'docs-site', 'docs', 'public', 'skillhub', 'skills')
const CATALOG_PATH = join(REPO_ROOT, 'docs-site', 'docs', 'public', 'skillhub', 'catalog.json')
const CHECK_ONLY = process.argv.includes('--check')
const MAX_CONTENT_BYTES = 128 * 1024
const ALLOWED_LICENSES = new Set(['Apache-2.0', 'MIT', 'CC-BY-4.0'])
const META_KEYS = new Set(['schema_version', 'slug', 'name', 'description', 'version', 'license', 'publisher', 'tags', 'published_at'])
const PUBLISHER_KEYS = new Set(['name', 'url'])
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_RE = /^[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*$/
const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function fail(message) {
  throw new Error(`public-skillhub: ${message}`)
}

function assertString(value, field, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${field} must be a string of ${min}-${max} characters`)
  }
  if (/\p{Cc}/u.test(value)) fail(`${field} contains control characters`)
}

function assertExactKeys(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field} contains unknown field ${key}`)
  }
}

function assertPublicText(value, field) {
  const forbidden = [
    [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|(?:ntok|utok|atok)_[A-Za-z0-9_-]{12,})\b/, 'credential-shaped value'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/(?:^|[\s`"'])\/(?:home|Users)\/[^\s/]+\//m, 'host-local home path'],
    [/[A-Za-z]:\\Users\\[^\\\s]+\\/, 'host-local Windows profile path'],
  ]
  for (const [pattern, label] of forbidden) {
    if (pattern.test(value)) fail(`${field} contains ${label}`)
  }
}

async function assertPlainFile(path, label) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`)
}

async function childDirectories(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const names = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail(`symlink is forbidden: ${relative(REPO_ROOT, join(path, entry.name))}`)
    if (!entry.isDirectory()) fail(`unexpected file: ${relative(REPO_ROOT, join(path, entry.name))}`)
    names.push(entry.name)
  }
  return names.sort()
}

async function buildCatalog() {
  const skills = []
  const seen = new Set()
  for (const slugDir of await childDirectories(SKILLS_ROOT)) {
    if (!SLUG_RE.test(slugDir)) fail(`invalid slug directory ${slugDir}`)
    for (const versionDir of await childDirectories(join(SKILLS_ROOT, slugDir))) {
      if (!VERSION_RE.test(versionDir)) fail(`invalid version directory ${slugDir}/${versionDir}`)
      const entryDir = join(SKILLS_ROOT, slugDir, versionDir)
      const entries = (await readdir(entryDir)).sort()
      if (entries.join(',') !== 'SKILL.md,metadata.json') {
        fail(`${slugDir}/${versionDir} must contain exactly SKILL.md and metadata.json`)
      }
      const metaPath = join(entryDir, 'metadata.json')
      const contentPath = join(entryDir, 'SKILL.md')
      await assertPlainFile(metaPath, `${slugDir}/${versionDir}/metadata.json`)
      await assertPlainFile(contentPath, `${slugDir}/${versionDir}/SKILL.md`)

      let metadata
      try { metadata = JSON.parse(await readFile(metaPath, 'utf8')) } catch { fail(`${slugDir}/${versionDir}/metadata.json is invalid JSON`) }
      assertExactKeys(metadata, META_KEYS, 'metadata')
      if (metadata.schema_version !== 1) fail(`${slugDir}/${versionDir} has unsupported schema_version`)
      assertString(metadata.slug, 'slug', 2, 80)
      assertString(metadata.name, 'name', 1, 120)
      assertString(metadata.description, 'description', 1, 1000)
      assertString(metadata.version, 'version', 1, 40)
      if (metadata.slug !== slugDir || metadata.version !== versionDir) fail(`${slugDir}/${versionDir} metadata does not match its path`)
      if (!SLUG_RE.test(metadata.slug) || !VERSION_RE.test(metadata.version)) fail(`${slugDir}/${versionDir} has invalid slug or version`)
      if (!ALLOWED_LICENSES.has(metadata.license)) fail(`${slugDir}/${versionDir} uses unsupported license ${metadata.license}`)
      assertExactKeys(metadata.publisher, PUBLISHER_KEYS, 'publisher')
      assertString(metadata.publisher.name, 'publisher.name', 1, 120)
      if (metadata.publisher.url !== undefined) {
        assertString(metadata.publisher.url, 'publisher.url', 8, 300)
        let url
        try { url = new URL(metadata.publisher.url) } catch { fail('publisher.url must be an absolute URL') }
        if (!['https:', 'http:'].includes(url.protocol)) fail('publisher.url must use http or https')
      }
      if (!Array.isArray(metadata.tags) || metadata.tags.length > 12 || metadata.tags.some(tag => typeof tag !== 'string' || !TAG_RE.test(tag))) {
        fail(`${slugDir}/${versionDir} tags must be at most 12 lowercase slugs`)
      }
      if (new Set(metadata.tags).size !== metadata.tags.length) fail(`${slugDir}/${versionDir} contains duplicate tags`)
      if (typeof metadata.published_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(metadata.published_at) || Number.isNaN(Date.parse(`${metadata.published_at}T00:00:00Z`))) {
        fail(`${slugDir}/${versionDir} published_at must be YYYY-MM-DD`)
      }
      assertPublicText(JSON.stringify(metadata), `${slugDir}/${versionDir}/metadata.json`)

      const contentBuffer = await readFile(contentPath)
      if (contentBuffer.length === 0 || contentBuffer.length > MAX_CONTENT_BYTES) fail(`${slugDir}/${versionDir}/SKILL.md must be 1-${MAX_CONTENT_BYTES} bytes`)
      const content = contentBuffer.toString('utf8')
      if (Buffer.from(content, 'utf8').compare(contentBuffer) !== 0) fail(`${slugDir}/${versionDir}/SKILL.md must be valid UTF-8`)
      if (content.includes('\0')) fail(`${slugDir}/${versionDir}/SKILL.md contains NUL`)
      assertPublicText(content, `${slugDir}/${versionDir}/SKILL.md`)

      const key = `${metadata.slug}@${metadata.version}`
      if (seen.has(key)) fail(`duplicate public skill ${key}`)
      seen.add(key)
      skills.push({
        ...metadata,
        content_sha256: createHash('sha256').update(contentBuffer).digest('hex'),
        content_url: `/skillhub/skills/${metadata.slug}/${metadata.version}/SKILL.md`,
      })
    }
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug) || a.version.localeCompare(b.version))
  return `${JSON.stringify({ schema_version: 1, generated_from: 'reviewed repository content', skills }, null, 2)}\n`
}

try {
  const expected = await buildCatalog()
  if (CHECK_ONLY) {
    let actual = ''
    try { actual = await readFile(CATALOG_PATH, 'utf8') } catch { fail('catalog.json is missing; run npm run skillhub:build') }
    if (actual !== expected) fail('catalog.json is stale or manually edited; run npm run skillhub:build')
    console.log(`public-skillhub: PASS (${JSON.parse(expected).skills.length} entries, catalog current)`)
  } else {
    await writeFile(CATALOG_PATH, expected, { encoding: 'utf8', mode: 0o644 })
    console.log(`public-skillhub: wrote ${relative(REPO_ROOT, CATALOG_PATH)} (${JSON.parse(expected).skills.length} entries)`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}


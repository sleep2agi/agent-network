#!/usr/bin/env node

// Keep the public repository CLI stable while the canonical validator lives
// inside docs-site, which is the complete filesystem uploaded to Vercel.
import '../docs-site/scripts/build-public-skillhub.mjs'

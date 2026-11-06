#!/usr/bin/env node
/**
 * Guard: every bare import in the Host half (lib/*.js, ESM) must be resolvable
 * inside a dsh profile.
 *
 * dsh resolves two kinds of bare specifiers from a profile-installed plugin:
 *   1. packages listed in `dependencies` — pnpm installs them into the profile;
 *   2. the runtime's own packages, addressed by their published `@deepseek-ai/*`
 *      names (the Host's installation layer answers those requests).
 *
 * Anything else is a silent landmine: pnpm installs nothing for it, and only the
 * dev-injection path (a dsh checkout symlinked into node_modules) hides the bug.
 * That is exactly how `import z from 'schemastery'` shipped in 0.2.1 — the Host
 * ships `@deepseek-ai/schemastery`, not `schemastery`, so the Host half threw
 * ERR_MODULE_NOT_FOUND and the whole plugin (settings page included) never
 * activated.
 *
 * Run: node scripts/check-host-imports.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const installed = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])

/** Host-half entry points: compiled ESM under lib/, excluding the browser bundle. */
const hostFiles = readdirSync(join(root, 'lib'))
  .filter((name) => name.endsWith('.js') && name !== 'client.js')
  .map((name) => join('lib', name))

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

let failed = false
for (const file of hostFiles) {
  const source = readFileSync(join(root, file), 'utf8')
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    if (installed.has(specifier) || specifier.startsWith('@deepseek-ai/')) continue
    console.error(
      `check-host-imports: ${file} imports "${specifier}", which a dsh profile cannot resolve.\n`
        + `  Either declare it in package.json "dependencies", or import the runtime's own package by its\n`
        + `  published scoped name (for example "@deepseek-ai/schemastery" instead of "schemastery").`,
    )
    failed = true
  }
}

if (failed) process.exit(1)
console.log(`check-host-imports: ${hostFiles.length} host files OK`)

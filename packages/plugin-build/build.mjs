#!/usr/bin/env node
/**
 * Prepares the package for use outside a QuadFlow checkout: snapshots the host's shared export
 * list (`public/qf-shared/exports.json`, from scripts/gen-shared-shims.mjs) into
 * `dist/shared-exports.json`, which src/shared.mjs falls back to when no checkout is around.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_DIR, sharedExports } from './src/shared.mjs'

const exportsMap = sharedExports()
mkdirSync(join(PACKAGE_DIR, 'dist'), { recursive: true })
writeFileSync(join(PACKAGE_DIR, 'dist', 'shared-exports.json'), JSON.stringify(exportsMap, null, 2) + '\n')
console.log(`plugin-build: wrote dist/shared-exports.json (${Object.keys(exportsMap).length} shared modules)`)

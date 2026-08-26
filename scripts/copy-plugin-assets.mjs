#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'

const sourceRoot = path.resolve('plugins')
const targetRoot = path.resolve('dist/plugins')
const ignoredDirs = new Set(['data', '.state', 'node_modules'])

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function copyAssets(sourceDir, targetDir) {
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue

    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      await copyAssets(sourcePath, targetPath)
      continue
    }

    if (/\.(ts|js|d\.ts|map)$/i.test(entry.name)) continue

    await fs.mkdir(targetDir, { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
  }
}

if (await exists(sourceRoot)) {
  await copyAssets(sourceRoot, targetRoot)
}

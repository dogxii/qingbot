import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'plugins')
const targetRoot = path.join(root, 'dist', 'plugins')

if (fs.existsSync(sourceRoot)) {
  copyAssets(sourceRoot, targetRoot)
}

function copyAssets(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue

    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      copyAssets(sourcePath, targetPath)
      continue
    }

    if (entry.name.endsWith('.ts')) continue
    fs.copyFileSync(sourcePath, targetPath)
  }
}

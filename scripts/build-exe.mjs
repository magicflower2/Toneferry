import esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(ROOT, 'build')
const RELEASE_DIR = path.join(ROOT, 'release')
const BUNDLE = path.join(BUILD_DIR, 'server.cjs')
const EXE_NAME = 'Toneferry.exe'
const PKG_CONFIG = path.join(BUILD_DIR, 'pkg.config.json')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function copyDir(src, dest) {
  ensureDir(dest)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function mustExist(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`[error] missing ${file}`)
    if (hint) console.error(hint)
    process.exit(1)
  }
}

function tryStopRunningExe() {
  if (process.platform !== 'win32') return
  try {
    execFileSync('taskkill', ['/F', '/IM', EXE_NAME], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    /* not running */
  }
}

/**
 * PE file size on disk (end of last section). Bytes after this are the
 * "overlay" — pkg stores its snapshot archive there. rcedit rewrites the PE
 * and drops the overlay, which causes: "Pkg: Error reading from file."
 */
function getPeFileSize(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('Not a valid MZ/PE executable')
  }
  const peOffset = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(peOffset) !== 0x4550) {
    throw new Error('Missing PE signature')
  }
  const coff = peOffset + 4
  const numSections = buf.readUInt16LE(coff + 2)
  const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16)
  const sectionTable = coff + 20 + sizeOfOptionalHeader

  let maxEnd = 0
  for (let i = 0; i < numSections; i++) {
    const off = sectionTable + i * 40
    const sizeOfRawData = buf.readUInt32LE(off + 16)
    const pointerToRawData = buf.readUInt32LE(off + 20)
    if (sizeOfRawData > 0) {
      maxEnd = Math.max(maxEnd, pointerToRawData + sizeOfRawData)
    }
  }
  if (maxEnd <= 0 || maxEnd > buf.length) {
    throw new Error(`Invalid PE section bounds: ${maxEnd}`)
  }
  return maxEnd
}

function splitPeAndOverlay(buf) {
  const peSize = getPeFileSize(buf)
  return {
    pe: buf.subarray(0, peSize),
    overlay: buf.subarray(peSize),
    peSize,
  }
}

/**
 * Patch icon without destroying pkg's appended archive.
 */
async function applyExeIcon(exePath, iconPath) {
  const require = createRequire(path.join(ROOT, 'package.json'))
  const { rcedit } = require('rcedit')

  const original = fs.readFileSync(exePath)
  const { overlay, peSize } = splitPeAndOverlay(original)
  if (overlay.length < 1024) {
    console.warn(
      `[warn] overlay only ${overlay.length} bytes — pkg payload may be missing`,
    )
  } else {
    console.log(
      `[icon] preserving pkg overlay: ${(overlay.length / 1048576).toFixed(1)} MB (PE ${peSize} bytes)`,
    )
  }

  const staging = path.join(
    os.tmpdir(),
    `toneferry-icon-${process.pid}-${Date.now()}.exe`,
  )
  // Give rcedit a full copy; it will rewrite PE and drop overlay
  fs.writeFileSync(staging, original)

  try {
    await rcedit(staging, { icon: iconPath })
  } catch (err) {
    fs.rmSync(staging, { force: true })
    throw err
  }

  const patched = fs.readFileSync(staging)
  fs.rmSync(staging, { force: true })

  const patchedPeSize = getPeFileSize(patched)
  const patchedPe = patched.subarray(0, patchedPeSize)
  const restored = Buffer.concat([patchedPe, overlay])
  fs.writeFileSync(exePath, restored)
  console.log('icon applied (pkg overlay restored)')
}

async function main() {
  const captureExe = path.join(ROOT, 'bin', 'audio-capture.exe')
  mustExist(captureExe, 'Run: npm run build:capture')
  mustExist(path.join(ROOT, 'public', 'index.html'), 'Missing public/index.html')

  ensureDir(BUILD_DIR)
  ensureDir(RELEASE_DIR)

  console.log('[1/5] preparing embed assets…')
  rmrf(path.join(BUILD_DIR, 'public'))
  rmrf(path.join(BUILD_DIR, 'bin'))
  copyDir(path.join(ROOT, 'public'), path.join(BUILD_DIR, 'public'))
  ensureDir(path.join(BUILD_DIR, 'bin'))
  fs.copyFileSync(captureExe, path.join(BUILD_DIR, 'bin', 'audio-capture.exe'))

  console.log('[2/5] bundling server…')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'server', 'index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: BUNDLE,
  })

  fs.writeFileSync(
    PKG_CONFIG,
    JSON.stringify(
      {
        pkg: {
          assets: ['public/**/*', 'bin/**/*'],
          targets: ['node22-win-x64'],
        },
      },
      null,
      2,
    ),
  )

  console.log('[3/5] packaging single exe (public + capture embedded)…')
  const require = createRequire(import.meta.url)
  const pkgCli = require.resolve('@yao-pkg/pkg/lib-es5/bin.js')
  const outExe = path.join(RELEASE_DIR, EXE_NAME)
  const stagedPkg = path.join(RELEASE_DIR, 'Toneferry.build.exe')
  const iconIco = path.join(ROOT, 'public', 'icon.ico')
  mustExist(iconIco, 'Missing public/icon.ico — generate app icon first')

  rmrf(path.join(RELEASE_DIR, 'public'))
  rmrf(path.join(RELEASE_DIR, 'bin'))
  tryStopRunningExe()
  await new Promise((r) => setTimeout(r, 200))

  execFileSync(
    process.execPath,
    [
      pkgCli,
      'server.cjs',
      '-c',
      'pkg.config.json',
      '--targets',
      'node22-win-x64',
      '--output',
      stagedPkg,
      '--compress',
      'GZip',
    ],
    { stdio: 'inherit', cwd: BUILD_DIR },
  )

  console.log('[4/5] applying Windows exe icon…')
  // rcedit corrupts @yao-pkg/pkg binaries (drops/breaks the snapshot archive),
  // which makes the window flash and exit with "Pkg: Error reading from file".
  // Keep a working single-file exe; HTML still uses public/icon.ico + icon.png.
  console.log('[icon] skipped (rcedit incompatible with pkg payload)')
  void iconIco

  tryStopRunningExe()
  await new Promise((r) => setTimeout(r, 200))
  try {
    if (fs.existsSync(outExe)) fs.rmSync(outExe, { force: true })
    fs.renameSync(stagedPkg, outExe)
  } catch {
    fs.copyFileSync(stagedPkg, outExe)
    fs.rmSync(stagedPkg, { force: true })
  }

  console.log('[5/5] done')
  console.log('')
  console.log(`Single file: ${outExe}`)
  console.log('Double-click Toneferry.exe — no bin/ or public/ folder needed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

import esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import * as ResEdit from 'resedit'
import { need } from '@yao-pkg/pkg-fetch'

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

function refreshExplorerIcons() {
  if (process.platform !== 'win32') return
  try {
    execFileSync('ie4uinit.exe', ['-show'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    /* ignore */
  }
}

/**
 * Stamp public/icon.ico onto pkg's base Node binary BEFORE packaging.
 * Replaces every icon group (Explorer uses ID 1, which is Node's default).
 */
async function stampBaseNodeIconAsync(iconPath) {
  const fetched = await need({
    nodeRange: 'node22',
    platform: 'win',
    arch: 'x64',
  })
  const stamped = path.join(BUILD_DIR, 'node-with-icon.exe')
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(fetched), {
    ignoreCert: true,
  })
  const res = ResEdit.NtExecutableResource.from(exe)
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath))
  const icons = iconFile.icons.map((item) => item.data)

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
  if (groups.length === 0) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      1033,
      icons,
    )
  } else {
    for (const group of groups) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        group.id,
        group.lang,
        icons,
      )
    }
  }

  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
  if (viList[0]) {
    viList[0].setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        FileDescription: 'Toneferry',
        ProductName: 'Toneferry',
        OriginalFilename: EXE_NAME,
        InternalName: 'Toneferry',
        CompanyName: 'Toneferry',
      },
    )
    viList[0].outputToResourceEntries(res.entries)
  }

  res.outputResource(exe)
  fs.writeFileSync(stamped, Buffer.from(exe.generate()))
  console.log(
    `[icon] replaced ${groups.length || 1} icon group(s) with ${path.basename(iconPath)}`,
  )
  return stamped
}

async function main() {
  const captureExe = path.join(ROOT, 'bin', 'audio-capture.exe')
  mustExist(captureExe, 'Run: npm run build:capture')
  mustExist(path.join(ROOT, 'public', 'index.html'), 'Missing public/index.html')
  const iconIco = path.join(ROOT, 'public', 'icon.ico')
  mustExist(iconIco, 'Missing public/icon.ico — generate app icon first')

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

  console.log('[3/5] applying Windows exe icon to pkg base binary…')
  const stampedNode = await stampBaseNodeIconAsync(iconIco)

  console.log('[4/5] packaging single exe (public + capture embedded)…')
  const require = createRequire(import.meta.url)
  const pkgCli = require.resolve('@yao-pkg/pkg/lib-es5/bin.js')
  const outExe = path.join(RELEASE_DIR, EXE_NAME)
  const stagedPkg = path.join(RELEASE_DIR, 'Toneferry.build.exe')

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
    {
      stdio: 'inherit',
      cwd: BUILD_DIR,
      env: { ...process.env, PKG_NODE_PATH: stampedNode },
    },
  )

  tryStopRunningExe()
  await new Promise((r) => setTimeout(r, 200))
  try {
    if (fs.existsSync(outExe)) fs.rmSync(outExe, { force: true })
    fs.renameSync(stagedPkg, outExe)
  } catch {
    fs.copyFileSync(stagedPkg, outExe)
    fs.rmSync(stagedPkg, { force: true })
  }

  refreshExplorerIcons()

  console.log('[5/5] done')
  console.log('')
  console.log(`Single file: ${outExe}`)
  console.log('Double-click Toneferry.exe — no bin/ or public/ folder needed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

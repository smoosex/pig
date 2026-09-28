// Ad-hoc sign packaged macOS apps without selecting an unrelated Keychain identity.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = (context) => {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}

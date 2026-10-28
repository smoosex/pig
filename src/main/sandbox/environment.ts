/** Sandboxed jobs inherit toolchain settings, not the host's arbitrary service credentials. */
const ALLOWED = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'LANGUAGE',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'COLUMNS', 'LINES', 'SSH_AUTH_SOCK',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'BUN_INSTALL', 'PNPM_HOME', 'NVM_DIR', 'VOLTA_HOME',
  'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOMODCACHE', 'GOCACHE',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'UV_CACHE_DIR', 'PIP_CACHE_DIR',
  'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'PKG_CONFIG_PATH',
  'SDKROOT', 'DEVELOPER_DIR', 'MACOSX_DEPLOYMENT_TARGET', 'ARCHFLAGS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
])

export function sandboxEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => ALLOWED.has(key) || /^LC_[A-Z_]+$/.test(key)))
}

import { expect, test } from 'bun:test'
import { sandboxEnvironment } from '../src/main/sandbox/environment'

test('only toolchain environment reaches sandboxed commands, never arbitrary credentials or startup loaders', () => {
  const env = sandboxEnvironment({
    PATH: '/bin', HOME: '/home/test', LANG: 'en_US.UTF-8', LC_ALL: 'C', CARGO_HOME: '/cache/cargo',
    NODE_OPTIONS: '--import loader', BASH_ENV: 'loader', PIG_DIR: '/private/config',
    DATABASE_URL: 'scheme://sentinel:sentinel@db.example', API_KEY: 'sentinel', ODD_PRIVATE_VALUE: 'sentinel',
    PI_SESSION_ID: 'private-session', ELECTRON_RUN_AS_NODE: '1'
  })
  expect(env).toEqual({ PATH: '/bin', HOME: '/home/test', LANG: 'en_US.UTF-8', LC_ALL: 'C', CARGO_HOME: '/cache/cargo' })
  expect(JSON.stringify(env)).not.toContain('sentinel')
})

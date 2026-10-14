/** Native material capability is shared by settings normalization, window creation and the preload handshake. */
import { release } from 'node:os'

// Windows 11 22H2 still reports NT 10.0; DWM material support starts at build 22621.
export const supportsGlass = process.platform === 'darwin' ||
  (process.platform === 'win32' && Number(release().split('.')[2]) >= 22621)

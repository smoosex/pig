# Application icon

`resources/Icon.icon` is the Apple Icon Composer source bundle for Pig's Jade Quatrefoil icon,
defining both Light (`Assets/jade-light.png`, porcelain + pine-emerald glass) and Dark
(`Assets/jade-dark.png`, forest-obsidian + luminous champagne-jade glass) appearances.
`resources/icon.svg` and `resources/icon-dark.svg` frame those masters inside Apple's `824x824`
continuous squircle for static raster targets.

The committed packaging assets are:
- `build/Assets.car` — macOS Asset Catalog (`CFBundleIconName = Icon`) providing native Light/Dark/Tinted dynamic app icons
- `build/icon.icns` — macOS static fallback icon
- `build/icon.ico` — Windows multi-size icon (16–256px)
- `build/icon.png` — Linux 1024px icon

`electron-builder.yml` bundles these committed files directly so packaging itself requires no Xcode
or image-generation tools.

To regenerate all four on macOS (requires Xcode 26+ `actool`, `librsvg`, and `imagemagick`):

```sh
brew install librsvg imagemagick
bun run app-icons:generate
```

import { describe, expect, test } from 'bun:test'

const DIM = 0x08000000
const INVERSE = 0x04000000
const RGB = 0x03000000
const ANSI = 0x01000000

// Exercise both shipped entry points, not just the package's unbundled TypeScript source.
for (const extension of ['js', 'mjs']) {
  describe(`terminal WebGL background (${extension})`, () => {
    async function bundle(): Promise<string> {
      const file = Bun.resolveSync(`@xterm/addon-webgl/lib/addon-webgl.${extension}`, import.meta.dir)
      return Bun.file(file).text()
    }

    async function background(fg: number, bg: number, defaultBackground = 0) {
      const source = await bundle()
      const method = source.match(/_updateRectangle\([^)]*\)\{[\s\S]*?\}(?=_addRectangle\()/)?.[0]
      if (!method) throw new Error('Missing WebGL rectangle renderer')
      const render = new Function(`
        let h,c,u,d,_,f,g,xe,Hn,Wn,Gn,$n,Kn,Vn;
        return function ${method};
      `)()
      let color: number[] | undefined
      render.call({
        _themeService: { colors: {
          background: { rgba: defaultBackground }, foreground: { rgba: 0x445566ff },
          ansi: Array.from({ length: 16 }, () => ({ rgba: 0x778899ff }))
        } },
        _dimensions: { device: { cell: { width: 8, height: 16 } } },
        _addRectangle: (...args: number[]) => { color = args.slice(-4) }
      }, { attributes: new Float32Array(64) }, 0, fg, bg, 0, 1, 0)
      if (!color) throw new Error('No background rectangle rendered')
      return color
    }

    test('attribute-only cells retain transparent, translucent and opaque default backgrounds', async () => {
      expect(await background(0, DIM)).toEqual([0, 0, 0, 0])
      expect((await background(0, DIM, 0x12345680))[3]).toBe(128 / 255)
      expect((await background(0, DIM, 0x123456ff))[3]).toBe(1)
    })

    test('glyph blending preserves dim and antialiased coverage instead of squaring alpha', async () => {
      const source = await bundle()
      const call = source.match(/(\w+)\.blendFunc(?:Separate)?\([^)]*\)/)
      if (!call) throw new Error('Missing WebGL glyph blending setup')
      let factors: number[] = []
      const gl = {
        SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771, ONE: 1,
        blendFunc: (src: number, dst: number) => { factors = [src, dst, src, dst] },
        blendFuncSeparate: (...values: number[]) => { factors = values }
      }
      new Function(call[1], call[0])(gl)
      const factor = (value: number, alpha: number) => {
        if (value === gl.ONE) return 1
        if (value === gl.SRC_ALPHA) return alpha
        if (value === gl.ONE_MINUS_SRC_ALPHA) return 1 - alpha
        throw new Error('Unexpected blending factor')
      }
      // Model the installed renderer's blend equation over transparent and opaque framebuffer pixels.
      for (const alpha of [1, 0.5, 0.25]) {
        for (const destinationAlpha of [0, 1]) {
          const rgb = 0.3 * factor(factors[0], alpha) + 0.2 * destinationAlpha * factor(factors[1], alpha)
          const coverage = alpha * factor(factors[2], alpha) + destinationAlpha * factor(factors[3], alpha)
          expect(rgb).toBeCloseTo(0.3 * alpha + 0.2 * destinationAlpha * (1 - alpha))
          expect(coverage).toBeCloseTo(alpha + destinationAlpha * (1 - alpha))
          expect(rgb).toBeLessThanOrEqual(coverage)
        }
      }
    })

    test('explicit RGB, ANSI and inverse backgrounds remain opaque', async () => {
      expect(await background(0, RGB | DIM | 0x123456)).toEqual([0x12 / 255, 0x34 / 255, 0x56 / 255, 1])
      expect((await background(0, ANSI | DIM | 1))[3]).toBe(1)
      expect(await background(INVERSE, DIM)).toEqual([0x44 / 255, 0x55 / 255, 0x66 / 255, 1])
      expect((await background(INVERSE | RGB | 0x123456, DIM))[3]).toBe(1)
    })
  })
}

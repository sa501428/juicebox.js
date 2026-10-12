import {describe, it, expect, vi, afterEach} from 'vitest'
import {readFileSync} from 'node:fs'
import HICBrowser from '../js/hicBrowser.js'
import {restoreFixture} from './utils/restoreFixture.js'

const url = 'https://example.org/cis-v10.hic'
const {embed} = restoreFixture(HICBrowser, {suite: 'v10 loading', url})
afterEach(() => vi.unstubAllGlobals())

function serveFixture() {
    const bytes = readFileSync(new URL('./data/v10/cis.hic', import.meta.url))
    vi.stubGlobal('fetch', async (_url, options) => {
        if (options?.method === 'HEAD') return new Response(null, {headers: {'Content-Length': String(bytes.length)}})
        const range = new Headers(options?.headers).get('range')
        const match = /bytes=(\d+)-(\d+)/.exec(range)
        const start = Number(match[1])
        const end = Math.min(Number(match[2]), bytes.length - 1)
        return new Response(bytes.subarray(start, end + 1), {status: 206, headers: {
            'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1)
        }})
    })
}

describe('real HICBrowser loads v10 under Node with a simulated DOM', () => {
    it('opens chromosome zero as a chromosome and offers coarse-to-fine resolutions', async () => {
        serveFixture()
        const browser = embed()
        await browser.loadHicFile({url}, true)
        expect(browser.dataset.hicFile.version).toBe(10)
        expect(browser.state.chr1).toBe(0)
        expect(browser.isWholeGenome()).toBe(false)
        expect(browser.getResolutions().map(r => r.binSize)).toEqual([20, 10])
        const selector = browser.coordinator.widgets.chromosomeSelector
        expect([...selector.xAxisSelector.options].map(option => option.textContent)).toEqual(['chrA', 'chrB'])
        expect(browser.coordinator.widgets.resolutionSelector).toBeDefined()
    })

    it('restores a saved view at the same display resolution', async () => {
        serveFixture()
        const browser = embed()
        await browser.loadHicFile({url, state: {chr1: 0, chr2: 0, zoom: 1, x: 0, y: 0, pixelSize: 1, normalization: 'VC'}}, true)
        expect(browser.dataset.binSizeForZoom(browser.state.zoom)).toBe(10)
        expect(browser.state.normalization).toBe('VC')
        const saved = browser.toJSON()
        expect(saved.state.zoom).toBe(1)
        const restored = embed()
        await restored.loadHicFile({url, state: saved.state}, true)
        expect(restored.dataset.binSizeForZoom(restored.state.zoom)).toBe(10)
        expect(restored.state.normalization).toBe('VC')
    })
})

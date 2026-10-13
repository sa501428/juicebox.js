import {describe, it, expect, vi, afterEach} from 'vitest'
import {readFileSync} from 'node:fs'
import HICBrowser from '../js/hicBrowser.js'
import State from '../js/hicState.js'
import {restoreFixture} from './utils/restoreFixture.js'

const url = 'https://example.org/cis-v10.hic'
const {embed} = restoreFixture(HICBrowser, {suite: 'v10 loading', url})
afterEach(() => vi.unstubAllGlobals())

function serveFixture(name = "cis") {
    const bytes = readFileSync(new URL(`./data/v10/${name}.hic`, import.meta.url))
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
    it('opens appended scaled All at its finest stored resolution and preserves its session IDs', async () => {
        serveFixture('pseudo-all')
        const browser = embed()
        await browser.loadHicFile({url}, true)
        expect(browser.state.chr1).toBe(2)
        expect(browser.state.chr2).toBe(2)
        expect(browser.state.zoom).toBe(0)
        expect(browser.isWholeGenome()).toBe(true)
        expect(browser.binSizeForZoom()).toBe(1)
        expect(browser.getResolutions()).toEqual([{index: 0, binSize: 10}])
        expect(browser.genomicState('x').bpp).toBe(10 / browser.state.pixelSize)
        expect(browser.genomicState('x').chromosome.size).toBe(180)
        expect(browser.dataset.binSizeForZoom(0, 0)).toBe(100)
        expect(browser.state.getLocus(browser.dataset, {width: 10, height: 10}).x.chr).toBe('All')
        const matrix = await browser.dataset.getMatrix(2, 2)
        expect(matrix.bpZoomData.map(z => z.zoom.binSize)).toEqual([1])
        expect(matrix.getZoomDataByIndex(0).resolutionIndex).toBe(0)
        const options = browser.coordinator.widgets.chromosomeSelector.xAxisSelector.options
        expect([...options].map(o => [o.textContent, o.value])).toEqual([['All', '2'], ['chrA', '0'], ['chrB', '1']])
        expect(browser.genome.getChromosomeForCoordinate(0).name).toBe('chrA')
        expect(browser.genome.getChromosomeForCoordinate(100).name).toBe('chrB')
        const saved = browser.toJSON()
        expect(saved.state.chr1).toBe(2)
        await browser.setState(State.fromJSON({...saved.state, zoom: 4}))
        expect(browser.state.zoom).toBe(0)
    })

    it('fits a stored All grid larger than the viewport using fractional display pixels', async () => {
        serveFixture('pseudo-all')
        const browser = embed()
        vi.spyOn(browser.contactMatrixView, 'getViewDimensions').mockReturnValue({width: 9, height: 9})
        await browser.loadHicFile({url}, true)
        expect(browser.state.pixelSize).toBe(0.5)
        expect(browser.state.getLocus(browser.dataset, {width: 9, height: 9}).x.end).toBe(18)
        expect(browser.genomicState('x').endBP).toBe(180)
    })

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

describe('kilobase All viewport', () => {
    it('fits the full compact axis including a partial terminal bin', async () => {
        const browser = {
            dataset: {
                chromosomes: [{index: 0, name: 'All', size: 3088286}],
                allOverview: {version: 2, binCount: 499},
                isWholeGenome: index => index === 0
            },
            contactMatrixView: {getViewDimensions: () => ({width: 500, height: 600})}
        }
        expect(await HICBrowser.prototype.minPixelSize.call(browser, 0, 0, 0)).toBe(500 / 499)
    })
})

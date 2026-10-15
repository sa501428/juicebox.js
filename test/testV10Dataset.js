import {describe, it, expect, vi, afterEach} from 'vitest'
import {readFileSync} from 'node:fs'
import {File as NativeFile} from 'node:buffer'
import {HiCDataset} from '../js/hicDataset.js'
import ImageTileSource from '../js/imageTileSource.js'
import ColorScale from '../js/colorScale.js'
import {autoThreshold} from '../js/imageTileCore.js'
import ChromosomeSelector from '../js/chromosomeSelector.js'
import InteractionHandler from '../js/interactionHandler.js'
import {createGestureBrowser} from './utils/gestureBrowser.js'

const region = (chr = 'chrA', start = 0, end = 80) => ({chr, start, end})
function bytesFor(name) {
    return readFileSync(new URL(`./data/v10/${name}.hic`, import.meta.url))
}
async function load(name = 'cis') {
    const bytes = bytesFor(name)
    const dataset = new HiCDataset({name, file: {
        size: bytes.length,
        async read(position, length) {
            const part = bytes.subarray(position, position + length)
            return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
        }
    }})
    await dataset.init()
    return dataset
}
const triples = records => records.map(r => [r.bin1, r.bin2, r.counts])

function raster(dimension) {
    const buffer = {width: dimension, height: dimension, data: new Uint8ClampedArray(dimension * dimension * 4)}
    return {width: dimension, height: dimension, buffer, getContext: () => ({
        getImageData: () => buffer, putImageData: () => {}
    })}
}

afterEach(() => vi.unstubAllGlobals())

describe('v10 dataset and rendering integration', () => {
    it('maps coarse-to-fine display zooms without changing wire indices', async () => {
        const dataset = await load()
        expect(dataset.bpResolutions).toEqual([20, 10])
        expect(dataset.hicFile.bpResolutions).toEqual([10, 20])
        const matrix = await dataset.getMatrix(0, 0)
        expect(await dataset.getMatrix(0, 0)).toBe(matrix)
        expect(matrix.getZoomDataByIndex(0).zoom).toEqual({index: 0, unit: 'BP', binSize: 20})
        expect(matrix.getZoomDataByIndex(1).zoom.binSize).toBe(10)
        expect(matrix.getZoomData(20)).toBe(matrix.getZoomDataByIndex(0))
        expect([5, 10, 15, 20, 30].map(b => matrix.findZoomForResolution(b))).toEqual([1, 1, 0, 0, 0])
        const wireMatrix = await dataset.hicFile.getMatrix(0, 0)
        expect(wireMatrix.getZoomDataByIndex(0).zoom.binSize).toBe(10)
        expect(wireMatrix.getZoomDataByIndex(1).resolutionIndex).toBe(1)
        expect(wireMatrix.getZoomDataByIndex(1).zoom.index).toBe(1)
    })

    it('leaves legacy resolutions, matrices, and records unchanged', async () => {
        const dataset = await load('legacy-v8')
        expect(dataset.hicFile.version).toBeLessThan(10)
        expect(dataset.bpResolutions).toBe(dataset.hicFile.bpResolutions)
        expect(await dataset.getMatrix(0, 0)).toBe(await dataset.hicFile.getMatrix(0, 0))
        const legacyRegion = {chr: '0', start: 0, end: 100000000}
        const records = await dataset.getContactRecords('NONE', legacyRegion, legacyRegion, 'BP', 10000)
        expect(records).toHaveLength(2500)
        expect(records[0].counts).toBeTypeOf('number')
    })

    it('queries materialized, derived, and normalized contacts through Straw', async () => {
        const dataset = await load()
        expect(triples(await dataset.getContactRecords('NONE', region(), region(), 'BP', 10)))
            .toEqual([[0, 0, 1], [1, 2, 1], [3, 3, 5]])
        expect(triples(await dataset.getContactRecords('NONE', region(), region(), 'BP', 20)))
            .toEqual([[0, 0, 1], [0, 1, 1], [1, 1, 5]])
        expect(await dataset.getNormalizationOptions()).toEqual(['NONE', 'VC'])
        expect(await dataset.hasNormalizationVector('VC', 'chrA', 'BP', 10)).toBe(true)
        expect((await dataset.getContactRecords('VC', region(), region(), 'BP', 10)).map(r => r.counts))
            .toEqual([0.25, 0.25, 1.25])
    })

    it('exposes FRAG zooms and contacts alongside BP zooms', async () => {
        const dataset = await load('frag')
        expect(dataset.fragResolutions).toEqual([1])
        const matrix = await dataset.getMatrix(0, 0)
        expect(matrix.getZoomDataByIndex(0, 'FRAG').zoom.binSize).toBe(1)
        expect(matrix.findZoomForResolution(1, 'FRAG')).toBe(0)
        expect((await dataset.getContactRecords('NONE', region(), region(), 'FRAG', 1)).length).toBeGreaterThan(0)
    })

    it.each(['A', 'AOB', 'BOA', 'AMB'])('renders large counts in display mode %s', async displayMode => {
        const dataset = await load('bigint')
        const controlDataset = await load()
        const comparisonScale = {getColor: value => {
            expect(Number.isFinite(value)).toBe(true)
            return {red: 255, green: 0, blue: 0, alpha: 255}
        }}
        const source = new ImageTileSource({
            colorScale: new ColorScale({threshold: 5, r: 255, g: 0, b: 0}),
            ratioColorScale: comparisonScale, diffColorScale: comparisonScale,
            createTile: raster, tileDimension: 4
        })
        let painted = false
        for await (const tile of source.tilesFor({dataset, controlDataset, displayMode,
            state: {chr1: 0, chr2: 0, zoom: 1, x: 0, y: 0, pixelSize: 1, normalization: 'NONE'},
            viewDimensions: {width: 4, height: 4}
        })) painted ||= tile.image.buffer.data.some(v => v > 0)
        expect(painted).toBe(true)
    })

    it('canonicalizes upper-triangle cis records for the tile painter', async () => {
        const dataset = await load()
        const above = await dataset.getContactRecords('NONE', region('A', 20, 30), region('chrA', 10, 20), 'BP', 10)
        expect(triples(above)).toEqual([[1, 2, 1]])
        expect(above[0].getKey()).toBe('1_2')
        expect(triples(await dataset.straw.getContactRecords('NONE', region('A', 20, 30), region('chrA', 10, 20), 'BP', 10)))
            .toEqual([[2, 1, 1]])
    })

    it.each([10, 20])('matches legacy color-scale samples at %i BP, including overlapping cis windows', async binSize => {
        const dataset = await load()
        // Make the reflected-only contact large enough to change the percentile.
        // Read positions and normalization through the real v10 decoder.
        const query = dataset.straw.getContactRecords.bind(dataset.straw)
        vi.spyOn(dataset.straw, 'getContactRecords').mockImplementation(async (...args) =>
            (await query(...args)).map(record => {
                if (record.bin1 !== record.bin2) record.counts *= 100
                return record
            }))
        const raw = await dataset.straw.getContactRecords('NONE', region(), region(), 'BP', binSize)
        // Exercise the real legacy filtering/normalization code on the same
        // contacts, without needing a second binary fixture for every window.
        const legacy = new HiCDataset({file: {}})
        legacy.hicFile = legacy.straw.hicFile
        Object.assign(legacy.hicFile, {
            initialized: true, version: 9,
            chromosomeIndexMap: dataset.hicFile.chromosomeIndexMap,
            chrAliasTable: dataset.hicFile.chrAliasTable,
            getBlocks: async () => [{records: raw}],
            getNormalizationVector: dataset.hicFile.getNormalizationVector.bind(dataset.hicFile)
        })
        const narrowEnd = binSize === 10 ? 2 * binSize : binSize
        const windows = [
            [region('chrA', 0, 3 * binSize), region('chrA', 0, narrowEnd)],
            [region('chrA', 0, narrowEnd), region('chrA', 0, 3 * binSize)],
            [region(), region()],
            [region('chrA', binSize, 3 * binSize), region('chrA', 0, binSize)]
        ]
        for (const normalization of ['NONE', 'VC']) {
            for (const [first, second] of windows) {
                const expected = await legacy.getContactRecords(normalization, first, second, 'BP', binSize, true)
                const actual = await dataset.getContactRecords(normalization, first, second, 'BP', binSize, true)
                expect(triples(actual)).toEqual(triples(expected))
                expect(autoThreshold(actual, {})).toBe(autoThreshold(expected, {}))
            }
        }
        // The normal rendering query must retain the mirrored contact.
        const [first, second] = windows[0]
        expect((await dataset.getContactRecords('NONE', first, second, 'BP', binSize)).length)
            .toBeGreaterThan((await dataset.getContactRecords('NONE', first, second, 'BP', binSize, true)).length)
    })

    it('keeps trans contacts in caller chromosome order', async () => {
        const dataset = await load('trans')
        const records = await dataset.getContactRecords('NONE', region('chrB', 0, 70), region(), 'BP', 10)
        expect(triples(records)).toEqual([[0, 0, 1], [2, 1, 1], [3, 3, 5]])
    })

    it('converts large counts for display while preserving exact Straw records', async () => {
        const dataset = await load('bigint')
        const records = await dataset.getContactRecords('NONE', region(), region(), 'BP', 10)
        expect(typeof records[0].counts).toBe('number')
        expect(records[0].getKey()).toBe('0_0')
        const exact = await dataset.straw.getContactRecords('NONE', region(), region(), 'BP', 10)
        expect(exact[0].counts).toBe((1n << 53n) + 1n)
    })

    it('renders both cis triangles and derived zooms without a canvas or browser', async () => {
        const dataset = await load()
        for (const [zoom, binSize, column, row] of [[1, 10, 0, 0], [1, 10, 2, 1], [1, 10, 1, 2], [0, 20, 0, 0]]) {
            const dimension = column === 0 ? 4 : 1
            const source = new ImageTileSource({colorScale: new ColorScale({threshold: 5, r: 255, g: 0, b: 0}), createTile: raster, tileDimension: dimension})
            const tiles = []
            for await (const tile of source.tilesFor({dataset, state: {
                chr1: 0, chr2: 0, zoom, x: column * dimension, y: row * dimension, pixelSize: 1, normalization: 'NONE'
            }, displayMode: 'A', viewDimensions: {width: dimension, height: dimension}})) tiles.push(tile)
            expect(tiles[0].binSize).toBe(binSize)
            expect([...tiles[0].image.buffer.data].some(v => v !== 0)).toBe(true)
            // No x4 heuristic for chromosome zero without All. In the
            // overlapping upper window the legacy scale sample is empty,
            // so retain the starting threshold while still painting contacts.
            expect(source.colorScale.threshold).toBe(column === 1 ? 1 : 5)
        }
    })

    it('paints stored All from its finest synthetic zoom with no screen or canvas', async () => {
        const dataset = await load('pseudo-all')
        const source = new ImageTileSource({colorScale: new ColorScale({threshold: 5, r: 255, g: 0, b: 0}), createTile: raster, tileDimension: 32})
        const state = {chr1: 2, chr2: 2, zoom: 0, x: 0, y: 0, pixelSize: 1, normalization: 'NONE'}
        source.setColorScale(source.colorScale, 'A', state)
        const tiles = []
        for await (const tile of source.tilesFor({dataset, state,
            displayMode: 'A', viewDimensions: {width: 32, height: 32}})) tiles.push(tile)
        expect(tiles[0].binSize).toBe(1)
        expect(tiles[0].image.buffer.data.filter((v, i) => i % 4 === 3 && v > 0).length).toBe(6)
    })

    it('paints V9-style kb All as compact bins while Straw retains sparse finest coordinates', async () => {
        const dataset = await load('kilobase-all')
        expect(dataset.wholeGenomeChromosome.size).toBe(170)
        expect(dataset.binSizeForZoom(0, 2)).toBe(17)
        const matrix = await dataset.getMatrix(2, 2)
        expect(matrix.bpZoomData.map(z => z.zoom.binSize)).toEqual([17])
        expect(matrix.bpZoomData[0].averageCount).toBe(Number((1n << 53n) + 49n) / 100)
        const records = await dataset.getContactRecords('NONE', region('All', 0, 170), region('All', 0, 170), 'BP', 17)
        expect(records.map(r => [r.bin1, r.bin2])).toEqual([[0, 1], [5, 9]])
        const exact = await dataset.straw.getContactRecords('NONE', region('All', 0, 170), region('All', 0, 170), 'BP', 1)
        expect(exact.map(r => [r.bin1, r.bin2])).toEqual([[0, 17], [85, 153]])
        expect(exact[0].counts).toBe((1n << 53n) + 17n)
        const source = new ImageTileSource({colorScale: new ColorScale({threshold: 5, r: 255, g: 0, b: 0}), createTile: raster, tileDimension: 16})
        const state = {chr1: 2, chr2: 2, zoom: 0, x: 0, y: 0, pixelSize: 1, normalization: 'NONE'}
        source.setColorScale(source.colorScale, 'A', state)
        const tiles = []
        for await (const tile of source.tilesFor({dataset, state,
            displayMode: 'A', viewDimensions: {width: 16, height: 16}})) tiles.push(tile)
        expect(tiles[0].binSize).toBe(17)
        expect(tiles[0].image.buffer.data.filter((v, i) => i % 4 === 3 && v > 0).length).toBe(4)
    })

    it('selects the preserved legacy All matrix rather than empty global levels after conversion', async () => {
        const dataset = await load('legacy-all')
        expect(dataset.allOverview).toBeUndefined()
        const all = dataset.wholeGenomeChromosome
        expect(all.index).toBe(0)
        const matrix = await dataset.getMatrix(all.index, all.index)
        expect(matrix.bpZoomData.map(z => z.zoom.binSize)).toEqual([35])
        expect(dataset.binSizeForZoom(0, all.index)).toBe(35)
        expect(dataset.wholeGenomeResolution).toBe(35000)
        const records = await dataset.getContactRecords('NONE', {chr: all.name, start: 0, end: all.size},
            {chr: all.name, start: 0, end: all.size}, 'BP', 35)
        expect(records).toHaveLength(3)
    })

    it('compares matching physical All layouts with different synthetic finest bins', async () => {
        const dataset = await load('pseudo-all')
        const controlDataset = await load('pseudo-all-finest2')
        const query = vi.spyOn(controlDataset, 'getContactRecords')
        const source = new ImageTileSource({colorScale: new ColorScale({threshold: 5, r: 255, g: 0, b: 0}), createTile: raster, tileDimension: 32})
        const state = {chr1: 2, chr2: 2, zoom: 0, x: 0, y: 0, pixelSize: 1, normalization: 'NONE'}
        for await (const tile of source.tilesFor({dataset, controlDataset, state,
            displayMode: 'B', viewDimensions: {width: 32, height: 32}})) {
            expect(tile.binSize).toBe(2)
        }
        expect(query.mock.calls.at(-1)[4]).toBe(2)
        expect(query.mock.calls.some(call => call[1].chr === 'All' && call[1].start === 0 && call[1].end === 64)).toBe(true)
        controlDataset.allOverview = {...controlDataset.allOverview, groupFactor: 2}
        await expect((async () => {
            for await (const tile of source.tilesFor({dataset, controlDataset, state,
                displayMode: 'B', viewDimensions: {width: 32, height: 32}})) void tile
        })()).rejects.toThrow('matching stored All layouts')
    })

    it('loads a local File through the same blob path used by juicebox-web', async () => {
        const bytes = bytesFor('cis')
        const file = new NativeFile([bytes], 'cis-v10.hic')
        const dataset = await HiCDataset.loadDataset({url: file, name: file.name})
        expect(dataset.hicFile.version).toBe(10)
        expect(dataset.bpResolutions).toEqual([20, 10])
    })

    it('loads and queries a URL with HTTP ranges', async () => {
        const bytes = bytesFor('cis')
        const ranges = []
        vi.stubGlobal('fetch', async (_url, options) => {
            const range = new Headers(options?.headers).get('range')
            if (options?.method === 'HEAD') return new Response(null, {headers: {'Content-Length': String(bytes.length)}})
            const match = /bytes=(\d+)-(\d+)/.exec(range)
            ranges.push(range)
            const start = Number(match[1])
            const end = Math.min(Number(match[2]), bytes.length - 1)
            return new Response(bytes.subarray(start, end + 1), {status: 206, headers: {
                'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1)
            }})
        })
        const dataset = await HiCDataset.loadDataset({url: 'https://example.org/cis-v10.hic', name: 'remote'})
        expect(triples(await dataset.getContactRecords('NONE', region(), region(), 'BP', 20)))
            .toEqual([[0, 0, 1], [0, 1, 1], [1, 1, 5]])
        expect(ranges.length).toBeGreaterThan(1)
    })

    it('does not couple chromosome zero to the other axis when All is absent', async () => {
        const dataset = await load('trans')
        const selector = Object.create(ChromosomeSelector.prototype)
        selector.browser = {dataset}
        const target = {value: '1'}
        selector.syncSelectors({value: '0'}, target)
        expect(target.value).toBe('1')
    })

    it.each(['pinchZoom', '_performWheelZoom'])('%s keeps a file without All on its chromosome', async method => {
        const browser = createGestureBrowser()
        browser.dataset.wholeGenomeChromosome = undefined
        browser.dataset.isWholeGenome = () => false
        const handler = new InteractionHandler(browser)
        const setChromosomes = vi.spyOn(handler, 'setChromosomes')
        await handler[method](400, 400, 0.1)
        expect(setChromosomes).not.toHaveBeenCalled()
        expect(browser.state.chr1).toBe(1)
    })
})

describe('control maps with reversed chromosome order', () => {
    it('renders B with the active map\'s named axes even when B stores the trans pair in reverse', async () => {
        const controlDataset = await load('trans')
        const dataset = Object.create(controlDataset)
        dataset.chromosomes = [
            {...controlDataset.chromosomes[1], index: 0},
            {...controlDataset.chromosomes[0], index: 1}
        ]
        const source = new ImageTileSource({
            colorScale: new ColorScale({threshold: 5, r: 255, g: 0, b: 0}),
            createTile: raster, tileDimension: 4
        })
        const tiles = []
        for await (const tile of source.tilesFor({dataset, controlDataset, displayMode: 'B',
            state: {chr1: 0, chr2: 1, zoom: 1, x: 0, y: 0, pixelSize: 1, normalization: 'NONE'},
            viewDimensions: {width: 4, height: 4}
        })) tiles.push(tile)
        const image = tiles.find(t => t.row === 0 && t.column === 0).image.buffer
        expect(image.data[(1 * 4 + 2) * 4 + 3]).toBeGreaterThan(0)
        expect(image.data[(2 * 4 + 1) * 4 + 3]).toBe(0)
    })

    it.each([8, 9])('orients legacy V%i trans records to the requested chromosome names', async version => {
        class Record {
            constructor() { this.bin1 = 1; this.bin2 = 2; this.counts = 7 }
            getKey() { return `${this.bin1}_${this.bin2}` }
        }
        const raw = new Record()
        const dataset = Object.create(HiCDataset.prototype)
        dataset.hicFile = {version, chromosomeIndexMap: {chrA: 0, chrB: 1}}
        dataset.straw = {getFileChrName: name => name, getContactRecords: async () => [raw]}
        const records = await dataset.getContactRecords('NONE', region('chrB'), region('chrA'), 'BP', 10)
        expect(triples(records)).toEqual([[2, 1, 7]])
        expect(records[0].getKey()).toBe('2_1')
        expect(raw.getKey()).toBe('1_2')
    })
})

describe('legacy All comparison layout checks', () => {
    it('refuses an overlay when legacy files store real chromosomes in different orders', async () => {
        const dataset = {
            chromosomes: [{name: 'All', index: 0, size: 200}, {name: 'chrA', index: 1, size: 95000}, {name: 'chrB', index: 2, size: 75000}],
            isWholeGenome: i => i === 0, wholeGenomeResolution: 1000
        }
        const controlDataset = {...dataset, chromosomes: [dataset.chromosomes[0],
            {...dataset.chromosomes[2], index: 1}, {...dataset.chromosomes[1], index: 2}]}
        const source = new ImageTileSource({createTile: raster, tileDimension: 4})
        const tiles = source.tilesFor({dataset, controlDataset, displayMode: 'AOB',
            state: {chr1: 0, chr2: 0, zoom: 0}, viewDimensions: {width: 4, height: 4}})
        await expect(tiles.next()).rejects.toThrow('matching stored All layouts')
    })
})

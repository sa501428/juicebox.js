import assert from 'node:assert/strict'
import NodeLocalFile from 'hic-straw/node'
import {registerHooks} from 'node:module'

// igv-utils advertises a browser 'module' entry, but has no Node 'main'. Match
// Vite's resolution for this standalone Node validation script.
registerHooks({resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'igv-utils'
        ? new URL('../node_modules/igv-utils/src/index.js', import.meta.url).href
        : specifier, context)
}})
const {HiCDataset} = await import('../js/hicDataset.js')
const {default: ImageTileSource} = await import('../js/imageTileSource.js')
const {default: ColorScale} = await import('../js/colorScale.js')

const path = process.argv[2]
if (!path) throw new Error('Usage: node scripts/validate-v10.js /path/to/file.hic')
const file = new NodeLocalFile({path})
let bytesRead = 0
const read = file.read.bind(file)
file.read = async (position, length) => {
    bytesRead += length
    return read(position, length)
}
const dataset = new HiCDataset({name: path, file})
await dataset.init()
assert.equal(dataset.hicFile.version, 10)
assert.deepEqual(dataset.bpResolutions, [...dataset.hicFile.bpResolutions].reverse())
const chromosome = dataset.chromosomes.find(chr => !dataset.isWholeGenome(chr.index))
const region = {chr: chromosome.name, start: 0, end: Math.min(100000, chromosome.size)}
const query = (binSize, normalization = 'NONE') => dataset.getContactRecords(normalization, region, region, 'BP', binSize)
const wire = dataset.hicFile.v10
const resolutions = wire.resolutionRecords[0]
for (const descriptor of resolutions.filter(value => value.storageMode === 1)) {
    const binSize = descriptor.binSize
    const alignedEnd = Math.floor(region.end / binSize) * binSize
    if (alignedEnd === 0) continue
    const aligned = {...region, end: alignedEnd}
    const sourceBin = resolutions[descriptor.sourceResolutionIndex].binSize
    const source = await dataset.straw.getContactRecords('NONE', aligned, aligned, 'BP', sourceBin)
    const target = await dataset.straw.getContactRecords('NONE', aligned, aligned, 'BP', binSize)
    const sums = new Map()
    for (const record of source) {
        const key = `${Math.floor(record.bin1 * sourceBin / binSize)}_${Math.floor(record.bin2 * sourceBin / binSize)}`
        sums.set(key, (sums.get(key) || 0n) + BigInt(record.counts))
    }
    assert.deepEqual(new Map(target.map(record => [record.getKey(), BigInt(record.counts)])), sums)
    console.log(`Derived ${binSize} from ${sourceBin}: ${target.length} cells agree exactly`)
}
const binSize = dataset.bpResolutions.find(value => value <= 5000) || dataset.bpResolutions.at(-1)
assert.ok((await query(binSize)).length, 'sample cis query is empty')
const second = dataset.chromosomes.find(chr => chr.index !== chromosome.index && !dataset.isWholeGenome(chr.index))
if (second) {
    const trans = await dataset.getContactRecords('NONE',
        {...region, end: chromosome.size}, {chr: second.name, start: 0, end: second.size},
        'BP', dataset.bpResolutions[0])
    assert.ok(trans.length, 'coarse trans query is empty')
    console.log(`Trans ${chromosome.name}/${second.name}: ${trans.length} cells`)
}
for (const normalization of await dataset.getNormalizationOptions()) {
    if (normalization !== 'NONE' && await dataset.hasNormalizationVector(normalization, chromosome.name, 'BP', binSize)) {
        const records = await query(binSize, normalization)
        assert.ok(records.every(record => Number.isFinite(record.counts)))
        console.log(`Normalization ${normalization}: ${records.length} cells`)
    }
}
const source = new ImageTileSource({
    colorScale: new ColorScale({threshold: 10, r: 255, g: 0, b: 0}),
    tileDimension: 32,
    createTile(dimension) {
        const buffer = {width: dimension, height: dimension, data: new Uint8ClampedArray(dimension * dimension * 4)}
        return {width: dimension, height: dimension, buffer, getContext: () => ({
            getImageData: () => buffer, putImageData: () => {}
        })}
    }
})
let painted = 0
for await (const tile of source.tilesFor({dataset, state: {
    chr1: chromosome.index, chr2: chromosome.index, zoom: dataset.getZoomIndexForBinSize(binSize),
    x: 0, y: 0, pixelSize: 1, normalization: 'NONE'
}, displayMode: 'A', viewDimensions: {width: 32, height: 32}})) {
    painted += tile.image.buffer.data.filter((value, index) => index % 4 === 3 && value > 0).length
}
assert.ok(painted > 0, 'tile contains no painted contacts')
console.log(`Rendered ${painted} pixels at ${binSize} bp; read ${bytesRead} bytes in total`)
console.log(`Validated ${path}; first chromosome ${chromosome.name}; All present: ${Boolean(dataset.wholeGenomeChromosome)}`)

if (dataset.allOverview) {
    const all = dataset.wholeGenomeChromosome;
    const overview = dataset.allOverview;
    const begin = performance.now(), bytesBefore = bytesRead;
    const allRegion = {chr: all.name, start: 0, end: all.size};
    const records = await dataset.straw.getContactRecords('NONE', allRegion, allRegion, 'BP', overview.finestResolution);
    const sum = records.reduce((n, r) => n + BigInt(r.counts), 0n);
    const elapsed = performance.now() - begin, storedBytes = bytesRead - bytesBefore;
    const collapsed = await dataset.straw.getContactRecords('NONE', allRegion, allRegion, 'BP', dataset.bpResolutions[0]);
    assert.equal(collapsed.reduce((n, r) => n + BigInt(r.counts), 0n), sum);
    assert.equal((await dataset.getMatrix(all.index, all.index)).getZoomDataByIndex(0).zoom.binSize, overview.finestResolution);
    let allPixels = 0;
    for await (const tile of source.tilesFor({dataset, state: {
        chr1: all.index, chr2: all.index, zoom: 0, x: 0, y: 0, pixelSize: 1, normalization: 'NONE'
    }, displayMode: 'A', viewDimensions: {width: 32, height: 32}})) {
        allPixels += tile.image.buffer.data.filter((value, index) => index % 4 === 3 && value > 0).length;
    }
    assert.ok(allPixels > 0, 'All tile contains no painted contacts');
    console.log(`Stored All: ${overview.binCount} bins, ${records.length} cells, sum ${sum}, ${storedBytes} bytes, ${elapsed.toFixed(1)} ms, ${allPixels} painted pixels`);
}

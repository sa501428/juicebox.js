import {describe, it, expect} from 'vitest'
import Genome from '../js/genome.js'
import State from '../js/hicState.js'
import HICBrowser from '../js/hicBrowser.js'
import {locusForAllBin, allBinForLocus} from '../js/wholeGenomeLocus.js'
import {locusAtPixel, placeLocus} from '../js/crosshairsLocus.js'

function map(names, {resolution = 10, padded = false} = {}) {
    const chromosomes = names.map((name, index) => ({name, index, size: name.toLowerCase() === 'all' ? 200 : 95}))
    const all = chromosomes.find(c => c.name.toLowerCase() === 'all')
    let offset = 0
    const layout = chromosomes.filter(c => c !== all).map(c => {
        const entry = {...c, offset, size: padded ? 100 : c.size}
        offset += entry.size
        return entry
    })
    return {
        chromosomes, wholeGenomeChromosome: all, wholeGenomeResolution: resolution,
        allOverview: {layout}, bpResolutions: [20, 10],
        isWholeGenome: index => index === all?.index,
        isSingleChromosome: () => false,
        binSizeForZoom: (zoom, index) => index === all?.index ? 1 : [20, 10][zoom],
    }
}
function browser(dataset) {
    return {dataset, resolutionLocked: false,
        getResolutions: () => [{index: 0, binSize: 20}, {index: 1, binSize: 10}],
        findMatchingZoomIndex: () => 1, minPixelSize: async () => 0,
        contactMatrixView: {getViewDimensions: () => ({width: 1, height: 1})},
    }
}

describe('synchronization across file chromosome tables', () => {
    it('finds a chromosome by name with All first, last, or absent', async () => {
        const source = map(['All', 'chrA', 'chrB'])
        const state = new State(2, 2, 1, 2, 3, 2, 'NONE')
        for (const names of [['chrB', 'chrA', 'All'], ['chrB', 'chrA']]) {
            const target = map(names)
            const receiver = new State(1, 1, 0, 0, 0, 1, 'NONE')
            await receiver.sync(state.getSyncState(source), browser(target), new Genome('test', target.chromosomes), target)
            expect(target.chromosomes[receiver.chr1].name).toBe('chrB')
            expect(target.chromosomes[receiver.chr2].name).toBe('chrB')
            expect([receiver.x, receiver.y, receiver.pixelSize]).toEqual([2, 3, 2])
        }
    })

    it('lets a V10 panel without All follow an overview publisher by real chromosome names', async () => {
        const source = map(['All', 'chrA', 'chrB'])
        const target = map(['chrA', 'chrB'])
        const receiver = {...browser(target), genome: new Genome('test', target.chromosomes),
            state: new State(0, 0, 1, 0, 0, 1, 'NONE'), update: async () => {},
            coordinator: {onLocusChange: () => {}}}
        await HICBrowser.prototype.syncState.call(receiver, new State(0, 0, 0, 2, 3, 2, 'NONE').getSyncState(source))
        expect([receiver.state.chr1, receiver.state.chr2, receiver.state.x, receiver.state.y]).toEqual([0, 0, 2, 3])
    })

    it('keeps positions with their named axes when a trans pair reverses file order', async () => {
        const source = map(['All', 'chrA', 'chrB'])
        const target = map(['chrB', 'chrA', 'All'])
        const receiver = new State(0, 0, 1, 0, 0, 1, 'NONE')
        await receiver.sync(new State(1, 2, 1, 2, 3, 2, 'NONE').getSyncState(source),
            browser(target), new Genome('test', target.chromosomes), target)
        expect(target.chromosomes[receiver.chr1].name).toBe('chrB')
        expect(target.chromosomes[receiver.chr2].name).toBe('chrA')
        expect([receiver.x, receiver.y]).toEqual([3, 2])
    })

    it('translates an All origin through reordered, padded layouts and different bin units', async () => {
        const source = map(['All', 'chrA', 'chrB'], {padded: true})
        const target = map(['chrB', 'chrA', 'All'], {resolution: 20})
        const published = new State(0, 0, 0, 11, 12, 2, 'NONE').getSyncState(source)
        expect(published.wholeGenomeLocus).toEqual({x: {chr: 'chrB', bp: 10}, y: {chr: 'chrB', bp: 20}})
        const receiver = new State(0, 0, 0, 0, 0, 1, 'NONE')
        await receiver.sync(published, browser(target), new Genome('test', target.chromosomes), target)
        expect([receiver.chr1, receiver.chr2, receiver.zoom]).toEqual([2, 2, 0])
        expect([receiver.x, receiver.y, receiver.pixelSize]).toEqual([0.5, 1, 4])
        expect(locusForAllBin(receiver.x, target)).toEqual({chr: 'chrB', bp: 10})
    })

    it('uses padded layout offsets for crosshairs as well as sync', () => {
        const dataset = map(['chrA', 'chrB', 'All'], {padded: true})
        const genome = new Genome('test', dataset.chromosomes)
        const view = {dataset, genome, state: {chr1: 2, chr2: 2, x: 10, y: 10, pixelSize: 2}, viewDimensions: {width: 20, height: 20}}
        expect(locusAtPixel({x: 2, y: 4}, view)).toEqual({chr1: 'chrB', xBP: 10, chr2: 'chrB', yBP: 20})
        expect(placeLocus({chr1: 'chrB', xBP: 10, chr2: 'chrB', yBP: 20}, view)).toEqual({x: 2, y: 4})
        expect(allBinForLocus({chr: 'missing', bp: 10}, dataset, genome)).toBeUndefined()
        expect(allBinForLocus({chr: 'chrB', bp: 10}, dataset, genome)).toBe(11)
    })
})

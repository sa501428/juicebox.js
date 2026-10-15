/**
 * Juicebox uses coarse-to-fine zoom indices and canonical cis contacts. Keep
 * those display conventions separate from v10's on-disk resolution indices
 * and Straw's caller-oriented, exact contact records.
 */
class V10DisplayMatrix {
    constructor(matrix, allOverview, allChromosome) {
        this.chr1 = matrix.chr1
        this.chr2 = matrix.chr2
        const displayZooms = values => [...values]
            .sort((a, b) => b.zoom.binSize - a.zoom.binSize)
            .map((value, index) => ({...value, zoom: {...value.zoom, index}}))
        const scaledAll = allOverview && matrix.chr1 === allOverview.chromosomeIndex && matrix.chr2 === matrix.chr1
        let bpZooms = matrix.bpZoomData;
        if (scaledAll) bpZooms = bpZooms.filter(zd => zd.zoom.binSize === allOverview.finestResolution)
            .map(zd => ({...zd, zoom: {...zd.zoom, binSize: allOverview.displayResolution ?? allOverview.finestResolution},
                averageCount: Number(zd.sumCounts) / (allOverview.binCount * allOverview.binCount)}));
        else if (allChromosome && matrix.chr1 === allChromosome.index && matrix.chr2 === matrix.chr1) {
            const occupied = bpZooms.filter(zd => zd.occupiedCellCount > 0n);
            const candidates = occupied.length ? occupied : bpZooms;
            const target = allChromosome.size / 500;
            bpZooms = [...candidates].sort((a, b) => Math.abs(a.zoom.binSize - target) - Math.abs(b.zoom.binSize - target)).slice(0, 1);
        }
        this.bpZoomData = displayZooms(bpZooms)
        this.fragZoomData = displayZooms(matrix.fragZoomData)
    }

    getZoomData(binSize, unit = 'BP') {
        return this.#zooms(unit).find(value => value.zoom.binSize === binSize)
    }

    getZoomDataByIndex(index, unit = 'BP') {
        return this.#zooms(unit)[index]
    }

    findZoomForResolution(binSize, unit = 'BP') {
        const values = this.#zooms(unit)
        for (let i = 1; i < values.length; i++) {
            if (values[i].zoom.binSize < binSize) return i - 1
        }
        return values.length - 1
    }

    #zooms(unit) {
        return unit === 'FRAG' ? this.fragZoomData : this.bpZoomData
    }
}

function displayRecords(records, sameChromosome) {
    return records.map(record => {
        // Keep the record's prototype (including getKey), and leave Straw's
        // exact counts untouched. Canvas colors use floating-point arithmetic.
        const display = Object.assign(Object.create(Object.getPrototypeOf(record)), record)
        display.counts = Number(record.counts)
        if (sameChromosome && display.bin1 > display.bin2) {
            [display.bin1, display.bin2] = [display.bin2, display.bin1]
        }
        return display
    })
}

/**
 * Match the legacy reader's canonical cis rectangle for the percentile sample.
 * V10 also returns contacts whose reflection is inside an overlapping window;
 * those are needed for painting but change the legacy color-scale population.
 * A disjoint window above the diagonal is transposed before legacy filtering.
 */
function legacyColorScaleRecords(records, region1, region2, binSize) {
    if (region1.start >= region2.end) [region1, region2] = [region2, region1]
    const x1 = region1.start / binSize, x2 = region1.end / binSize
    const y1 = region2.start / binSize, y2 = region2.end / binSize
    return records.filter(record => record.bin1 >= x1 && record.bin1 < x2 &&
        record.bin2 >= y1 && record.bin2 < y2)
}

export {V10DisplayMatrix, displayRecords, legacyColorScaleRecords}

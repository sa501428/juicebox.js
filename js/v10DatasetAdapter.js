/**
 * Juicebox uses coarse-to-fine zoom indices and canonical cis contacts. Keep
 * those display conventions separate from v10's on-disk resolution indices
 * and Straw's caller-oriented, exact contact records.
 */
class V10DisplayMatrix {
    constructor(matrix) {
        this.chr1 = matrix.chr1
        this.chr2 = matrix.chr2
        const displayZooms = values => [...values]
            .sort((a, b) => b.zoom.binSize - a.zoom.binSize)
            .map((value, index) => ({...value, zoom: {...value.zoom, index}}))
        this.bpZoomData = displayZooms(matrix.bpZoomData)
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

export {V10DisplayMatrix, displayRecords}

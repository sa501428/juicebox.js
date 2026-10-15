/** Translate All bins through the file's stored layout, never chromosome indices. */
function layoutFor(dataset) {
    if (dataset.allOverview) return dataset.allOverview.layout
    let offset = 0
    return dataset.chromosomes.filter(c => !dataset.isWholeGenome(c.index)).map(c => {
        const entry = {...c, offset}
        offset += c.size
        return entry
    })
}

function locusForAllBin(bin, dataset) {
    const coordinate = Math.max(0, bin * dataset.wholeGenomeResolution)
    const layout = layoutFor(dataset)
    const entry = layout.find(c => coordinate < c.offset + c.size) || layout[layout.length - 1]
    if (!entry) return undefined
    const chromosome = dataset.chromosomes[entry.index]
    return {chr: chromosome.name, bp: Math.max(0, Math.min(chromosome.size, coordinate - entry.offset))}
}

function allBinForLocus(locus, dataset, genome) {
    const chromosome = genome.getChromosome(locus.chr)
    if (!chromosome) return undefined
    const entry = layoutFor(dataset).find(c => c.index === chromosome.index)
    return entry ? (entry.offset + Math.min(chromosome.size, Math.max(0, locus.bp))) / dataset.wholeGenomeResolution : undefined
}

export {locusForAllBin, allBinForLocus}

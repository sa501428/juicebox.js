These tiny binary fixtures exercise the real Straw v10 decoder through Juicebox.
`cis.hic`, `trans.hic`, and `bigint.hic` were generated with
`hic-straw-js/test/helpers/v10Fixture.js` from Straw commit
`f6b1c6c`, using these options respectively:

- `{}`
- `{trans: true}`
- `{counts: [(1n << 53n) + 1n, 1n, 5n]}`

They contain 10 BP materialized and 20 BP derived resolutions, VC vectors,
and two chromosomes with no All entry. `frag.hic` adds a 1 FRAG resolution
using `{frag: true}`. `legacy-v8.hic` is copied from Straw's
`test/data/testFiles/testBp.hic` for the unchanged legacy path.

The 4.1 GB acceptance file stays outside the repository. Run
`node scripts/validate-v10.js /path/to/file.hic` with Node 24+ to check that file
without browser access. The script validates exact derived sums, normalization,
a coarse trans query, and rendered tile buffers.

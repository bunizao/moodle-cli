# Terminal table library research

Date: 2026-08-18

## Recommendation

Use **`@oclif/table` 0.5.9** in all three CLIs.

It is the only evaluated package that satisfies the complete contract without rebuilding layout logic: typed object rows, Unicode borders, automatic whole-table terminal-width fitting, a string-returning API, and successful Node 20, Node 22, and Bun execution. Its official API takes `data: object[]`, defaults `maxWidth` to terminal width, shrinks overflowing columns, and exposes `makeTable(): string`; the package is ESM-only and declares Node `>=18` ([README](https://github.com/oclif/table/blob/0.5.9/README.md), [package metadata](https://github.com/oclif/table/blob/0.5.9/package.json)).

The cost is real: 10 direct dependencies, including Ink 5 and React 18, and **51 transitive packages** in a clean npm install. That is still preferable to keeping three handwritten width/border engines. `tty-table` is not the lightweight alternative it appears to be: its clean install had **141 transitive packages**, mainly because the runtime package also ships CSV/CLI dependencies ([package metadata](https://github.com/tecfu/tty-table/blob/5.0.0/package.json)).

## Criteria matrix

Runtime cells marked “pass” were smoke-tested locally with Node 20.20.2, Node 22.23.2, and Bun 1.3.14. Dependency counts are clean npm lockfile package entries excluding the root and target package.

| Package | Node 20/22 + Bun | Bundled TS types | Native object rows | Unicode borders | Fits total terminal width | Returns string | Latest npm publish | Transitive packages |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| `@oclif/table` 0.5.9 | Pass | Yes, generic `TableOptions<T>` | Yes | Yes | **Yes**, `maxWidth` defaults to terminal width | `makeTable()` | 2026-05-23 | **51** |
| `tty-table` 5.0.0 | Pass | Yes, but loose/non-generic | Yes | Yes | Yes in a TTY via percentage width; non-TTY needs `COLUMNS` | `.render()` | 2025-11-09 | **141** |
| `table` 6.9.0 | Pass | Yes | **No**, `any[][]` | Yes | **No**, widths are content-derived or explicitly per-column | `table()` | 2024-12-03 | 16 |
| `console-table-printer` 2.16.1 | Pass | Yes | Yes | Yes | **No**, only per-column `minLen`/`maxLen` | `renderTable()` / `.render()` | 2026-06-08 | **1** |
| `cli-table3` 0.6.5 | Pass | Yes | **No** for normal horizontal object rows | Yes | **No**, requires `colWidths` | `.toString()` | 2024-05-12 | 6 |

Sources: [`@oclif/table` API and width behavior](https://github.com/oclif/table/blob/0.5.9/README.md); [`tty-table` object rows, responsive width, and `render()`](https://github.com/tecfu/tty-table/blob/5.0.0/README.md), including its [80-column non-TTY fallback](https://github.com/tecfu/tty-table/blob/5.0.0/src/format.js#L52-L85); [`table` data and width API](https://github.com/gajus/table/blob/v6.9.0/README.md); [`console-table-printer` object-row and render API](https://github.com/console-table-printer/console-table-printer/blob/v2.16.1/README.md); [`cli-table3` row shapes and width API](https://github.com/cli-table/cli-table3/blob/v0.6.5/README.md). Publish dates and current versions came from the corresponding first-party npm records: [`@oclif/table`](https://www.npmjs.com/package/@oclif/table), [`tty-table`](https://www.npmjs.com/package/tty-table), [`table`](https://www.npmjs.com/package/table), [`console-table-printer`](https://www.npmjs.com/package/console-table-printer), and [`cli-table3`](https://www.npmjs.com/package/cli-table3).

## Width-40 prototype evidence

Both finalists rendered the same two object rows with Unicode box drawing under all three runtimes. Maximum observed line width:

| Finalist | Node 20.20.2 | Node 22.23.2 | Bun 1.3.14 | Result |
| --- | ---: | ---: | ---: | --- |
| `@oclif/table` | 40 | 40 | 40 | Pass |
| `tty-table` | 39 | 39 | 39 | Pass; `COLUMNS=40` supplied because the test process was piped/non-TTY |

Representative `@oclif/table` output:

```text
┌────────────┬──────┬──────────────────┐
│ Course     │ Task │ Due              │
├────────────┼──────┼──────────────────┤
│ Advanced … │ Arc… │ 2026-08-20 23:59 │
├────────────┼──────┼──────────────────┤
│ COMP90000  │ Qui… │ 2026-08-21 09:00 │
└────────────┴──────┴──────────────────┘
```

`table`, `console-table-printer`, and `cli-table3` also returned Unicode-bordered strings successfully in Node 20, Node 22, and Bun, but each misses at least one hard API/layout requirement in the matrix.

One additional candidate, [`terminal-columns` 2.0.0](https://github.com/privatenumber/terminal-columns/tree/v2.0.0), is dependency-free and genuinely responsive, but accepts only `string[][]` and deliberately renders columns without Unicode borders. It is a useful layout primitive, not a complete replacement here.

## Adoption boundary

Keep TTY/JSON selection in `@bunizao/cli-kit`; call `makeTable()` only for the human TTY path. Domain-specific selection of columns, labels, date formatting, URL suppression, and nested sections should remain in each CLI. The library should own width allocation, truncation/wrapping, ANSI-aware measurement, and borders.

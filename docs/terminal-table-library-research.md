# Terminal table library research

Date: 2026-08-18

## Recommendation

Use **`tty-table` 5.0.0** in all three CLIs.

It satisfies the complete rendering contract without rebuilding layout logic: object rows, Unicode borders, automatic whole-table terminal-width fitting, a string-returning API, bundled TypeScript declarations, and successful Node 20, Node 22, and Bun execution. Its official API accepts object rows and fixed or percentage table widths, wraps overflowing cells by default, and exposes `.render(): string` ([README](https://github.com/tecfu/tty-table/blob/5.0.0/README.md), [types](https://github.com/tecfu/tty-table/blob/5.0.0/src/factory.d.ts)). The CLIs pass both `width` and the library's `COLUMNS` fallback so explicit `--table` output remains width-bounded when stdout is not a TTY ([width source](https://github.com/tecfu/tty-table/blob/5.0.0/src/format.js#L52-L85), [defaults](https://github.com/tecfu/tty-table/blob/5.0.0/src/defaults.js)).

The cost is real: a clean install has **141 transitive packages**, mainly because the runtime package also ships CSV/CLI dependencies ([package metadata](https://github.com/tecfu/tty-table/blob/5.0.0/package.json)). `@oclif/table` looked lighter at 51 transitive packages, but it cannot be adopted safely across these repositories: version 0.5.9 fixes Ink 5 and React 18 in its dependency graph, while Edstem's existing `agents` package requires React 19 ([`@oclif/table` metadata](https://github.com/oclif/table/blob/0.5.9/package.json), [`agents` metadata](https://www.npmjs.com/package/agents/v/0.20.1)). A normal npm installation hoisted Ink beside React 19, and `makeTable()` crashed before rendering. Keeping one publishable implementation across all three CLIs is more important than the smaller dependency graph.

## Criteria matrix

Runtime cells marked “pass” were smoke-tested locally with Node 20.20.2, Node 22.23.2, and Bun 1.3.14. Dependency counts are clean npm lockfile package entries excluding the root and target package.

| Package | Node 20/22 + Bun | Bundled TS types | Native object rows | Unicode borders | Fits total terminal width | Returns string | Latest npm publish | Transitive packages |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| `@oclif/table` 0.5.9 | **Fails Edstem dependency integration** | Yes, generic `TableOptions<T>` | Yes | Yes | **Yes**, `maxWidth` defaults to terminal width | `makeTable()` | 2026-05-23 | **51** |
| `tty-table` 5.0.0 | Pass | Yes, but loose/non-generic | Yes | Yes | **Yes**, via table `width` plus the `COLUMNS` fallback | `.render()` | 2025-11-09 | **141** |
| `table` 6.9.0 | Pass | Yes | **No**, `any[][]` | Yes | **No**, widths are content-derived or explicitly per-column | `table()` | 2024-12-03 | 16 |
| `console-table-printer` 2.16.1 | Pass | Yes | Yes | Yes | **No**, only per-column `minLen`/`maxLen` | `renderTable()` / `.render()` | 2026-06-08 | **1** |
| `cli-table3` 0.6.5 | Pass | Yes | **No** for normal horizontal object rows | Yes | **No**, requires `colWidths` | `.toString()` | 2024-05-12 | 6 |

Sources: [`@oclif/table` API and width behavior](https://github.com/oclif/table/blob/0.5.9/README.md); [`tty-table` object rows, responsive width, and `render()`](https://github.com/tecfu/tty-table/blob/5.0.0/README.md), including its [80-column non-TTY fallback](https://github.com/tecfu/tty-table/blob/5.0.0/src/format.js#L52-L85); [`table` data and width API](https://github.com/gajus/table/blob/v6.9.0/README.md); [`console-table-printer` object-row and render API](https://github.com/console-table-printer/console-table-printer/blob/v2.16.1/README.md); [`cli-table3` row shapes and width API](https://github.com/cli-table/cli-table3/blob/v0.6.5/README.md). Publish dates and current versions came from the corresponding first-party npm records: [`@oclif/table`](https://www.npmjs.com/package/@oclif/table), [`tty-table`](https://www.npmjs.com/package/tty-table), [`table`](https://www.npmjs.com/package/table), [`console-table-printer`](https://www.npmjs.com/package/console-table-printer), and [`cli-table3`](https://www.npmjs.com/package/cli-table3).

## Width-40 prototype evidence

Both finalists rendered the same two object rows with Unicode box drawing under all three runtimes in isolated smoke projects. Maximum observed line width:

| Finalist | Node 20.20.2 | Node 22.23.2 | Bun 1.3.14 | Result |
| --- | ---: | ---: | ---: | --- |
| `@oclif/table` | 40 | 40 | 40 | Pass |
| `tty-table` | 39 | 39 | 39 | Pass; `COLUMNS=40` supplied because the test process was piped/non-TTY |

Representative `tty-table` output:

```text
┌──────────────┬─────────────┬──────┐
│ Course       │ Task        │ Due  │
├──────────────┼─────────────┼──────┤
│ Advanced     │ Architectur │ 2026 │
│ algorithms   │ e           │ -08- │
│ and          │ assessment  │ 20   │
│ programming  │             │ 23:5 │
│              │             │ 9    │
└──────────────┴─────────────┴──────┘
```

`table`, `console-table-printer`, and `cli-table3` also returned Unicode-bordered strings successfully in Node 20, Node 22, and Bun, but each misses at least one hard API/layout requirement in the matrix.

One additional candidate, [`terminal-columns` 2.0.0](https://github.com/privatenumber/terminal-columns/tree/v2.0.0), is dependency-free and genuinely responsive, but accepts only `string[][]` and deliberately renders columns without Unicode borders. It is a useful layout primitive, not a complete replacement here.

## Adoption boundary

Keep TTY/JSON selection in `@bunizao/cli-kit`; call `tty-table` only for the human TTY path. Domain-specific selection of columns, labels, date formatting, URL suppression, and nested sections should remain in each CLI. The library owns width allocation, wrapping, ANSI-aware measurement, and borders.

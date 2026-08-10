# Moodle CLI: Agent-First File Download Plan

**Status:** Approved design baseline

**Target release:** Next minor release after `0.7.0`

**Canonical command:** `moodle download`

**Shortcut alias:** `moodle dl`

## 1. Outcome

Add one reliable local-file primitive for agents:

```bash
moodle download <source> [--dest <path>] [--force]
moodle dl <source> [--dest <path>] [--force]
```

The command will resolve one authenticated Moodle file, stream it to local disk, and return a structured receipt. Agents remain responsible for discovering activities, choosing files, creating course or week directories, and iterating folder entries.

This release will not implement a course mirror, folder synchronization engine, or browser-extension-style download manager.

## 2. Command Model

The existing CLI has three kinds of commands:

| Intent | Examples |
|---|---|
| Discover | `moodle units`, `moodle activities UNIT`, `moodle forums UNIT` |
| Inspect | `moodle activities show ID`, `moodle threads show ID`, `moodle URL` |
| Operate | `moodle auth ...`, `moodle mcp ...`, `moodle download ...` |

Download is a cross-cutting operation. A file may come from a resource activity, a Moodle folder, a forum post, or a future assignment attachment. It therefore belongs at the root instead of under a shallow `files` namespace or the narrower `activities` noun.

The direct-URL experience stays intentionally symmetric:

```bash
moodle 'https://school.example.edu/mod/resource/view.php?id=91234' --json
# Inspect the resource.

moodle download 'https://school.example.edu/mod/resource/view.php?id=91234' --json
# Save the resource to local disk.
```

`download` is the canonical name in help, documentation, generated skills, and examples. `dl` is a convenience alias exposed by `moodle commands --json`.

## 3. Product Contract

### 3.1 Accepted sources

The first release accepts:

1. A positive course-module ID for a Moodle resource activity.
2. A same-site `/mod/resource/view.php?id=...` URL.
3. A same-site `/pluginfile.php/...` URL returned by Moodle inspection.

Examples:

```bash
moodle download 91234
moodle download 'https://school.example.edu/mod/resource/view.php?id=91234'
moodle dl 'https://school.example.edu/pluginfile.php/123/mod_resource/content/1/slides.pdf'
```

Numeric input always means a course-module ID. A numeric activity that does not resolve to exactly one downloadable resource fails with a structured usage error and a next-step hint.

### 3.2 Destination semantics

`--dest` is the exact local file path:

```bash
moodle download 91234 --dest './FIT2014/Week 03/slides.pdf'
```

When `--dest` is omitted, the command writes to the current directory using the upstream filename. It must not promise a particular extension before Moodle returns the response metadata.

Global `-o/--output` remains reserved for CLI output. It may write the JSON, YAML, or table receipt to another file, but it never selects the downloaded file destination.

### 3.3 Conflict semantics

- The default is no overwrite.
- An existing destination returns a `usage` error before downloading when the destination is already known.
- `--force` permits atomic replacement.
- Downloads do not require `--yes`; `--force` is the explicit replacement signal.
- Agents should use `--force` only when the user asked to replace the exact target or the agent independently verified that replacement is safe.

### 3.4 Receipt

Successful structured output has this shape:

```json
{
  "file_path": "/absolute/path/slides.pdf",
  "filename": "slides.pdf",
  "bytes_written": 1843200,
  "content_type": "application/pdf",
  "source_url": "https://school.example.edu/mod/resource/view.php?id=91234",
  "final_url": "https://school.example.edu/pluginfile.php/123/mod_resource/content/1/slides.pdf"
}
```

The receipt must not contain Moodle cookies, sesskeys, access tokens, temporary paths, or response headers unrelated to the file.

### 3.5 Error behavior

| Error | Code | Required behavior |
|---|---|---|
| Unsupported source or activity type | `usage` | Explain the accepted source forms |
| Destination exists | `usage` | Suggest a different path or explicit `--force` |
| Moodle session expired | `auth` | Suggest `moodle auth login` |
| Activity or file missing | `not_found` | Identify the unresolved source |
| Moodle rejects the request | `upstream` | Preserve a safe upstream summary |
| Local path cannot be created or written | `config` | Report the absolute destination without exposing temporary paths |
| Request is cancelled | `cancelled` | Remove partial temporary output |

JSON errors continue to use the shared CLI error envelope on stderr.

## 4. File Discovery Contract

Activity detail will expose one uniform file descriptor:

```ts
export interface FileEntry {
  name: string;
  url: string;
  requires_authentication: boolean;
}
```

Resource and folder activity details gain `file_entries` while preserving existing fields for compatibility.

Resource example:

```json
{
  "id": 91234,
  "type": "resource",
  "target_name": "slides.pdf",
  "target_url": "https://school.example.edu/pluginfile.php/.../slides.pdf",
  "file_entries": [
    {
      "name": "slides.pdf",
      "url": "https://school.example.edu/pluginfile.php/.../slides.pdf",
      "requires_authentication": true
    }
  ]
}
```

Folder example:

```json
{
  "id": 45678,
  "type": "folder",
  "files": ["chapter-1.pdf", "chapter-2.pdf"],
  "file_entries": [
    {
      "name": "chapter-1.pdf",
      "url": "https://school.example.edu/pluginfile.php/.../chapter-1.pdf",
      "requires_authentication": true
    },
    {
      "name": "chapter-2.pdf",
      "url": "https://school.example.edu/pluginfile.php/.../chapter-2.pdf",
      "requires_authentication": true
    }
  ]
}
```

The CLI does not recursively download a folder. An agent can inspect `file_entries`, choose destinations, and invoke `moodle download` once per selected file.

## 5. Deep Module Design

The external interface stays small:

```ts
export interface DownloadRequest {
  source: string;
  destination?: string;
  force?: boolean;
}

export interface DownloadReceipt {
  file_path: string;
  filename: string;
  bytes_written: number;
  content_type: string;
  source_url: string;
  final_url: string;
}

export function downloadMoodleFile(
  client: MoodleClient,
  request: DownloadRequest,
  signal?: AbortSignal,
): Promise<DownloadReceipt>;
```

The module hides source resolution, authentication, wrapper parsing, response validation, filename selection, streaming, conflict handling, temporary-file cleanup, and receipt construction.

### 5.1 Authenticated request seam

Refactor the current HTML-only `getAbsolute()` implementation into a general authenticated request implementation that preserves the `Response`:

```text
requestAbsolute(url, init) -> Response
getAbsolute(url)           -> requestAbsolute(url).text()
```

Existing Moodle page and AJAX behavior must remain unchanged. The request implementation continues to own:

- MoodleSession attachment.
- Login redirect detection.
- One browser or Okta reauthentication attempt.
- HTTP error mapping.
- Redirect handling.

The Moodle cookie may only be attached to the configured Moodle origin. Cross-origin redirects must not receive an explicitly forwarded Moodle cookie.

### 5.2 Source resolution

Resolution order:

1. Parse and validate the source.
2. Resolve a numeric ID through existing activity detail behavior.
3. Request the resource wrapper or direct file.
4. Accept an automatic redirect to a non-HTML file response.
5. Otherwise parse `.resourceworkaround`, `.resourcecontent`, or the equivalent direct resource link.
6. Request the resolved file URL with the authenticated request implementation.
7. Reject a login page or unresolved HTML wrapper before opening the destination.

The first release rejects folder activity IDs, external URL activities, Page activities, LTI activities, and Panopto links. Folder files remain downloadable through their individual `file_entries` URLs.

### 5.3 Filename selection

Filename precedence:

1. An explicit `--dest` basename.
2. `Content-Disposition`, including RFC 5987 `filename*`.
3. The activity target name.
4. The final URL path basename.
5. A safe `download` fallback only when an explicit destination was provided.

Upstream filenames must be reduced to a basename and stripped of control characters, path separators, `.` and `..`. User-provided destination directories are not silently rewritten.

### 5.4 Local writer

The Node-only writer will follow the proven OnTrack conflict semantics but stream instead of buffering the complete response:

1. Resolve the absolute destination.
2. Preflight an explicit destination when `--force` is absent.
3. Create a unique same-directory temporary file with exclusive creation.
4. Stream the response body while counting bytes.
5. Honor cancellation and propagate stream failures.
6. Without `--force`, promote using an exclusive link so an existing file cannot be replaced.
7. With `--force`, atomically rename the completed temporary file over the destination.
8. Remove the temporary file in every success and failure path.

No filesystem port is introduced. Tests use real temporary directories, keeping the filesystem seam internal to the module.

## 6. CLI Integration

Register one root command in `src/cli.ts`:

```ts
program
  .command("download")
  .alias("dl")
  .argument("<source>", "Course-module ID or authenticated Moodle file URL")
  .option("--dest <path>", "Exact downloaded file path")
  .option("--force", "Atomically replace an existing destination");
```

The command uses the existing output formatter so non-TTY stdout defaults to JSON. Progress and diagnostics go to stderr only and must never corrupt the structured receipt.

`download` is a local write operation, not a Moodle mutation. It does not use the confirmation wrapper and does not change Moodle state.

## 7. Agent Skill Integration

The generated skill bundle must teach the complete workflow rather than merely list the command.

### 7.1 Source templates

Update:

- `src/skill.template.md`
- `src/skills.ts`
- `src/skill-agents/openai.yaml`
- `src/skill-references/coursework-and-grades.md`

Add:

- `src/skill-references/downloads.md`

Register the new reference in `SKILL_BUNDLE_TEMPLATES`, producing:

- `references/downloads.md`

Regenerate:

- `SKILL.md`
- `references/command-reference.md`
- `references/downloads.md`
- `agents/openai.yaml`

### 7.2 Required skill guidance

The skill must say:

1. Use canonical `moodle download` in examples; mention `moodle dl` as an optional alias.
2. Use `moodle activities show ID --json` when the caller has an activity but not a direct file URL.
3. For a single resource, pass its ID or URL to `moodle download`.
4. For a folder, inspect `file_entries`, select files, and call `moodle download` separately for each destination.
5. Preserve existing files by default.
6. Use `--force` only for an explicitly authorized or independently verified replacement.
7. Treat every `file_entries.url` as authenticated Moodle data and never expose session credentials.
8. Validate the receipt and resulting file instead of treating command exit alone as content proof.

The skill description and default prompt will include local file downloads. The shared rule that Moodle operations are read-only will be refined to distinguish remote Moodle mutations from explicit local file writes.

## 8. MCP Evaluation

### Decision

Do not add a `download_file` MCP tool in this release.

### Rationale

The same MCP server runs through local stdio and a remote Cloudflare Worker. A remote Worker cannot write a path on the MCP client's machine. Adding a local-only write tool would make the tool catalog transport-dependent and break parity between local and managed MCP.

Returning file bytes through tool results is also rejected because it would:

- Base64-expand binary content.
- Increase JSON-RPC and client memory pressure.
- Encounter Cloudflare request and response limits.
- Duplicate the CLI's local writer and conflict semantics.
- Expand the credential and data-exposure surface.

The MCP server remains read-only and continues to advertise only tool capabilities.

### Existing tool enhancement

`get_activity` will return the enriched activity detail, including `file_entries`. No new MCP registration or gateway method is necessary because the existing tool already forwards the complete activity object through a loose output schema.

An MCP-only agent may discover and report authenticated file metadata, but it must not claim that a file was downloaded to the user's machine. When local CLI execution is available, the generated skill directs the agent to use `moodle download`.

### Reconsideration criteria

Revisit MCP download support only if one of these becomes true:

1. MCP defines a client-side file sink with an explicit local-write contract.
2. The product introduces a separately authenticated, bounded, short-lived download endpoint.
3. Local and remote transports can provide identical observable behavior without returning large binary tool results.

## 9. Implementation Phases

| Phase | Deliverable | Primary files | Exit criteria |
|---|---|---|---|
| 1 | General authenticated response seam | `src/moodle-client-core.ts`, client tests | Existing HTML, AJAX, login retry, and Worker tests remain green |
| 2 | File entry model and parsing | `src/models.ts`, `src/scraper.ts`, activity tests | Resource and folder detail expose compatible `file_entries` |
| 3 | Streaming download module | `src/download.ts`, download tests | Wrapper, redirect, filename, cancellation, conflict, and cleanup tests pass |
| 4 | `download` command and `dl` alias | `src/cli.ts`, CLI contract tests | Canonical and alias invocations produce the same receipt |
| 5 | MCP compatibility proof | MCP gateway/server tests | Tool catalog remains read-only and `get_activity` exposes file entries |
| 6 | Generated skill and documentation | skill sources, generated bundle, README | Skill drift check and package smoke pass |
| 7 | Real Moodle smoke | Temporary local destination | A small authenticated Monash resource downloads as a non-HTML, non-empty file |

Logical commits:

```text
refactor(client): centralize authenticated requests
feat(download): add local Moodle file downloads
docs(skill): teach agents the download workflow
```

## 10. Test Matrix

### Resolution

- Numeric resource activity ID.
- Resource wrapper URL.
- Direct pluginfile URL.
- Automatic wrapper redirect.
- Relative resource link in wrapper HTML.
- RFC 5987 and quoted `Content-Disposition` filenames.
- Filename fallback from final URL.
- Unsupported activity type.
- Missing resource target.

### Authentication and security

- Valid cached session.
- Expired session with one successful reauthentication.
- Expired session after failed reauthentication.
- Login page returned with HTTP 200.
- Moodle cookie attached to the configured origin.
- Moodle cookie not explicitly forwarded to another origin.
- Receipt and errors contain no cookie or sesskey.

### Filesystem

- New explicit destination.
- Server-derived default destination.
- Existing destination rejected without `--force`.
- Existing destination atomically replaced with `--force`.
- Cancellation before writing.
- Cancellation during streaming.
- Network failure during streaming.
- No retained temporary file after success or failure.
- Nested explicit destination with a missing parent reports a clear error.

### CLI and agent output

- `moodle download` succeeds.
- `moodle dl` produces equivalent behavior.
- `commands --json` exposes `dl` as an alias.
- Non-TTY output is one parseable JSON receipt.
- `-o/--output` and `--dest` remain distinct.
- Generated command reference includes the canonical command and flags.
- Download reference explains folder iteration and replacement safety.

### MCP

- Tool catalog remains the same ten read-only tools.
- All tools retain read-only annotations.
- `get_activity` includes resource `file_entries`.
- `get_activity` includes folder `file_entries`.
- Discovery does not advertise MCP resources or unsupported file capabilities.

## 11. Quality Gates

```bash
npm run check
npm test
npm run test:mcp
npm run test:worker
npm run build
npm run pack:check
npm run pack:smoke
npm run skill:generate
git diff --exit-code -- SKILL.md references agents/openai.yaml
bunx tsc --noEmit
bunx vitest run
```

The real Moodle smoke must use a temporary directory and verify:

- The receipt path exists.
- The file is non-empty.
- The file is not a Moodle login page or resource wrapper.
- No existing course material was overwritten.
- No credential appears in stdout, stderr, or the saved filename.

## 12. Definition of Done

The feature is complete when an agent can:

```bash
moodle activities show 91234 --json
moodle download 91234 --dest './Course/Week 03/slides.pdf' --json
```

and receive a verified local file plus a structured receipt without manually extracting MoodleSession, scraping a resource wrapper, or risking an implicit overwrite.

For a folder, the agent must be able to:

1. Read `file_entries` from activity detail.
2. Select the relevant files.
3. Choose its own local organization.
4. Download each file through the same canonical command.

The generated skill must teach this workflow, and the MCP server must remain transport-consistent and read-only.

## 13. Product Boundaries

The first release will not include:

- Whole-course or whole-week batch downloads.
- Automatic folder recursion or path planning.
- Type or size filters.
- Incremental synchronization or hashing.
- Panopto video extraction.
- External URL downloads.
- Assignment attachment discovery beyond existing activity behavior.
- Binary MCP tool results.
- A Worker download proxy.
- A transport-specific MCP tool catalog.

## References

- [Monash Moodle Downloader](https://github.com/Zetanegative1/Monash-Moodle-Downloader)
- [OnTrack CLI download commands](https://github.com/bunizao/ontrack-cli/blob/main/src/cli-app.ts)
- [OnTrack CLI atomic file writer](https://github.com/bunizao/ontrack-cli/blob/main/src/resources.ts)
- [Existing Moodle MCP release plan](./moodle-mcp-cloudflare-v0.7.0.md)

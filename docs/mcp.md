# MCP and Codemode

## Settings

- **Settings → MCP** shows added servers as compact rows above the marketplace. Icon actions edit, test, sign in/out and remove; the rightmost switch controls global enablement. The market combines Magpie-inspired featured recipes (without Magpie Image) with explicit searches of the official MCP Registry.
- Add a server using the HTTP/stdio form, one server's JSON, or a complete `mcpServers` object. A JSON import is validated as you save it: a same-name server is shown and only replaced after you confirm it.
- New servers are disabled. Enable them globally or only for a project. Removal deletes Pig configuration, project overrides and saved OAuth credentials, not system runtimes or shared package caches.
- **Settings → General → Codemode** controls the global default, initially off. Enabled Codemode uses `on`, preserving direct tools rather than forcing every operation through scripts.
- **Settings → Project settings → project** overrides global MCP enablement and Codemode. Unset overrides inherit; a project's worktrees share the original project's settings.

Idle sessions reload immediately; active tasks finish before their tool resources reload. Settings show pending sessions. New inputs wait for runtime replacement, including further changes queued during reload. Parsing, IO and inline-extension errors keep the affected session unavailable until a successful reload; they never silently restore defaults or permit prompts against an incomplete runtime. Internal naming/search-test sessions never load these capabilities; ordinary chats inherit global defaults without gaining permission to inspect their scratch directory.

## Storage and security

Pig owns these files under `PIG_DIR` (development: `cwd/.pig`; packaged: `$HOME/.pig`):

| File | Contents |
| --- | --- |
| `mcp.json` | Standard `mcpServers` configuration and global enable flags |
| `mcp-icons.json` | Catalog icon sources by server name, kept out of `mcp.json` |
| `mcp-icons/` | Fetched icon bytes, keyed by source |
| `tool-settings.json` | Global Codemode default and canonical project overrides |
| `mcp-auth.json` | Pi-managed OAuth credentials and client registration |
| `mcp.log` | Pi MCP diagnostic log |

Configuration and credential files are written with owner-only permissions on Unix. Pig does not read/write terminal Pi's MCP configuration or automatically load repository `.pi/mcp.json`. Repository configuration must be explicitly imported. MCP processes run with the user's permissions, not inside the Codemode sandbox.

Local recipes use `npx` or `uvx` with latest package specifications; the launcher owns resolution and caching. Install the launcher separately and make it available in the login shell's `PATH`. Adding a recipe only saves configuration; enabling or testing can launch a process and download its package. Docker-backed Registry entries require Docker. Supported remote transport is streamable HTTP, not legacy SSE.

Marketplace icons come from the listing: the Registry's own HTTPS `icons`, else a GitHub owner's avatar, plus Magpie's featured sources. The renderer only ever holds a `pig-mcp-icon` URL; main resolves and checks the source, follows at most three redirects under the same rule, and caches the bytes under `PIG_DIR`. A blocked address yields the listing's initial instead. Fake IPs that a TUN proxy hands out for every name are treated as proxy-owned space, while naming such an address outright stays blocked; a `ssrf.allowRanges` entry in `web-search.json` exempts ranges explicitly, for MCP connections and icons alike.

HTTP and OAuth requests validate the actual connection's DNS answers, not just the URL before connecting. Loopback, private, link-local and reserved addresses require an explicit dialog grant bound to the origin and exact resolved addresses, for this runtime only. Redirect destinations are checked again; credentials do not cross origins. A changed DNS address needs another grant. Unsupported HTTP transports fail closed rather than falling back to unprotected fetch.

Signing out, removing an HTTP server or replacing its URL revokes old authentication capabilities immediately, waits for outstanding SDK refreshes, then deletes credentials. Old runtimes and delayed sign-in callbacks cannot write tokens back. These security operations may interrupt affected requests even when ordinary configuration reloads are deferred.

The HTTP form's optional API key creates a Bearer authorization header. Custom headers, environment values and advanced OAuth settings can be edited in JSON. Explicit JSON keeps Pi's `$ENV` and `!command` value syntax; catalog defaults and password inputs are escaped as literal values. Check imported commands and expressions before enabling or testing.

## Runtime and display

`src/main/mcp/` owns configuration, catalog conversion, DNS-enforced networking and short-lived management connections. The Pi SDK is pinned to 1.1.0 with a small dependency patch exposing custom fetch for HTTP/OAuth and awaiting browser launch. Upgrading requires porting that patch; silently losing it would bypass the connection policy. `src/main/pi/tool-resources.ts` adds Pi's MCP, tool-search and optional Codemode factories only to user sessions. MCP discovery uses deferred exposure, independent of Codemode; imported codemode exposure is treated as deferred. Hidden/direct exposures remain intact.

QuickJS has no Node, filesystem, network or timer APIs. Scripts access tools through the SDK pipeline and available models through Pi's model runtime. Finished side effects are not rolled back if a script fails.

Nested calls appear in a collapsed list under the parent tool, not as synthetic transcript messages. Live events show parameters, state, duration and errors; replay uses Pi's bounded `nestedCalls` records and indicates omitted/incomplete metadata. Child result bodies are not persisted in those records.

Validation covers configuration isolation and inheritance, serial writes, input/reload races, cancellation, real SDK discovery/direct MCP invocation and QuickJS execution without an external model. A macOS packaged-SDK smoke check also executes QuickJS from ASAR. Real-provider OAuth and UI end-to-end flows require manual verification.

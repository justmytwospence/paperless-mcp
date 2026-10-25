# Deployment

The image is `ghcr.io/justmytwospence/paperless-mcp` (amd64 and arm64), tagged `X.Y.Z`,
`X.Y` and `X`. It serves Streamable HTTP on port 8000, keeps its index in `/data`, and
ships the embedding model, so it needs no network access beyond Paperless.

## Docker Compose

Next to an existing Paperless stack (a two-library version is in [`examples/docker-compose.yaml`](../examples/docker-compose.yaml)):

```yaml
services:
  paperless-mcp:
    image: ghcr.io/justmytwospence/paperless-mcp:3
    restart: unless-stopped
    environment:
      PAPERLESS_URL: http://paperless:8000            # the Paperless service on this network
      PAPERLESS_PUBLIC_URL: https://paperless.example.com
      PAPERLESS_API_KEY: ${PAPERLESS_MCP_TOKEN:?}
      PAPERLESS_MCP_EMBED_THREADS: "4"
      MCP_ALLOWED_HOSTS: paperless-mcp
    volumes:
      - ./mcp-index:/data
    ports:
      - "127.0.0.1:8000:8000"                          # localhost only: see Security
    deploy:
      resources:
        limits: { cpus: "4", memory: 2G }
```

Resources: about 0.8 GB of memory while indexing (model, ONNX buffers and one document's
chunks) and much less when idle; CPU only during indexing. Disk: about 4 KB per chunk,
so roughly 200 MB per 50,000 pages of text. See [Semantic search](semantic-search.md#sizing).

The index can always be rebuilt from Paperless, so there is nothing to back up: delete
`/data/index.db` (or a library's folder) and it starts over.

## Clients

### Streamable HTTP

Point the client at the endpoint: `http://<host>:8000/mcp`, or `/<name>/mcp` for a
library.

```sh
claude mcp add --transport http paperless http://127.0.0.1:8000/mcp      # Claude Code
```

Other clients (Cursor, VS Code, Codex, opencode, Hermes, ...) take the same URL in their
MCP settings.

### Stdio clients

For clients that launch the server themselves (Claude Desktop, and any `command`-style
configuration), run the image with `MCP_TRANSPORT=stdio`:

```json
{
  "mcpServers": {
    "paperless": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT=stdio",
        "-e", "PAPERLESS_URL=https://paperless.example.com",
        "-e", "PAPERLESS_API_KEY=your-token",
        "-v", "paperless-mcp-data:/data",
        "ghcr.io/justmytwospence/paperless-mcp:3"
      ]
    }
  }
}
```

In this mode the index only syncs while the client has the server running, so a first
build takes several sessions. For a large library, run the HTTP server as a service
instead and connect to it. To skip semantic search entirely, add
`"-e", "PAPERLESS_MCP_DATA_DIR="` and drop the volume.

From source, without Docker: `npm ci --ignore-scripts && npm run build`, then
`node dist/index.js` with the same environment.

## Security

**The HTTP transport does not authenticate requests.** Anyone who can reach the port can
use every tool with the server's Paperless token. Pick one:

- **Localhost or a private network only.** Publish the port on `127.0.0.1`, or not at all
  and reach it from containers on the same Docker network. Good for one machine.
- **A VPN or tailnet.** Reachable only from your own devices (WireGuard, Tailscale).
- **An authenticating reverse proxy** in front of it, for remote and hosted clients.
  MCP clients authenticate with OAuth 2.1, so use a proxy that acts as an OAuth
  resource server (for example [agentgateway](https://agentgateway.dev/) with your
  identity provider, such as Authelia, Keycloak or Authentik), and do not publish the
  server's own port.

Whatever the front, set `MCP_ALLOWED_HOSTS` to the Host names the server should answer to.

What the server itself guarantees, whoever is calling:

- **Nothing can be deleted** except a note on a document (which needs `confirm: true`).
  There are no tools that delete documents, tags, correspondents or document types.
  Page deletion and merge or split with `delete_originals` need `confirm: true`.
- **Libraries are enforced in one place**: the client code that talks to Paperless adds
  the library's filter to every document query and checks every document id, so no tool
  can reach a document outside the library.
- **`post_document_from_url` only fetches public addresses.** Private, loopback,
  link-local and other non-global ranges are refused at connect time, on every redirect,
  including DNS answers that change between check and connect.
- **`post_document_from_file` only reads inside an agent's upload folder.**
- **The server never sends document text anywhere but back to the client.** Embeddings
  are computed in-process.

Use a Paperless token whose user can see only what the agents should see: Paperless's own
permissions apply underneath everything above.

## Upgrading

Patch and minor releases are compatible. Index format changes rebuild the index
automatically (it is a cache of Paperless). See the [changelog](../CHANGELOG.md) for each
release.

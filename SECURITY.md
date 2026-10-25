# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/justmytwospence/paperless-mcp/security/advisories/new),
not in a public issue. You should get a reply within a week.

## Model

The server holds a Paperless API token and acts as that user. Its own protections, and
what it leaves to the deployment, are described in
[docs/deployment.md](docs/deployment.md#security). In short:

- The HTTP transport does **not** authenticate; access control is the deployment's job
  (localhost, a private network, or an authenticating proxy).
- Tools cannot delete documents or taxonomy; libraries are enforced centrally;
  URL uploads refuse non-public addresses; file uploads are confined to agent folders;
  no document text is sent anywhere except back to the client.

Reports about any of those guarantees failing are especially welcome.

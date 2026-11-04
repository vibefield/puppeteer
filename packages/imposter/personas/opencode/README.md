# OpenCode Imposter persona

This persona impersonates OpenCode 1.19.5 on its native loopback REST and SSE
surface. Native paths and operation ids live in `http-serve.json`; the shared
transport contains no OpenCode route names. All requests, successful results,
SSE properties, and complete `{id,type,properties}` carriers validate against
the Surface-owned ASM before delivery.

`http-serve.json` also owns every other native spelling the engine needs, so a
second release line is a data change rather than an engine fork:

| `$server` field | 1.19.5 value | What it controls |
| --- | --- | --- |
| `readiness` | `opencode server listening on $origin` | the one stdout line in serve mode |
| `auth.passwordEnv` | `OPENCODE_SERVER_PASSWORD` | one name or an ordered list; the first set variable wins |
| `auth.usernameEnv` | `OPENCODE_SERVER_USERNAME` | optional; without it the username is `defaultUsername` |
| `auth.realm`, `auth.unauthorizedBody` | `opencode`, `{name,data:{message}}` | the 401 challenge and body |
| `envelope` | `payloadKey: properties` | SSE carrier key; optional `clockKey` stamps every frame but the connect frame |
| `attach` | `command: attach`, `--session`, `--dir` | the viewer invocation: a subcommand `command`, or a root `serverFlag` whose directory is the first positional; `promptBody` is the submit template (`$text`, `$messageId`) |

The viewer reaches the server through the routes whose actions are
`session.get`, `session.messages`, `event.subscribe` and `session.prompt`, so
its paths follow the route table too. The session store reduces events through
the envelope codec and never reads a carrier key directly.

Start the backend with the same invocation shape as the real binary:

```sh
OPENCODE_SERVER_PASSWORD='<secret>' \
  ai --opencode serve --hostname 127.0.0.1 --port 0 --pure
```

Readiness is the native `opencode server listening on http://…` stdout line.
The default username is `opencode`; setting no password disables authentication,
matching the upstream server. Durable HTTP state is stored below
`PUPPETEER_IMPOSTER_HOME` when that isolated root is supplied.

The shared viewer attaches to the exact existing session without creating a
second one:

```sh
OPENCODE_SERVER_PASSWORD='<secret>' \
  ai --opencode attach http://127.0.0.1:PORT \
  --dir /workspace --session ses_ID --pure
```

SSE reconnect intentionally replays nothing. The viewer and future adapter
rehydrate messages and session state through REST, reflecting the behavior of
the pinned native server rather than inventing a cursor.

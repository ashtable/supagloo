# supagloo

Tools for Creators, Built on Gloo AI & YouVersion Platform.

This repository is the unifying **pseudo-monorepo** for the Supagloo platform. It doesn't contain application code of its own; instead it pulls the individual apps in as Git submodules and provides the overarching documentation and a Docker Compose file to run the entire platform locally.

## Architecture

Supagloo is composed of three applications, each maintained in its own repository and wired in here as a submodule:

| Submodule | Role | Repository |
| --- | --- | --- |
| [`supagloo-nextjs`](https://github.com/ashtable/supagloo-nextjs) | **UI** — the Next.js web frontend | `ashtable/supagloo-nextjs` |
| [`supagloo-nodejs-api`](https://github.com/ashtable/supagloo-nodejs-api) | **API** — enqueues new DBOS jobs | `ashtable/supagloo-nodejs-api` |
| [`supagloo-nodejs-dbos`](https://github.com/ashtable/supagloo-nodejs-dbos) | **App server** — runs durable functions (e.g. LLM calls) via DBOS | `ashtable/supagloo-nodejs-dbos` |

### How they fit together

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ supagloo-nextjs  │────▶│ supagloo-        │────▶│ supagloo-        │
│ (UI)             │     │ nodejs-api       │     │ nodejs-dbos      │
│                  │     │ (queues jobs)    │     │ (durable funcs,  │
│                  │     │                  │     │  LLM calls)      │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

- The **Next.js** app is the user-facing UI.
- The **Node.js API** accepts requests and queues new DBOS jobs.
- The **Node.js DBOS** app server executes those jobs as durable functions — long-running or failure-sensitive work such as LLM calls.

## Getting started

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/ashtable/supagloo.git
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### Running the platform locally

A Docker Compose file (referencing the submodules) is intended to bring up the entire platform locally. _(Coming soon.)_

### Keeping submodules up to date

```bash
git submodule update --remote --merge
```

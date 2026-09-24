# Task 0.1 — Name Research

Checked: 2026-09-24 UTC

## Recommendation

Use **NexusMycelium** as project name. Use **Agent** as descriptor where needed: `NexusMycelium Agent`.

Recommended identifiers (not applied yet):

- Product: `NexusMycelium`
- CLI: `nexusmycelium`
- GitHub repository: `NexusMycelium`
- Primary domain candidate: `nexusmycelium.com`
- Secondary domains: `nexusmycelium.dev`, `nexusmycelium.ai`, `nexusmycelium.io`

## Collision screen

| Candidate | GitHub | npm | DNS/domain | Result |
|---|---|---|---|---|
| `NexusMycelium` | Exact repository/user handle probes returned 404; GitHub repository search returned 0 exact results | `nexusmycelium` and `nexusmycelium-agent` returned 404 | `nexusmycelium.com`, `.dev`, `.ai`, `.io`: DNS NXDOMAIN; `.com` RDAP 404 | Best available candidate |
| `NexusMycelium Agent` | Exact search returned 0 repositories/users | `nexusmycelium-agent` returned 404 | Long-form domains tested returned NXDOMAIN | Available, but unnecessarily long |
| `Nexus Agent` | Exact repository search returned 586 results; user `nexusagent` exists | `nexus-agent` exists at version 1.3.3; repository points to `Remote-Skills/nexus` | `nexusagent.com`, `.ai`, `.dev`, `.io` resolve; several have live/parked pages | Reject due to collisions |

## Evidence

- GitHub exact repo probe: `https://api.github.com/repos/andrewchattra/nexusmycelium` → `404`
- GitHub exact user probe: `https://api.github.com/users/nexusmycelium` → `404`
- GitHub exact repository search: `https://github.com/search?q=%22NexusMycelium%22&type=repositories` → 0 repositories
- npm registry: `https://registry.npmjs.org/nexusmycelium` → `404`
- npm registry: `https://registry.npmjs.org/nexusmycelium-agent` → `404`
- npm collision: `https://registry.npmjs.org/nexus-agent` → existing `1.3.3`, repository `https://github.com/Remote-Skills/nexus`
- DNS: `https://dns.google/resolve?name=nexusmycelium.com&type=A` → NXDOMAIN (`Status: 3`)
- RDAP: `https://rdap.verisign.com/com/v1/domain/nexusmycelium.com` → `404`
- Collision examples: `https://github.com/nexusagent`, `https://www.npmjs.com/package/nexus-agent`, `https://nexusagent.ai/`

## Decision boundary

This is a collision screen, not trademark clearance. Registrar availability can change. No name, package, scope, repository URL, or domain was changed by this task.

Recommended next action: confirm **NexusMycelium** as final product name, then apply a separate rename task with global search and a test/check gate.

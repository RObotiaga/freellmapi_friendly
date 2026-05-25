# FreeLLMAPI Friendly

FreeLLMAPI Friendly routes OpenAI-compatible chat requests across multiple providers and model routes while preserving operator control over credentials and fallback behavior.

## Language

**Provider**:
An upstream service that can serve model requests through a compatible API. A **Provider** can have many **Provider Keys**.
_Avoid_: platform when discussing the domain; backend when discussing an upstream service.

**Provider Key**:
A credential that allows routing requests through a **Provider**. A **Provider Key** can be usable, invalid, disabled, rate-limited, or unusable without those states meaning the same thing.
_Avoid_: API key when the key belongs to an upstream provider; client key.

**Disabled Provider Key**:
A **Provider Key** that the operator intentionally excludes from routing.
_Avoid_: broken key, invalid key.

**Rate-limited Provider Key**:
A **Provider Key** whose Provider has temporarily refused more requests or tokens for the current quota window. It may become usable again without operator action.
_Avoid_: invalid key, disabled key, broken key.

**Unusable Provider Key**:
A **Provider Key** that cannot currently participate in routing even though the operator did not explicitly disable it. It should be visible to the operator as needing attention, but it should not block the router from trying other keys or model routes.
_Avoid_: disabled key, deleted key.

**Encryption Key**:
The operator-controlled secret used to protect stored **Provider Keys**. It is part of the deployment boundary, not part of the Provider Key data itself.
_Avoid_: provider key, unified key, client key.

**Legacy DB-stored Encryption Key**:
An **Encryption Key** found in an existing local database from older startup behavior. It is a migration state that requires operator action, not a normal runtime source of trust.
_Avoid_: default encryption key, production encryption key.

**Development Encryption Fallback**:
A local-only convenience mode that allows the system to keep an **Encryption Key** in local storage for development or tests. It must be explicitly enabled and is not the normal startup mode.
_Avoid_: default encryption, production fallback.

**First-run Encryption Bootstrap**:
A first-start convenience that creates an **Encryption Key** in the deployment environment when there are no existing **Provider Keys** and no legacy encryption state. It is not a **Development Encryption Fallback** because the Encryption Key is not stored beside Provider Keys in the database.
_Avoid_: development fallback, DB-stored key generation.

**Fallback Chain**:
The ordered set of model routes the router may try for a request. The chain expresses routing preference, not a guarantee that every route is usable at runtime.
_Avoid_: model list, provider list.

## Flagged ambiguities

**Provider Key error**:
An error on a **Provider Key** is not enough to decide whether the key is invalid, disabled, rate-limited, or unusable. Routing decisions must preserve that distinction unless the operator or a later check confirms a narrower state.

**Development mode**:
Development mode means the operator explicitly opted into local-only conveniences. It is not an implicit runtime default and must not silently weaken normal startup behavior.

## Example dialogue

Developer: “A Provider Key failed locally before the request reached the Provider. Should the router stop?”

Domain expert: “No. Treat that key as an Unusable Provider Key for routing and continue through the Fallback Chain. Do not turn it into a Disabled Provider Key unless the operator chooses that explicitly.”

Developer: “A Provider Key hit a quota window. Should the router stop trying it forever?”

Domain expert: “No. Treat it as a Rate-limited Provider Key. It may become usable again when the quota window resets.”

Developer: “Should local development automatically mean the Encryption Key can live beside Provider Keys?”

Domain expert: “Only when the operator explicitly enables the Development Encryption Fallback. Normal startup should require an operator-controlled Encryption Key.”

Developer: “If an older database already contains an Encryption Key, should the system keep using it silently?”

Domain expert: “No. Treat it as a Legacy DB-stored Encryption Key and require the operator to migrate it into the deployment environment.”

Developer: “Can an empty first install create its own Encryption Key?”

Domain expert: “Yes, through First-run Encryption Bootstrap, but only into the deployment environment and only before Provider Keys exist.”
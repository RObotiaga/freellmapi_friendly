# FreeLLMAPI Friendly

FreeLLMAPI Friendly routes OpenAI-compatible chat requests across multiple providers and model routes while preserving operator control over credentials and fallback behavior.

## Language

**Provider**:
An upstream service that can serve model requests through a compatible API. A **Provider** can have many **Provider Keys**.
_Avoid_: platform when discussing the domain; backend when discussing an upstream service.

**Provider Key**:
A credential that allows routing requests through a **Provider**. A **Provider Key** can be usable, invalid, disabled, or unusable without those states meaning the same thing.
_Avoid_: API key when the key belongs to an upstream provider; client key.

**Disabled Provider Key**:
A **Provider Key** that the operator intentionally excludes from routing.
_Avoid_: broken key, invalid key.

**Unusable Provider Key**:
A **Provider Key** that cannot currently participate in routing even though the operator did not explicitly disable it. It should be visible to the operator as needing attention, but it should not block the router from trying other keys or model routes.
_Avoid_: disabled key, deleted key.

**Fallback Chain**:
The ordered set of model routes the router may try for a request. The chain expresses routing preference, not a guarantee that every route is usable at runtime.
_Avoid_: model list, provider list.

## Example dialogue

Developer: “A Provider Key failed locally before the request reached the Provider. Should the router stop?”

Domain expert: “No. Treat that key as an Unusable Provider Key for routing and continue through the Fallback Chain. Do not turn it into a Disabled Provider Key unless the operator chooses that explicitly.”
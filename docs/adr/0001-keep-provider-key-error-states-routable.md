# Keep provider-key error states routable unless confirmed invalid

Provider-key `error` can mean a local decrypt failure, a temporary provider outage, or a quota window such as a free-tier 429. We skip non-decryptable keys for the current routing attempt and surface them as needing attention, but we do not exclude every `error` key from future routing; only confirmed invalid or operator-disabled keys are excluded by default. This preserves recovery from temporary provider and quota failures while preventing one corrupt key from blocking the fallback chain.

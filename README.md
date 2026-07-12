# trek-plugin-testbed

Throwaway artifacts for exercising TREK's plugin **signature / trust** surface locally.
Not real plugins. Safe to delete: `gh repo delete jubnl/trek-plugin-testbed`.

The tarballs live here only because TREK's installer hard-restricts artifact downloads to
GitHub hosts (SSRF allowlist). The registry index itself is served from localhost so it can
be mutated to simulate a key rotation.

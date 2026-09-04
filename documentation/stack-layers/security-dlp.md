---
nav_title: Security DLP
nav_group: stack-layers
nav_group_title: Stack Layers
nav_group_order: 40
nav_order: 50
---
# Security DLP Layer

Source: `layers/security-dlp/`

Owns the fail-closed DLP HTTP client and redaction-safe DLP gate decision. The
Python sidecar remains the runnable service under `apps/dlp-service`.

## Related documentation

- [Security](../stack-architecture/security.md)
- [DLP service](../components/dlp-service.md)
- [API component](../components/api.md)

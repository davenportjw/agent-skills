# Feature Flags Plugin Rules (`feature-flags`)

- When the user asks to inspect, enable, disable, or change a runtime feature flag (`release_channel`, `read_only_mode`, `prod_deploy_guard`, `prefer_uv_pytest`, `strict_tdd`), use `plugins/feature-flags/scripts/flags-cli.mjs` rather than editing `defaults.json`.
- Respect any `[FLAG ...]` directives injected at turn start by the `feature-flags` `PreInvocation` hook. If `read_only_mode=true` is active, do not attempt `write_file` or `edit_file` calls unless the user asks to disable `read_only_mode`.

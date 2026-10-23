# {{name}}

{{description}}

A [QuadFlow](https://github.com/HardHeadHackerHead/QuadFlow) plugin. Id `{{id}}`, created from
the `{{templateName}}` template.

## Develop

```bash
npm install
npm run dev        # rebuild on every change
```

In QuadFlow open **Settings → Plugins → Load unpacked…** and pick this folder. The plugin is
listed with a `dev` badge, and every rebuild hot-reloads it: open tiles remount with their saved
state, and a rebuilt sidecar is restarted.

## Project layout

- `quadflow-plugin.json` — the manifest: id, permissions and everything the plugin contributes.
{{readmeNotes}}
- `assets/icon.svg` — the plugin icon.

## Build, check, release

```bash
npm run build      # production build (+ the sidecar for this machine)
npm run validate   # manifest schema, referenced files, shared-module imports
npm run pack       # release/{{id}}-<version>[-<os>-<arch>].zip + .sha256
```

To publish, attach the zip(s) to a release and list them in a plugin source's `index.json`.
Users add the source under **Settings → Plugins → Sources**.

## Documentation

- [Getting started](https://github.com/HardHeadHackerHead/QuadFlow/blob/main/docs/plugins/getting-started.md)
- [Host API](https://github.com/HardHeadHackerHead/QuadFlow/blob/main/docs/plugins/host-api.md)
- [Manifest reference](https://github.com/HardHeadHackerHead/QuadFlow/blob/main/docs/plugins/manifest-reference.md)
- [Permissions](https://github.com/HardHeadHackerHead/QuadFlow/blob/main/docs/plugins/permissions.md)
- [Publishing](https://github.com/HardHeadHackerHead/QuadFlow/blob/main/docs/plugins/publishing.md)

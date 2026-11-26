// Build the Chinese UI script for the Lab copy from an antigravity-zh checkout.
// Usage: node zh_bundle.mjs <zh-project> <renderer-main.js> <output.js>
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [project, rendererFile, outputFile] = process.argv.slice(2);
if (!project || !rendererFile || !outputFile) {
  throw new Error('Usage: zh_bundle.mjs <zh-project> <renderer-main.js> <output.js>');
}
const load = file => import(pathToFileURL(path.join(project, file)).href);
const { checkUiCompatibility } = await load('src/ui-compatibility.mjs');
const { createRuntimeScript } = await load('src/runtime-script.mjs');
const { isAppPath } = await load('src/app-page.mjs');

// The localization project's content-protection rules decide whether this renderer is safe to translate.
const result = checkUiCompatibility(await readFile(rendererFile, 'utf8'));
if (!result.compatible) {
  throw new Error(`Renderer is not compatible with the Chinese UI: ${result.missing.join(', ')}`);
}

// Same scope as the localization project's CDP injection: only the app's own top-level pages.
// The page origin's port is chosen at runtime, so the scope checks the loopback HTTPS host instead.
const script = `(() => {
${isAppPath.toString()}
function loadChinese() {
  if (window.top !== window || location.protocol !== 'https:' || location.hostname !== '127.0.0.1'
    || !isAppPath(location.pathname)) return;
${await createRuntimeScript()}
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadChinese, { once: true });
else loadChinese();
})();
`;
await writeFile(outputFile, script, 'utf8');

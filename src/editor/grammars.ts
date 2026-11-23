import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import { LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { sql } from '@codemirror/lang-sql';
import { php } from '@codemirror/lang-php';
import { go } from '@codemirror/lang-go';
import { svelte } from '@replit/codemirror-lang-svelte';
import { c, csharp, dart, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { json as permissiveJson } from '@codemirror/legacy-modes/mode/javascript';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { sCSS } from '@codemirror/legacy-modes/mode/css';

const legacy = (parser: StreamParser<unknown>) => () => StreamLanguage.define({
  ...parser, tokenTable: {property:tags.propertyName,...parser.tokenTable},
});
const loaders: Record<string, () => Extension> = {
  Python: python, JavaScript: javascript, JSX: () => javascript({jsx:true}),
  TypeScript: () => javascript({typescript:true}), TSX: () => javascript({jsx:true, typescript:true}),
  Markdown: markdown, HTML: html, CSS: css, XML: xml, JSON: json, JSONC: legacy(permissiveJson), YAML: yaml,
  Svelte: svelte, C: legacy(c), 'C++': cpp, 'C#': legacy(csharp), Rust: rust, Java: java, Go: go,
  PHP: php, SQL: sql, TOML: legacy(toml), INI: legacy(properties), 'Git Config': legacy(properties),
  SCSS: legacy(sCSS), Dockerfile: legacy(dockerFile), Kotlin: legacy(kotlin), Dart: legacy(dart), R: legacy(r),
  PowerShell: legacy(powerShell), Shell: legacy(shell), Ruby: legacy(ruby), Swift: legacy(swift), Lua: legacy(lua),
};
const cache = new Map<string, Extension>();
export function grammar(name: string): Extension {
  let extension = cache.get(name);
  if (!extension) {
    const support = loaders[name]?.();
    // Install editing assistance centrally so the master switch also covers
    // JSX/Svelte tag helpers and Markdown key handling. Parsers retain sublanguages.
    extension = support instanceof LanguageSupport ? support.language : support ?? [];
    cache.set(name, extension);
  }
  return extension;
}

// Stable display names also serve as the keys for manual language selection.
const extensions: Record<string, string> = {
  txt: 'Plain Text', text: 'Plain Text', log: 'Plain Text', md: 'Markdown', markdown: 'Markdown', mdx: 'Markdown',
  json: 'JSON', jsonc: 'JSONC', jsonl: 'JSON', xml: 'XML', svg: 'XML', xsl: 'XML', plist: 'XML',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'INI', conf: 'INI', properties: 'INI',
  csv: 'CSV', tsv: 'TSV', html: 'HTML', htm: 'HTML', xhtml: 'HTML', css: 'CSS', scss: 'SCSS',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', mts: 'TypeScript',
  cts: 'TypeScript', tsx: 'TSX', svelte: 'Svelte', py: 'Python', pyw: 'Python', pyi: 'Python', rs: 'Rust',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', hxx: 'C++', cs: 'C#',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', go: 'Go', php: 'PHP', phtml: 'PHP', rb: 'Ruby',
  swift: 'Swift', sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ksh: 'Shell',
  ps1: 'PowerShell', psm1: 'PowerShell', psd1: 'PowerShell', lua: 'Lua', dart: 'Dart', r: 'R',
  dockerfile: 'Dockerfile', mk: 'Makefile', mak: 'Makefile', gitconfig: 'Git Config',
};
export const languageNames = [...new Set(Object.values(extensions))];

const filenames: Record<string, string> = {
  dockerfile: 'Dockerfile', containerfile: 'Dockerfile', makefile: 'Makefile', gnumakefile: 'Makefile',
  gemfile: 'Ruby', rakefile: 'Ruby', '.gitconfig': 'Git Config', '.gitmodules': 'Git Config',
  '.gitattributes': 'Plain Text', '.gitignore': 'Plain Text', '.dockerignore': 'Plain Text',
  '.bashrc': 'Shell', '.bash_profile': 'Shell', '.zshrc': 'Shell', '.profile': 'Shell', '.editorconfig': 'INI',
  'cmakelists.txt': 'Plain Text', '.npmrc': 'INI', '.env': 'INI', 'tsconfig.json': 'JSONC', 'jsconfig.json': 'JSONC',
};

export function filenameLanguage(path?: string | null): string | undefined {
  if (!path) return;
  const normal = path.replace(/\\/g, '/').toLowerCase();
  if (normal.endsWith('/.git/config')) return 'Git Config';
  const name = normal.split('/').pop()!;
  if (/^(dockerfile|containerfile)\./.test(name)) return 'Dockerfile';
  if (name.startsWith('.env.')) return 'INI';
  if (Object.hasOwn(filenames, name)) return filenames[name];
  const ext = name.split('.');
  return ext.length > 1 && Object.hasOwn(extensions, ext.at(-1)!) ? extensions[ext.at(-1)!] : undefined;
}

// Strong signatures can identify a small, unsaved buffer. Weaker clues must agree.
type Clue = readonly [language: string, weight: number, pattern: RegExp];
const clues: Clue[] = [
  ['Svelte', 9, /(?:\{[#:/](?:if|each|await|snippet)\b|<svelte:[\w-]+|\$(?:state|derived|props)\s*\()/m],
  ['HTML', 8, /<!doctype\s+html|<html(?:\s|>)/i], ['HTML', 6, /<(div|section|main|body|p|span)\b[^>]*>[\s\S]*<\/\1>/i],
  ['XML', 9, /^\s*<\?xml\s/], ['XML', 5, /^\s*<[\w:-]+[^>]*>[\s\S]*<\/[\w:-]+>\s*$/],
  ['PHP', 9, /<\?php\b/], ['Python', 8, /^\s*(?:async\s+)?def\s+\w+\([^\n]*\)(?:\s*->[^:\n]+)?:/m],
  ['Python', 6, /^\s*(?:class\s+\w+(?:\([^\n]*\))?\s*:|from\s+[.\w]+\s+import\s+\w+)/m],
  ['Python', 3, /^\s*(?:import\s+\w+\s*$|if\s+__name__\s*==|print\s*\()/m], ['Python', 3, /^\s*(?:for\s+\w+\s+in\b.*:|(?:elif|if|while)\s+.+:)\s*$/m],
  ['Python', 6, /^\s*print\s*\(\s*["'][^\n]*["']\s*\)\s*$/m],
  ['Rust', 8, /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*[(<]|\b(?:println|vec)!\s*[(\[]/],
  ['Go', 6, /^\s*package\s+\w+\s*$/m], ['Go', 7, /^\s*func\s+(?:\([^)]+\)\s*)?\w+\(/m],
  ['Java', 7, /\bpublic\s+(?:(?:static|final)\s+)*(?:class\s+\w+|void\s+main\s*\()/], ['Java', 5, /^\s*import\s+java\./m],
  ['C#', 8, /\b(?:using\s+System\b|Console\.Write(?:Line)?\s*\(|namespace\s+\w+[\s.;{])/],
  ['C++', 9, /(?:#\s*include\s*<(?:iostream|vector|string|memory)>|\bstd::\w+|using\s+namespace\s+std)/],
  ['C', 6, /^\s*#\s*include\s*[<"][\w/.]+\.h[>"]/m], ['C', 4, /\bint\s+main\s*\(/],
  ['Kotlin', 7, /\bfun\s+\w+\s*\(|\bdata\s+class\s+\w+/], ['Swift', 7, /\b(?:import\s+(?:Foundation|SwiftUI)|func\s+\w+\([^)]*:\s*\w+)/],
  ['PowerShell', 7, /\b(?:Get|Set|Write|New|Invoke)-(?:[A-Z][a-z]+)+\b|\$ErrorActionPreference\b/],
  ['TypeScript', 8, /\b(?:interface\s+\w+\s*(?:extends\b[^\n{]*|)\{|type\s+\w+(?:<[^>]*>)?\s*=|(?:const|let|var)\s+\w+\s*:\s*\w+)/],
  ['TypeScript', 7, /function\s+\w+\([^)]*:\s*(?:string|number|boolean)\b/],
  ['JavaScript', 6, /(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+\w+\s*=|\bconsole\.log\s*\(|\bfunction\s+\w+\s*\([^)]*\)\s*\{/],
  ['JSX', 8, /\breturn\s*\(?\s*<[A-Za-z][\w.]*(?:\s|\/?>)/],
  ['SQL', 8, /\b(?:SELECT\b[\s\S]{1,260}?\bFROM\s+[\w"`]|CREATE\s+TABLE\b|INSERT\s+INTO\b)/i],
  ['Ruby', 6, /^\s*(?:require(?:_relative)?\s+['"]|def\s+\w+[!?]?(?:\s*\([^\n]*\))?\s*$)/m],
  ['Shell', 6, /^\s*(?:export\s+\w+=|(?:if\s+\[.+\];?\s*then|for\s+\w+.+;\s*do)|set\s+-[a-z]*e[a-z]*)/m],
  ['Dockerfile', 8, /^\s*FROM\s+[\w./:-]+(?:\s+AS\s+\w+)?\s*$/m],
  ['Makefile', 7, /^[\w./% -]+:[^=\n]*\n\t\S/m],
  ['Lua', 7, /^\s*local\s+(?:function\s+\w+\(|\w+\s*=)|\bfunction\s+\w+\([^)]*\)\s*\n[\s\S]*\bend\b/m],
  ['Dart', 8, /import\s+['"](?:dart|package):|\bvoid\s+main\(\)\s*\{\s*print\(/],
  ['R', 6, /\b\w+\s*<-\s*(?:function\s*\(|(?:c|data\.frame|read\.csv)\s*\()/],
  ['SCSS', 8, /\$[\w-]+\s*:\s*[^\n;]+;|@(?:mixin|include)\s+\w+/],
  ['CSS', 6, /(?:^|\n)\s*[.#]?[-\w][^{}\n]{0,100}\s*\{\s*[-\w]+\s*:\s*[^{};]+[;}]/],
  ['Markdown', 6, /^#{1,6}\s+\S/m], ['Markdown', 6, /^```[\w-]*\s*\n/m],
  ['TOML', 7, /^\s*\[\[[\w.-]+\]\]/m], ['TOML', 7, /^\[(?:package|dependencies|project|tool\.[^\]]+)\]\s*$/m],
  ['INI', 6, /^\s*\[[\w .-]+\]\s*\n\s*[\w.-]+\s*=/m],
  ['YAML', 6, /^(?:---\s*\n|\s*[\w.-]+:\s+\S[^\n]*\n\s*[\w.-]+:\s)/m],
  ['YAML', 6, /^\s*[\w.-]+:\s*\n\s+(?:[\w.-]+:|-\s+)/m],
];

export function detectLanguage(sample: string, file?: string | null, previous = 'Plain Text'): string {
  const byName = filenameLanguage(file);
  if (byName) return byName;
  const source = sample.slice(0, 12288);
  const first = source.split('\n', 1)[0];
  if (first.startsWith('#!')) {
    const interpreters: [RegExp, string][] = [[/\bpython[\d.]*\b/, 'Python'], [/\b(?:ba|da|z|k)?sh\b/, 'Shell'],
      [/\b(?:node|nodejs|deno|bun)\b/, 'JavaScript'], [/\bruby\b/, 'Ruby'], [/\bpwsh\b/, 'PowerShell'],
      [/\blua[\d.]*\b/, 'Lua'], [/\bRscript\b/, 'R'], [/\bphp\b/, 'PHP']];
    for (const [pattern, name] of interpreters) if (pattern.test(first)) return name;
  }
  if (/^\s*[[{]/.test(source)) {
    try {
      const value = JSON.parse(source);
      if (value && typeof value === 'object' && Object.keys(value).length > 0) return 'JSON';
    } catch { /* Continue with incomplete or commented JSON. */ }
    if (/^\s*\{\s*"[^"\n]+"\s*:/.test(source)) return /^\s*\/[/\*]/m.test(source) ? 'JSONC' : 'JSON';
  }
  const scores = new Map<string, number>();
  for (const [name, weight, pattern] of clues) {
    if (pattern.test(source)) scores.set(name, (scores.get(name) ?? 0) + weight);
  }
  if (scores.has('JSX') && scores.has('TypeScript')) return 'TSX';
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (!best || best[1] < 6 || (ranked[1] && ranked[1][1] === best[1])) return previous;
  if (best[0] !== previous && scores.has(previous) && best[1] < scores.get(previous)! + 2) return previous;
  return best[0];
}

export type Indentation = { width?: number; tabs: boolean };

export function inferIndentation(sample: string): Indentation | null {
  let tabs = 0, spaces = 0, previous = 0;
  const widths = new Map<number, number>();
  for (const line of sample.slice(0, 24576).split('\n').slice(0, 320)) {
    if (!line.trim()) continue;
    const prefix = /^[\t ]*/.exec(line)![0];
    if (prefix.startsWith('\t')) tabs++;
    else if (prefix) {
      spaces++;
      const step = prefix.length - previous;
      if (step > 0 && step <= 8) widths.set(step, (widths.get(step) ?? 0) + 1);
    }
    previous = prefix.length;
  }
  if (tabs > spaces) return { tabs: true };
  const width = [...widths].sort((a,b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  return spaces && width ? { width, tabs: false } : null;
}

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

const js = 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield';
const c = 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while';
const words: Record<string, string> = {
  JavaScript: js, JSX: js, TypeScript: js + ' abstract any boolean declare implements interface keyof namespace never number private protected public readonly string type unknown',
  Python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass print raise return self True try while with yield',
  Rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while println',
  C: c, 'C++': c + ' bool catch class constexpr delete explicit false namespace new nullptr private protected public std template this throw true try using virtual',
  'C#': 'abstract async await base bool break case catch class const continue decimal delegate else enum event false foreach if int interface internal namespace new null override private protected public return static string struct switch this throw true using var void while',
  Java: 'abstract boolean break byte case catch char class continue default double else enum extends false final finally float for if implements import instanceOf int interface long new null package private protected public return static String super switch this throw throws true try void while',
  Kotlin: 'as break by class companion continue data do else false for fun if import in interface is null object package return suspend this true val var when while',
  Go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map nil package range return select struct switch type var',
  Swift: 'as async await case catch class defer do else enum extension false for func guard if import in init let nil private protocol public return self static struct switch throw true var while',
  Ruby: 'alias and begin break case class def do else elsif end ensure false for if in module next nil not or puts raise require rescue return self true unless until when while yield',
  PHP: 'abstract array as break case catch class continue echo else elseif extends false final foreach function if implements include interface namespace new null private protected public require return static switch throw true try use while',
  SQL: 'ALTER AND AS ASC BEGIN BETWEEN BY CASE CREATE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXISTS FALSE FROM GROUP HAVING IN INDEX INNER INSERT INTO IS JOIN LEFT LIKE LIMIT NOT NULL ON OR ORDER RIGHT SELECT SET TABLE THEN TRUE UNION UNIQUE UPDATE VALUES WHEN WHERE WITH',
  Shell: 'break case continue do done elif else esac exit export fi for function if in local printf read return set then until while',
  PowerShell: 'begin break catch class continue do else elseif end false filter finally foreach function if param process return switch throw true try until while Write-Output Get-Content Set-Content',
  Lua: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while',
  R: 'break else FALSE for function if in Inf NA NaN next NULL repeat return TRUE while',
  Dart: 'abstract as async await break case catch class const continue default dynamic else enum extends false final for if implements import int late new null override return static String super switch this true var void while',
  CSS: 'align-items background border bottom color display flex flex-direction font-family font-size font-weight gap grid height justify-content left line-height margin max-width opacity overflow padding position right text-align top transform width',
  HTML: 'article aside body button div footer form h1 h2 head header html input label li link main meta nav ol p script section span style table title ul',
  Dockerfile: 'ADD ARG CMD COPY ENTRYPOINT ENV EXPOSE FROM HEALTHCHECK LABEL ONBUILD RUN SHELL USER VOLUME WORKDIR',
  Makefile: 'define else endef endif export ifdef ifeq ifndef ifneq include override private undefine unexport vpath',
  JSON: 'true false null', YAML: 'true false null', TOML: 'true false',
};
const aliases: Record<string, string> = { TSX: 'TypeScript', JSONC: 'JSON', SCSS: 'CSS', Svelte: 'HTML' };
const ident = /[$\p{L}_][$\p{L}\p{N}_]*/gu;
const definition = /\b(class|struct|enum|interface|type|def|fn|func|function|fun|const|let|var|val|local)\s+([$\p{L}_][$\p{L}\p{N}_]*)/gu;
const functionKinds = new Set(['def','fn','func','function','fun']);
const typeKinds = new Set(['class','struct','enum','interface','type']);

export function localCompletions(language: string) {
  const keywords: Completion[] = (words[aliases[language] ?? language] ?? '').split(' ').filter(Boolean)
    .map(label => ({label, type:'keyword'}));
  return (context: CompletionContext): CompletionResult | null => {
    const prefix = context.matchBefore(/[$\p{L}_][$\p{L}\p{N}_]*$/u);
    if (!context.explicit && (!prefix || prefix.text.length < 2)) return null;
    const from = prefix?.from ?? context.pos;
    const labels = new Map(keywords.map(entry => [entry.label, entry]));
    // Bound both work and menu size, including when a single logical line is very long.
    const start = Math.max(0, context.pos - 24000);
    const sample = context.state.sliceDoc(start, Math.min(context.state.doc.length, context.pos + 16000));
    for (const match of sample.matchAll(definition)) {
      const [, kind, label] = match;
      labels.set(label, {label, type: typeKinds.has(kind) ? 'class' : functionKinds.has(kind) ? 'function' : 'variable', boost: 3});
    }
    for (const match of sample.matchAll(ident)) {
      const label = match[0];
      if (label.length < 2 || label.length > 100 || start + match.index === from || labels.has(label)) continue;
      labels.set(label, {label, type:'text'});
      if (labels.size > 500) break;
    }
    const options = [...labels.values()].filter(entry => entry.label !== prefix?.text);
    return options.length ? {from, options, validFor: /^[$\p{L}\p{N}_]*$/u} : null;
  };
}
